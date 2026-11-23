import { describe, expect, it } from "vitest";
import { anthropicSseToOpenaiSse, openaiSseToAnthropicSse, usageTap } from "../src/translate/stream";
import { ANTHROPIC_ERROR, ANTHROPIC_TEXT, ANTHROPIC_TOOL, OPENAI_TEXT, OPENAI_TOOL } from "./fixtures/sse";

const enc = new TextEncoder();
const dec = new TextDecoder();

function split(bytes: Uint8Array, size: number): Uint8Array[] {
  const out: Uint8Array[] = [];
  for (let i = 0; i < bytes.length; i += size) out.push(bytes.slice(i, i + size));
  return out;
}

// Byte-sized chunks also split multi-byte UTF-8 characters.
async function run(t: TransformStream<Uint8Array, Uint8Array>, input: string, size = 7): Promise<string> {
  const w = t.writable.getWriter();
  const writing = (async () => {
    for (const c of split(enc.encode(input), size)) await w.write(c);
    await w.close();
  })();
  let out = "";
  const r = t.readable.getReader();
  for (;;) {
    const { done, value } = await r.read();
    if (done) break;
    out += dec.decode(value, { stream: true });
  }
  await writing;
  return out;
}

const oaiChunks = (s: string) =>
  s.split("\n\n").filter(Boolean).map((e) => e.replace(/^data: /, "")).filter((d) => d !== "[DONE]").map((d) => JSON.parse(d));
const anthEvents = (s: string) =>
  s.split("\n\n").filter(Boolean).map((e) => {
    const [ev, d] = e.split("\n");
    return { event: ev.slice(7), data: JSON.parse(d.slice(6)) };
  });

