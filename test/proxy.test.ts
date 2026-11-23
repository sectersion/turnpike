import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import app from "../src/index";
import { hub } from "../src/hub-client";
import { recordUsage } from "../src/usage";
import { callUpstream } from "../src/providers";
import type { Account } from "../src/types";

vi.mock("../src/usage", () => ({ recordUsage: vi.fn(async () => {}) }));

const enc = new TextEncoder();
const sse = (...lines: string[]) => lines.map((l) => `data: ${l}\n\n`).join("");
const oaiStream = sse(
  JSON.stringify({ id: "1", model: "m", choices: [{ index: 0, delta: { role: "assistant", content: "hi" } }] }),
  JSON.stringify({ id: "1", model: "m", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }),
  JSON.stringify({ id: "1", model: "m", choices: [], usage: { prompt_tokens: 3, completion_tokens: 2 } }),
  "[DONE]",
);

let secret = "";
let keyId = "";
let accId = "";
beforeAll(async () => {
  const h = hub(env);
  const k = await h.createKey({ name: "t" });
  secret = k.secret;
  keyId = k.key.id;
  accId = (await h.upsertAccount({ kind: "custom-openai", name: "up", authType: "apikey", secret: "sk-up", baseUrl: "https://up.example/v1" })).id;
  await h.upsertCombo({ name: "mine", targets: [{ accountId: accId, model: "m" }] });
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.mocked(recordUsage).mockClear();
});

const call = async (path: string, body: unknown, key = secret) => {
  const ctx = createExecutionContext();
  const res = await app.fetch(
    new Request("http://x" + path, { method: "POST", headers: { authorization: `Bearer ${key}`, "content-type": "application/json" }, body: typeof body === "string" ? body : JSON.stringify(body) }),
    env,
    ctx,
  );
  return { res, done: () => waitOnExecutionContext(ctx) };
};
const upstream = (r: () => Response) => vi.spyOn(globalThis, "fetch").mockImplementation(async () => r());
const streamRes = (text: string) =>
  new Response(new ReadableStream({ start(c) { c.enqueue(enc.encode(text)); c.close(); } }), { status: 200, headers: { "content-type": "text/event-stream" } });

describe("proxy", () => {
  it("non-streaming openai request round-trips", async () => {
    upstream(() => Response.json({ id: "1", choices: [{ message: { role: "assistant", content: "yo" } }], usage: { prompt_tokens: 4, completion_tokens: 5 } }));
    const { res, done } = await call("/v1/chat/completions", { model: "up/m", messages: [] });
    expect(res.status).toBe(200);
    expect(((await res.json()) as any).choices[0].message.content).toBe("yo");
    await done();
    expect(recordUsage).toHaveBeenCalledWith(expect.anything(), { keyId, accountId: accId, model: "m", usage: { inputTokens: 4, outputTokens: 5 } });
  });

  it("streaming anthropic request against openai upstream yields valid anthropic SSE", async () => {
    upstream(() => streamRes(oaiStream));
    const { res, done } = await call("/v1/messages", { model: "mine", stream: true, max_tokens: 5, messages: [{ role: "user", content: "x" }] });
    const text = await res.text();
    expect(text).toContain("event: message_start");
    expect(text).toContain("event: message_stop");
    await done();
    expect(recordUsage).toHaveBeenCalledTimes(1);
  });

  it("client abort mid-stream still triggers usage recording", async () => {
    upstream(
      () =>
        new Response(new ReadableStream({ start(c) { c.enqueue(enc.encode(oaiStream.slice(0, 80))); } }), { status: 200 }), // never closes
    );
    const { res, done } = await call("/v1/chat/completions", { model: "mine", stream: true, messages: [] });
    const r = res.body!.getReader();
    await r.read();
    await r.cancel();
    await done();
    expect(recordUsage).toHaveBeenCalledTimes(1);
    expect(vi.mocked(recordUsage).mock.calls[0][1]).toMatchObject({ accountId: accId, usage: null });
  });

  it("errors: 400 bad json, 404 unknown, 403 not allowed, anthropic style", async () => {
    expect((await call("/v1/chat/completions", "{nope")).res.status).toBe(400);
    expect((await call("/v1/chat/completions", { model: "zzz/x" })).res.status).toBe(404);
    const k = await hub(env).createKey({ name: "lim", allowedAccountIds: [] });
    expect((await call("/v1/chat/completions", { model: "mine" }, k.secret)).res.status).toBe(403);
    const a = (await (await call("/v1/messages", { model: "zzz/x" })).res.json()) as any;
    expect(a).toMatchObject({ type: "error", error: { type: "not_found_error" } });
  });

  it("non-2xx upstream is returned without recording", async () => {
    upstream(() => Response.json({ error: "bad" }, { status: 400 }));
    const { res, done } = await call("/v1/chat/completions", { model: "mine", messages: [] });
    expect(res.status).toBe(400);
    await done();
    expect(recordUsage).not.toHaveBeenCalled();
  });

  it("GET /v1/models lists combos the key may use", async () => {
    const ctx = createExecutionContext();
    const h = (s: string) => ({ headers: { authorization: `Bearer ${s}` } });
    const ok = (await (await app.fetch(new Request("http://x/v1/models", h(secret)), env, ctx)).json()) as any;
    expect(ok.data).toContainEqual({ id: "mine", object: "model", owned_by: "turnpike" });
    const k = await hub(env).createKey({ name: "none", allowedAccountIds: [] });
    const none = (await (await app.fetch(new Request("http://x/v1/models", h(k.secret)), env, ctx)).json()) as any;
    expect(none.data).toEqual([]);
  });
});

describe("callUpstream", () => {
  const acc = (kind: Account["kind"], secret: Account["secret"]): Account => ({ id: "z", kind, name: "z", authType: "apikey", secret, enabled: true, baseUrl: "https://z.example" });
  const spy = () => {
    const f = vi.fn(async (_u: any, _i: any) => new Response("{}"));
    return f;
  };
  it("sets stream_options.include_usage for openai-native streams without mutating input", async () => {
    const f = spy();
    const body = { stream: true, stream_options: { foo: 1 }, messages: [] };
    await callUpstream({ account: acc("custom-openai", "k"), model: "m" }, "openai", body, f as any);
    expect(JSON.parse(f.mock.calls[0][1].body).stream_options).toEqual({ foo: 1, include_usage: true });
    expect(body.stream_options).toEqual({ foo: 1 });
  });
  it("keyless custom accounts omit auth headers; others throw", async () => {
    const f = spy();
    await callUpstream({ account: acc("custom-openai", ""), model: "m" }, "openai", {}, f as any);
    expect(f.mock.calls[0][1].headers.Authorization).toBeUndefined();
    await callUpstream({ account: acc("custom-anthropic", ""), model: "m" }, "anthropic", {}, f as any);
    const h = f.mock.calls[1][1].headers;
    expect(h["x-api-key"]).toBeUndefined();
    expect(h["anthropic-version"]).toBe("2023-06-01");
    await expect(callUpstream({ account: acc("openrouter", ""), model: "m" }, "openai", {}, f as any)).rejects.toThrow("account has no api key");
  });
});
