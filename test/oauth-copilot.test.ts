import { SELF, createExecutionContext, env, runInDurableObject, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import app from "../src/index";
import { hub } from "../src/hub-client";
import type { Hub } from "../src/hub";
import { getProvider } from "../src/oauth";
import type { Account } from "../src/types";

const A = { authorization: "Bearer test-admin", "content-type": "application/json" };
const EXCHANGE = "https://api.github.com/copilot_internal/v2/token";
const urlOf = (i: unknown) => String(i instanceof Request ? i.url : i);
const later = (sec: number) => Math.floor(Date.now() / 1000) + sec;

// Routes mocked fetch by URL; anything unrouted is a 404 (e.g. the price-refresh alarm).
const route = (routes: Record<string, (init?: RequestInit) => Response | Promise<Response>>) =>
  vi.spyOn(globalThis, "fetch").mockImplementation(async (i, init) => {
    const u = urlOf(i);
    const k = Object.keys(routes).find((p) => u.startsWith(p));
    return k ? routes[k](init) : new Response("nope", { status: 404 });
  });
const calls = (f: { mock: { calls: unknown[][] } }, prefix: string) => f.mock.calls.filter((c) => urlOf(c[0]).startsWith(prefix));

afterEach(() => vi.restoreAllMocks());

const copilot = getProvider("copilot-oauth")!;

describe("copilot provider", () => {
  it("start returns user code and verify url", async () => {
    const f = route({
      "https://github.com/login/device/code": () =>
        Response.json({ device_code: "dc1", user_code: "WDJB-MJHT", verification_uri: "https://github.com/login/device", expires_in: 900, interval: 5 }),
    });
    const s = await copilot.start();
    expect(s).toMatchObject({ mode: "device", userCode: "WDJB-MJHT", verifyUrl: "https://github.com/login/device" });
    const [, init] = calls(f, "https://github.com/login/device/code")[0] as [unknown, RequestInit];
    expect(init.method).toBe("POST");
    expect(new Headers(init.headers).get("accept")).toBe("application/json");
    expect(String(init.body)).toContain("client_id=Iv1.b507a08c87ecfe98");
  });

  it("complete returns pending through authorization_pending then tokens", async () => {
    let polls = 0;
    const f = route({
      "https://github.com/login/oauth/access_token": () =>
        ++polls < 3 ? Response.json({ error: "authorization_pending" }) : Response.json({ access_token: "gho_long", token_type: "bearer" }),
      [EXCHANGE]: () => Response.json({ token: "cop_short", expires_at: later(1800), refresh_in: 1500 }),
    });
    expect(await copilot.complete({ deviceCode: "dc1" }, "")).toBe("pending");
    expect(await copilot.complete({ deviceCode: "dc1" }, "")).toBe("pending");
    const t = await copilot.complete({ deviceCode: "dc1" }, "");
    expect(t).toMatchObject({ accessToken: "cop_short", refreshToken: "gho_long" });
    expect((t as any).expiresAt).toBeGreaterThan(Date.now());
    const [, init] = calls(f, EXCHANGE)[0] as [unknown, RequestInit];
    expect(new Headers(init.headers).get("authorization")).toBe("token gho_long");
  });

  it("complete throws on access_denied / expired_token", async () => {
    for (const error of ["access_denied", "expired_token"]) {
      route({ "https://github.com/login/oauth/access_token": () => Response.json({ error }) });
      await expect(copilot.complete({ deviceCode: "dc1" }, "")).rejects.toThrow(error);
      vi.restoreAllMocks();
    }
  });
});

describe("Hub.getFreshToken", () => {
  const setup = async (expiresAt: number) => {
    const h = env.HUB.get(env.HUB.idFromName("oauth-" + crypto.randomUUID()));
    const a = await h.upsertAccount({
      kind: "copilot-oauth",
      name: "cp",
      authType: "oauth",
      secret: { accessToken: "cop_old", refreshToken: "gho_long", expiresAt },
    });
    return { h, a };
  };

  it("getFreshToken refreshes an expired Copilot token once when called concurrently three times", async () => {
    const { h, a } = await setup(Date.now() - 1000);
    const f = route({ [EXCHANGE]: async () => Response.json({ token: "cop_new", expires_at: later(1800) }) });
    const got = await Promise.all([h.getFreshToken(a.id), h.getFreshToken(a.id), h.getFreshToken(a.id)]);
    expect(calls(f, EXCHANGE)).toHaveLength(1);
    expect(got.map((t) => t.accessToken)).toEqual(["cop_new", "cop_new", "cop_new"]);
    expect(got[0].refreshToken).toBe("gho_long");
  });

  it("getFreshToken persists rotated tokens before returning", async () => {
    const { h, a } = await setup(Date.now() - 1000);
    route({ [EXCHANGE]: () => Response.json({ token: "cop_new", expires_at: later(1800) }) });
    const stored = await runInDurableObject(h, (inst: Hub, state) =>
      inst.getFreshToken(a.id).then(() => {
        const r = state.storage.sql.exec<{ data: string }>("SELECT data FROM accounts WHERE id = ?", a.id).one();
        return (JSON.parse(r.data) as Account).secret;
      }),
    );
    expect(stored).toMatchObject({ accessToken: "cop_new", refreshToken: "gho_long" });
  });

  it("refresh failure leaves the old tokens intact", async () => {
    const { h, a } = await setup(Date.now() - 1000);
    route({ [EXCHANGE]: () => new Response("bad credentials", { status: 401 }) });
    const e = await h.getFreshToken(a.id).then(() => null, (x: Error) => x);
    expect(e?.message).toMatch(/refresh failed/);
    expect(e?.message).not.toContain("gho_long");
    expect((await h.getAccount(a.id))?.secret).toEqual({ accessToken: "cop_old", refreshToken: "gho_long", expiresAt: expect.any(Number) });
  });

  it("an admin overwrite during an in-flight refresh is not clobbered", async () => {
    const { h, a } = await setup(Date.now() - 1000);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const f = route({
      [EXCHANGE]: async () => {
        await gate;
        return Response.json({ token: "cop_new", expires_at: later(1800) });
      },
    });
    const p = h.getFreshToken(a.id);
    while (!calls(f, EXCHANGE).length) await new Promise((r) => setTimeout(r, 5));
    const admin = { accessToken: "cop_admin", refreshToken: "gho_admin", expiresAt: Date.now() + 1e6 };
    await h.upsertAccount({ ...a, secret: admin });
    release();
    expect(await p).toEqual(admin);
    expect((await h.getAccount(a.id))?.secret).toEqual(admin);
  });

  it("a failed refresh sets a cooldown that reserve honours until it expires", async () => {
    for (const [status, ms] of [[401, 15 * 60_000], [400, 15 * 60_000], [503, 60_000]] as const) {
      const { h, a } = await setup(Date.now() - 1000);
      route({ [EXCHANGE]: () => new Response("nope", { status }) });
      const t0 = Date.now();
      expect(await h.getFreshToken(a.id).then(() => "", (e: Error) => e.message)).toMatch(/refresh failed/);
      const r = (now: number) => h.reserve({ keyId: "k", accountId: a.id, model: "gpt-4o", estTokens: 1, now });
      expect(await r(t0 + ms - 5_000)).toEqual({ ok: false, reason: "cooldown" });
      expect((await r(t0 + ms + 5_000)).ok).toBe(true);
      vi.restoreAllMocks();
      route({ [EXCHANGE]: () => Response.json({ token: "cop_new", expires_at: later(1800) }) });
      expect((await h.getFreshToken(a.id)).accessToken).toBe("cop_new");
      vi.restoreAllMocks();
    }
  });

  it("a network error during refresh sets a 60s cooldown", async () => {
    const { h, a } = await setup(Date.now() - 1000);
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new TypeError("network down"));
    const t0 = Date.now();
    expect(await h.getFreshToken(a.id).then(() => "", (e: Error) => e.message)).toMatch(/refresh failed/);
    const r = (now: number) => h.reserve({ keyId: "k", accountId: a.id, model: "gpt-4o", estTokens: 1, now });
    expect(await r(t0 + 55_000)).toEqual({ ok: false, reason: "cooldown" });
    expect((await r(t0 + 65_000)).ok).toBe(true);
  });

  it("getAuthHeaders returns headers and no token fields", async () => {
    const { h, a } = await setup(Date.now() + 1e6);
    const hd = await h.getAuthHeaders(a.id);
    expect(hd.Authorization).toBe("Bearer cop_old");
    expect(hd["Copilot-Integration-Id"]).toBe("vscode-chat");
    const s = JSON.stringify(hd);
    expect(s).not.toContain("gho_long");
    for (const k of ["accessToken", "refreshToken", "expiresAt"]) expect(hd).not.toHaveProperty(k);
  });

  it("token fresh within skew is returned without any fetch", async () => {
    const { h, a } = await setup(Date.now() + 120_000);
    const f = route({});
    expect((await h.getFreshToken(a.id)).accessToken).toBe("cop_old");
    expect(calls(f, EXCHANGE)).toHaveLength(0);
    const near = await setup(Date.now() + 30_000); // inside the 60s skew: refreshes
    route({ [EXCHANGE]: () => Response.json({ token: "cop_new", expires_at: later(1800) }) });
    expect((await near.h.getFreshToken(near.a.id)).accessToken).toBe("cop_new");
  });
});

