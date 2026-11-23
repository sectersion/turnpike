import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import app from "../src/index";
import { hub } from "../src/hub-client";
import { usageTap } from "../src/translate/stream";

afterEach(() => vi.restoreAllMocks());

async function call(method: string, path: string, secret: string, body?: object) {
  const ctx = createExecutionContext();
  const res = await app.fetch(
    new Request("http://x" + path, { method, headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" }, body: body && JSON.stringify(body) }),
    env,
    ctx,
  );
  await waitOnExecutionContext(ctx);
  return res;
}

describe("M1: not-allowed and unknown models look the same", () => {
  it("404 with the same message for both", async () => {
    const h = hub(env);
    await h.upsertAccount({ kind: "custom-openai", name: "m1acc", authType: "apikey", secret: "s", baseUrl: "https://m1.example/v1" });
    const { secret } = await h.createKey({ name: "m1", allowedAccountIds: [] });
    const a = await call("POST", "/v1/chat/completions", secret, { model: "m1acc/x", messages: [] });
    const b = await call("POST", "/v1/chat/completions", secret, { model: "zzzm1/x", messages: [] });
    expect([a.status, b.status]).toEqual([404, 404]);
    const [ja, jb] = [(await a.json()) as any, (await b.json()) as any];
    expect(ja.error.message.replace("m1acc", "X")).toBe(jb.error.message.replace("zzzm1", "X"));
  });
});

describe("M2: unsupported endpoints get a JSON 404", () => {
  it("OpenAI-style for /v1/*, Anthropic-style for /v1/messages*", async () => {
    const { secret } = await hub(env).createKey({ name: "m2" });
    for (const p of ["/v1/embeddings", "/v1/completions", "/v1/responses"]) {
      const r = await call("POST", p, secret, {});
      expect(r.status).toBe(404);
      expect(((await r.json()) as any).error).toMatchObject({ type: "not_found_error", message: expect.stringContaining("not supported") });
    }
    const r = await call("POST", "/v1/messages/count_tokens", secret, {});
    expect(r.status).toBe(404);
    expect(await r.json()).toMatchObject({ type: "error", error: { type: "not_found_error" } });
  });
});

describe("M4: an aborted Anthropic stream is charged for the output it streamed", () => {
  it("cancel before message_delta uses max(seen, streamed-text floor)", async () => {
    const ev = (e: string, d: object) => `event: ${e}\ndata: ${JSON.stringify({ type: e, ...d })}\n\n`;
    const partial =
      ev("message_start", { message: { id: "m", usage: { input_tokens: 10, cache_read_input_tokens: 50, output_tokens: 1 } } }) +
      ev("content_block_start", { index: 0, content_block: { type: "text", text: "" } }) +
      ev("content_block_delta", { index: 0, delta: { type: "text_delta", text: "x".repeat(400) } });
    const calls: unknown[] = [];
    const t = usageTap((u) => calls.push(u));
    const w = t.writable.getWriter();
    const r = t.readable.getReader();
    void w.write(new TextEncoder().encode(partial)).catch(() => {});
    await r.read();
    await r.cancel();
    expect(calls).toEqual([{ inputTokens: 10, outputTokens: 100, cacheReadTokens: 50 }]);
  });
});

describe("M8/M9: generic 502, unpriced is a 400", () => {
  it("a network failure gives a generic 502 in the client's format", async () => {
    const h = hub(env);
    await h.upsertAccount({ kind: "custom-anthropic", name: "m8acc", authType: "apikey", secret: "s", baseUrl: "https://m8.example/v1" });
    const { secret } = await h.createKey({ name: "m8" });
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      throw new Error("connect ECONNREFUSED internal-host for account 1234");
    });
    const r = await call("POST", "/v1/messages", secret, { model: "m8acc/x", max_tokens: 5, messages: [] });
    expect(r.status).toBe(502);
    const text = await r.text();
    expect(text).not.toMatch(/internal-host|1234|ECONNREFUSED/);
    expect(JSON.parse(text)).toMatchObject({ type: "error", error: { message: "upstream failed" } });
  });

  it("unpriced on a capped key is a 400 with a clear message, not a retryable 429", async () => {
    const h = hub(env);
    await h.upsertAccount({ kind: "custom-openai", name: "m9acc", authType: "apikey", secret: "s", baseUrl: "https://m9.example/v1" });
    const { secret } = await h.createKey({ name: "m9", monthlyUsd: 5 });
    const r = await call("POST", "/v1/chat/completions", secret, { model: "m9acc/no-price-zz9", messages: [] });
    expect(r.status).toBe(400);
    expect(((await r.json()) as any).error.message).toMatch(/no known price/);
  });
});
