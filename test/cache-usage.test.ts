import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import app from "../src/index";
import { hub } from "../src/hub-client";

// A Claude Code-shaped turn: 5 uncached input, 2k cache write, 100k cache read, 500 output.
// Sonnet-style price $3/M in, $15/M out; cache write 1.25x input, cache read 0.1x input:
// 5*3 + 2000*3.75 + 100000*0.3 + 500*15 = 45015 micro-dollars.
const EXPECTED_USD = 0.045015;
const USAGE = { input_tokens: 5, cache_creation_input_tokens: 2000, cache_read_input_tokens: 100000 };
const BASE = "https://c1anth.example/v1";

const nonStream = () =>
  Response.json({
    id: "msg_1", type: "message", role: "assistant", model: "claude-sonnet-c1",
    content: [{ type: "text", text: "ok" }], stop_reason: "end_turn",
    usage: { ...USAGE, output_tokens: 500 },
  });
const ev = (e: string, d: object) => `event: ${e}\ndata: ${JSON.stringify({ type: e, ...d })}\n\n`;
const stream = () =>
  new Response(
    ev("message_start", { message: { id: "msg_1", type: "message", role: "assistant", model: "claude-sonnet-c1", content: [], usage: { ...USAGE, output_tokens: 1 } } }) +
      ev("content_block_start", { index: 0, content_block: { type: "text", text: "" } }) +
      ev("content_block_delta", { index: 0, delta: { type: "text_delta", text: "ok" } }) +
      ev("content_block_stop", { index: 0 }) +
      ev("message_delta", { delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 500 } }) +
      ev("message_stop", {}),
    { status: 200, headers: { "content-type": "text/event-stream" } },
  );

afterEach(() => vi.restoreAllMocks());

describe("C1: Anthropic prompt-cache tokens are charged", () => {
  for (const path of ["/v1/messages", "/v1/chat/completions"])
    for (const streaming of [false, true])
      it(`${path} ${streaming ? "stream" : "non-stream"}`, async () => {
        const h = hub(env);
        if (!(await h.listAccounts(false)).some((a) => a.name === "c1anth"))
          await h.upsertAccount({ kind: "custom-anthropic", name: "c1anth", authType: "apikey", secret: "sk", baseUrl: BASE });
        await h.setPriceOverride("claude-sonnet-c1", { inPerM: 3, outPerM: 15 });
        const { secret, key } = await h.createKey({ name: "c1", monthlyUsd: 100 });
        vi.spyOn(globalThis, "fetch").mockImplementation(async (u) =>
          String(u).startsWith(BASE) ? (streaming ? stream() : nonStream()) : new Response("nope", { status: 404 }),
        );
        const ctx = createExecutionContext();
        const res = await app.fetch(
          new Request("http://x" + path, {
            method: "POST",
            headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" },
            body: JSON.stringify({ model: "c1anth/claude-sonnet-c1", max_tokens: 1000, stream: streaming, messages: [{ role: "user", content: "hi" }] }),
          }),
          env,
          ctx,
        );
        expect(res.status).toBe(200);
        await res.text();
        await waitOnExecutionContext(ctx);
        const row = (await h.usageSummary(0)).byKey.find((r) => r.id === key.id)!;
        expect(row).toMatchObject({ requests: 1, inTokens: 102005, outTokens: 500 });
        expect(row.costUsd).toBeCloseTo(EXPECTED_USD, 9);
      });
});