describe("admin oauth routes", () => {
  const post = (path: string, body: unknown, headers: Record<string, string> = A) =>
    SELF.fetch("http://x/admin/oauth" + path, { method: "POST", headers, body: JSON.stringify(body) });

  it("start/complete require the admin token", async () => {
    const f = route({});
    expect((await post("/copilot-oauth/start", {}, { authorization: "Bearer nope" })).status).toBe(401);
    expect((await post("/copilot-oauth/complete", { state: {} }, {})).status).toBe(401);
    expect(f).not.toHaveBeenCalled();
    expect((await post("/openrouter/start", {})).status).toBe(404);
    expect((await post("/codex-oauth/start", {})).status).toBe(404);
  });

  it("complete creates a redacted account", async () => {
    let polls = 0;
    route({
      "https://github.com/login/device/code": () =>
        Response.json({ device_code: "dc9", user_code: "ABCD-EFGH", verification_uri: "https://github.com/login/device", interval: 5 }),
      "https://github.com/login/oauth/access_token": () =>
        ++polls < 2 ? Response.json({ error: "authorization_pending" }) : Response.json({ access_token: "gho_secret9" }),
      [EXCHANGE]: () => Response.json({ token: "cop_secret9", expires_at: later(1800) }),
    });
    const start = (await (await post("/copilot-oauth/start", {})).json()) as any;
    expect(start.userCode).toBe("ABCD-EFGH");
    const pending = await post("/copilot-oauth/complete", { state: start.state, name: "cp-admin" });
    expect(pending.status).toBe(202);
    expect(await pending.json()).toEqual({ status: "pending" });
    const done = await post("/copilot-oauth/complete", { state: start.state, name: "cp-admin" });
    expect(done.status).toBe(200);
    const text = await done.text();
    expect(text).not.toContain("secret9");
    expect(JSON.parse(text)).toMatchObject({ kind: "copilot-oauth", name: "cp-admin", authType: "oauth", secret: "***", enabled: true });
  });

  it("complete maps provider errors to 400 without tokens", async () => {
    route({ "https://github.com/login/oauth/access_token": () => Response.json({ error: "access_denied" }) });
    const r = await post("/copilot-oauth/complete", { state: { deviceCode: "dc" }, name: "x" });
    expect(r.status).toBe(400);
    expect(((await r.json()) as any).error.message).toContain("access_denied");
  });

  it("GET /admin/accounts never contains the token", async () => {
    await hub(env).upsertAccount({
      kind: "copilot-oauth",
      name: "cp-list",
      authType: "oauth",
      secret: { accessToken: "cop_listsecret", refreshToken: "gho_listsecret", expiresAt: Date.now() + 1e6 },
    });
    const text = await (await SELF.fetch("http://x/admin/accounts", { headers: A })).text();
    expect(text).toContain("cp-list");
    expect(text).not.toContain("listsecret");
  });
});

