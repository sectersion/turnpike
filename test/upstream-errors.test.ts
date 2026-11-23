import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import app from "../src/index";
import { hub } from "../src/hub-client";
import { copilot } from "../src/oauth/copilot";

afterEach(() => vi.restoreAllMocks());

const MIN = 60_000;
const LEAKY = {
  "content-type": "application/json",
  "openai-organization": "org-secret",
  "anthropic-ratelimit-requests-remaining": "3",
  "set-cookie": "sid=1; Domain=upstream.example",
  "x-request-id": "req_123",
};

// Routes by host; records every upstream call.
const route = (routes: Record<string, () => Response>) => {
  const calls: { url: string; init?: RequestInit }[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (u, init) => {
    const url = String(u instanceof Request ? u.url : u);
    const k = Object.keys(routes).find((h) => url.includes(h));
    if (!k) return new Response("nope", { status: 404 });
    calls.push({ url, init });
    return routes[k]();
  });
  return calls;
};

async function call(path: string, secret: string, body: object) {
  const ctx = createExecutionContext();
  const res = await app.fetch(
    new Request("http://x" + path, { method: "POST", headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" }, body: JSON.stringify(body) }),
    env,
    ctx,
  );
  const text = await res.text();
  await waitOnExecutionContext(ctx);
  return { res, text };
}

async function setup(n = 1) {
  const h = hub(env);
  const tag = crypto.randomUUID().slice(0, 8);
  const accts = [];
  for (let i = 0; i < n; i++)
    accts.push(await h.upsertAccount({ kind: "custom-openai", name: `ue${i}${tag}`, authType: "apikey", secret: "s", baseUrl: `https://ue${i}${tag}.example/v1` }));
  await h.upsertCombo({ name: "ue" + tag, targets: accts.map((a) => ({ accountId: a.id, model: "m" })) });
  const { secret, key } = await h.createKey({ name: "ue" });
  const host = (i: number) => `ue${i}${tag}.example`;
  return { h, accts, combo: "ue" + tag, secret, key, host };
}
const ok = () => Response.json({ id: "1", choices: [{ index: 0, message: { role: "assistant", content: "yo" } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }, { headers: LEAKY });
const msg = { messages: [{ role: "user", content: "hi" }] };

describe("I3: upstream headers and error bodies are filtered", () => {
  it("only allowed headers come back (non-stream and stream)", async () => {
    const s = await setup();
    route({ [s.host(0)]: ok });
    const { res } = await call("/v1/chat/completions", s.secret, { model: s.combo, ...msg });
    expect(res.status).toBe(200);
    expect([...res.headers.keys()].sort()).toEqual(["content-type"]);

    route({ [s.host(0)]: () => new Response("data: [DONE]\n\n", { headers: { ...LEAKY, "content-type": "text/event-stream", "cache-control": "no-cache" } }) });
    const st = await call("/v1/chat/completions", s.secret, { model: s.combo, stream: true, ...msg });
    expect([...st.res.headers.keys()].sort()).toEqual(["cache-control", "content-type"]);
  });

  for (const status of [401, 402, 403])
    it(`an upstream ${status} becomes a generic 502 with no upstream text`, async () => {
      const s = await setup();
      route({ [s.host(0)]: () => Response.json({ error: { message: "Incorrect API key sk-...abcd for org-secret, balance $0" } }, { status, headers: LEAKY }) });
      const { res, text } = await call("/v1/messages", s.secret, { model: s.combo, max_tokens: 5, ...msg });
      expect(res.status).toBe(502);
      expect(text).not.toMatch(/sk-|org-secret|balance/);
      expect(JSON.parse(text)).toMatchObject({ type: "error", error: { message: "upstream account error" } });
      expect(res.headers.get("set-cookie")).toBeNull();
    });

  it("a 5xx keeps its status with a generic message; a 400 keeps its body", async () => {
    const s = await setup();
    route({ [s.host(0)]: () => new Response("stack trace at internal-host:1234", { status: 500 }) });
    const r5 = await call("/v1/chat/completions", s.secret, { model: s.combo, ...msg });
    expect(r5.res.status).toBe(500);
    expect(r5.text).not.toContain("internal-host");
    route({ [s.host(0)]: () => Response.json({ error: { message: "messages: field required" } }, { status: 400, headers: LEAKY }) });
    const r4 = await call("/v1/chat/completions", s.secret, { model: s.combo, ...msg });
    expect(r4.res.status).toBe(400);
    expect(r4.text).toContain("messages: field required");
    expect(r4.res.headers.get("openai-organization")).toBeNull();
  });
});

describe("I4: account-level failures fall through and cool down for 15 minutes", () => {
  for (const status of [401, 402, 403])
    it(`${status} on the first target falls through to the second`, async () => {
      const s = await setup(2);
      const calls = route({ [s.host(0)]: () => new Response("dead", { status }), [s.host(1)]: ok });
      const t0 = Date.now();
      const { res } = await call("/v1/chat/completions", s.secret, { model: s.combo, ...msg });
      expect(res.status).toBe(200);
      expect(calls.map((c) => new URL(c.url).host)).toEqual([s.host(0), s.host(1)]);
      const r = (now: number) => s.h.reserve({ keyId: s.key.id, accountId: s.accts[0].id, model: "m", estTokens: 1, now });
      expect(await r(t0 + 14 * MIN)).toEqual({ ok: false, reason: "cooldown" });
      expect((await r(t0 + 16 * MIN)).ok).toBe(true);
    });
});

describe("I9: redirects are never followed", () => {
  it("every upstream fetch passes redirect: manual", async () => {
    const s = await setup();
    const calls = route({ [s.host(0)]: ok });
    await call("/v1/chat/completions", s.secret, { model: s.combo, ...msg });
    expect(calls[0].init?.redirect).toBe("manual");

    const gh = route({
      "github.com/login/device/code": () => Response.json({ device_code: "d", user_code: "u", verification_uri: "https://github.com/login/device" }),
      "github.com/login/oauth/access_token": () => Response.json({ access_token: "gho" }),
      "api.github.com/copilot_internal": () => Response.json({ token: "t", expires_at: 9e9 }),
    });
    await copilot.start();
    await copilot.complete({ deviceCode: "d" }, "");
    await copilot.refresh({ accessToken: "a", refreshToken: "gho" });
    expect(gh.length).toBe(4);
    for (const c of gh) expect(c.init?.redirect).toBe("manual");
  });

  it("a 3xx is an upstream error: falls through, then 502, and the Location is not fetched", async () => {
    const s = await setup(2);
    const redirect = () => new Response(null, { status: 302, headers: { location: "https://attacker.example/steal" } });
    const calls = route({ [s.host(0)]: redirect, [s.host(1)]: ok, "attacker.example": ok });
    expect((await call("/v1/chat/completions", s.secret, { model: s.combo, ...msg })).res.status).toBe(200);
    const one = await setup(1);
    route({ [one.host(0)]: redirect, "attacker.example": ok });
    const r = await call("/v1/chat/completions", one.secret, { model: one.combo, ...msg });
    expect(r.res.status).toBe(502);
    expect(calls.some((c) => c.url.includes("attacker"))).toBe(false);
  });
});