describe("stream translation", () => {
  it("text deltas translate in both directions", async () => {
    const out = oaiChunks(await run(anthropicSseToOpenaiSse(), ANTHROPIC_TEXT));
    expect(out[0].choices[0].delta).toEqual({ role: "assistant" });
    expect(out.map((c) => c.choices[0]?.delta?.content).filter(Boolean).join("")).toBe("Héllo wörld 🌍");
    expect(out.find((c) => c.choices[0]?.finish_reason)?.choices[0].finish_reason).toBe("stop");
    expect(out.at(-1)).toMatchObject({ choices: [], usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 } });

    const ev = anthEvents(await run(openaiSseToAnthropicSse("m"), OPENAI_TEXT));
    expect(ev.map((e) => e.event)).toEqual([
      "message_start", "content_block_start", "content_block_delta", "content_block_delta",
      "content_block_stop", "message_delta", "message_stop",
    ]);
    expect(ev.filter((e) => e.event === "content_block_delta").map((e) => e.data.delta.text).join("")).toBe("Héllo wörld 🌍");
    expect(ev[0].data.message.model).toBe("m");
    expect(ev[5].data).toMatchObject({ delta: { stop_reason: "end_turn" }, usage: { output_tokens: 7 } });
  });

  it("tool call argument deltas reassemble to the same JSON", async () => {
    const out = oaiChunks(await run(anthropicSseToOpenaiSse(), ANTHROPIC_TOOL));
    const calls = out.flatMap((c) => c.choices[0]?.delta?.tool_calls ?? []);
    expect(calls[0]).toEqual({ index: 0, id: "tu_1", type: "function", function: { name: "get_weather", arguments: "" } });
    expect(JSON.parse(calls.map((c: any) => c.function.arguments).join(""))).toEqual({ city: "Paris" });
    expect(out.find((c) => c.choices[0]?.finish_reason)?.choices[0].finish_reason).toBe("tool_calls");

    const ev = anthEvents(await run(openaiSseToAnthropicSse("m"), OPENAI_TOOL));
    const starts = ev.filter((e) => e.event === "content_block_start");
    expect(starts.map((e) => e.data.content_block.type)).toEqual(["text", "tool_use"]);
    expect(starts[1].data.content_block).toMatchObject({ id: "call_1", name: "get_weather" });
    const json = ev.filter((e) => e.data.delta?.type === "input_json_delta").map((e) => e.data.delta.partial_json).join("");
    expect(JSON.parse(json)).toEqual({ city: "Paris" });
    expect(ev.find((e) => e.event === "message_delta")?.data.delta.stop_reason).toBe("tool_use");
  });

  it("openai stream ends with data: [DONE]", async () => {
    expect((await run(anthropicSseToOpenaiSse(), ANTHROPIC_TEXT)).endsWith("data: [DONE]\n\n")).toBe(true);
    const err = await run(anthropicSseToOpenaiSse(), ANTHROPIC_ERROR);
    expect(err.endsWith("data: [DONE]\n\n")).toBe(true);
    expect(oaiChunks(err).at(-1).error.message).toBe("Overloaded");
  });

  it("chunk boundary inside an event does not corrupt output", async () => {
    const whole = await run(anthropicSseToOpenaiSse(), ANTHROPIC_TEXT, 100000);
    for (const size of [1, 3, 7, 13]) expect(await run(anthropicSseToOpenaiSse(), ANTHROPIC_TEXT, size)).toBe(whole);
    const w2 = await run(openaiSseToAnthropicSse("m"), OPENAI_TEXT, 100000);
    for (const size of [1, 5]) expect(await run(openaiSseToAnthropicSse("m"), OPENAI_TEXT, size)).toBe(w2);
  });

  it("tolerates CRLF framing and a trailing event without blank line", async () => {
    const plain = await run(anthropicSseToOpenaiSse(), ANTHROPIC_TEXT);
    expect(await run(anthropicSseToOpenaiSse(), ANTHROPIC_TEXT.replace(/\n/g, "\r\n"))).toBe(plain);
    expect(await run(anthropicSseToOpenaiSse(), ANTHROPIC_TEXT.slice(0, -2))).toBe(plain);
  });

  it("openai stream ending without finish_reason still closes cleanly", async () => {
    const cut = OPENAI_TEXT.split("\n\n").slice(0, 3).join("\n\n") + "\n\n";
    const ev = anthEvents(await run(openaiSseToAnthropicSse("m"), cut));
    expect(ev.map((e) => e.event).slice(-3)).toEqual(["content_block_stop", "message_delta", "message_stop"]);
  });

  it("usageTap reports usage from the final event, null when absent", async () => {
    for (const [fx, exp] of [
      [ANTHROPIC_TEXT, { inputTokens: 11, outputTokens: 7 }],
      [OPENAI_TEXT, { inputTokens: 11, outputTokens: 7 }],
      [OPENAI_TOOL, null],
    ] as const) {
      const calls: unknown[] = [];
      const out = await run(usageTap((u) => calls.push(u)), fx, 1);
      expect(out).toBe(fx);
      expect(calls).toEqual([exp]);
    }
  });

  it("usageTap reports last-seen usage once when the reader cancels", async () => {
    const calls: unknown[] = [];
    const t = usageTap((u) => calls.push(u));
    const w = t.writable.getWriter();
    const r = t.readable.getReader();
    const upto = ANTHROPIC_TEXT.slice(0, ANTHROPIC_TEXT.indexOf("event: message_stop"));
    void w.write(enc.encode(upto)).catch(() => {});
    await r.read();
    await r.cancel();
    expect(calls).toEqual([{ inputTokens: 11, outputTokens: 7 }]);
  });

  describe("usageTap exactly-once", () => {
    const U = { inputTokens: 11, outputTokens: 7 };
    const partial = ANTHROPIC_TEXT.slice(0, ANTHROPIC_TEXT.indexOf("event: message_stop"));
    const setup = () => {
      const calls: unknown[] = [];
      const t = usageTap((u) => calls.push(u));
      return { calls, w: t.writable.getWriter(), r: t.readable.getReader() };
    };

    it("flush then cancel reports once", async () => {
      const { calls, w, r } = setup();
      await w.write(enc.encode(ANTHROPIC_TEXT));
      await w.close();
      while (!(await r.read()).done);
      await r.cancel();
      expect(calls).toEqual([U]);
    });

    it("cancel then flush reports once", async () => {
      const { calls, w, r } = setup();
      void w.write(enc.encode(partial)).catch(() => {});
      await r.read();
      await r.cancel();
      await w.close().catch(() => {});
      expect(calls).toEqual([U]);
    });

    it("error then cancel reports once", async () => {
      const { calls, w, r } = setup();
      void w.write(enc.encode(partial)).catch(() => {});
      await r.read();
      await w.abort(new Error("boom"));
      await expect(r.read()).rejects.toThrow("boom");
      await r.cancel().catch(() => {});
      expect(calls).toEqual([U]);
    });

    it("upstream error mid-stream rejects the reader and reports last usage once", async () => {
      const { calls, w, r } = setup();
      void w.write(enc.encode(partial)).catch(() => {});
      await r.read();
      await w.abort(new Error("boom"));
      await expect(r.read()).rejects.toThrow("boom");
      expect(calls).toEqual([U]);
    });

    it("cancel propagates to the writable", async () => {
      const { calls, w, r } = setup();
      void w.write(enc.encode(partial)).catch(() => {});
      await r.read();
      await r.cancel(new Error("gone"));
      await expect(w.closed).rejects.toThrow("gone");
      await expect(w.write(enc.encode("x"))).rejects.toThrow("gone");
      expect(calls).toEqual([U]);
    });
  });
});