describe("proxy with copilot", () => {
  const call = async (key: string, model: string) => {
    const ctx = createExecutionContext();
    const res = await app.fetch(
      new Request("http://x/v1/chat/completions", {
        method: "POST",
        headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
        body: JSON.stringify({ model, messages: [{ role: "user", content: "hi" }] }),
      }),
      env,
      ctx,
    );
    await waitOnExecutionContext(ctx);
    return res;
  };
  const ok = () => Response.json({ id: "1", choices: [{ message: { role: "assistant", content: "yo" } }], usage: { prompt_tokens: 1, completion_tokens: 1 } });

  it("a fresh copilot target is called with copilot headers", async () => {
    const h = hub(env);
    await h.upsertAccount({
      kind: "copilot-oauth",
      name: "cp-ok",
      authType: "oauth",
      secret: { accessToken: "cop_fresh", refreshToken: "gho_x", expiresAt: Date.now() + 1e6 },
    });
    const { secret } = await h.createKey({ name: "cp-ok" });
    const f = route({ "https://api.githubcopilot.com/chat/completions": ok });
    expect((await call(secret, "cp-ok/gpt-4o")).status).toBe(200);
    const [, init] = calls(f, "https://api.githubcopilot.com/chat/completions")[0] as [unknown, RequestInit];
    const hd = new Headers(init.headers);
    expect(hd.get("authorization")).toBe("Bearer cop_fresh");
    expect(hd.get("copilot-integration-id")).toBe("vscode-chat");
    expect(hd.get("editor-version")).toBeTruthy();
  });

  it("a copilot target whose token refresh fails falls through to the next target", async () => {
    const h = hub(env);
    const cp = await h.upsertAccount({
      kind: "copilot-oauth",
      name: "cp-dead",
      authType: "oauth",
      secret: { accessToken: "cop_old", refreshToken: "gho_dead", expiresAt: Date.now() - 1000 },
    });
    const backup = await h.upsertAccount({ kind: "custom-openai", name: "cp-backup", authType: "apikey", secret: "s", baseUrl: "https://backup.example/v1" });
    await h.upsertCombo({ name: "cp-combo", targets: [{ accountId: cp.id, model: "gpt-4o" }, { accountId: backup.id, model: "m" }] });
    const { secret } = await h.createKey({ name: "cp-fall" });
    const f = route({ [EXCHANGE]: () => new Response("revoked", { status: 401 }), "https://backup.example/v1/chat/completions": ok });
    const res = await call(secret, "cp-combo");
    expect(res.status).toBe(200);
    expect(calls(f, EXCHANGE)).toHaveLength(1);
    expect(calls(f, "https://api.githubcopilot.com")).toHaveLength(0);
    expect(calls(f, "https://backup.example")).toHaveLength(1);
  });
});
