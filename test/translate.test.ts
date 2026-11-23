import { describe, expect, it } from "vitest";
import {
  anthropicReqToOpenai,
  anthropicResToOpenai,
  extractUsage,
  openaiReqToAnthropic,
  openaiResToAnthropic,
} from "../src/translate/openai-anthropic";
import type { AnthropicReq, OpenAIChatReq } from "../src/translate/types";

describe("translate", () => {
  it("system message becomes anthropic system field and back", () => {
    const a = openaiReqToAnthropic({
      model: "m",
      messages: [{ role: "system", content: "be nice" }, { role: "user", content: "hi" }],
    });
    expect(a.system).toBe("be nice");
    expect(a.messages).toEqual([{ role: "user", content: "hi" }]);
    const o = anthropicReqToOpenai(a);
    expect(o.messages[0]).toEqual({ role: "system", content: "be nice" });
    expect(o.messages[1]).toEqual({ role: "user", content: "hi" });
  });

  it("max_tokens defaults to 4096 when converting openai to anthropic", () => {
    const base: OpenAIChatReq = { model: "m", messages: [{ role: "user", content: "x" }] };
    expect(openaiReqToAnthropic(base).max_tokens).toBe(4096);
    expect(openaiReqToAnthropic({ ...base, max_tokens: 10, stop: "a" })).toMatchObject({
      max_tokens: 10,
      stop_sequences: ["a"],
    });
  });

  it("tool_calls round-trip: openai tool_calls <-> anthropic tool_use", () => {
    const req: OpenAIChatReq = {
      model: "m",
      messages: [
        {
          role: "assistant",
          content: null,
          tool_calls: [{ id: "c1", type: "function", function: { name: "f", arguments: '{"a":1}' } }],
        },
      ],
      tools: [{ type: "function", function: { name: "f", description: "d", parameters: { type: "object" } } }],
      tool_choice: { type: "function", function: { name: "f" } },
    };
    const a = openaiReqToAnthropic(req);
    expect(a.messages[0]).toEqual({
      role: "assistant",
      content: [{ type: "tool_use", id: "c1", name: "f", input: { a: 1 } }],
    });
    expect(a.tools).toEqual([{ name: "f", description: "d", input_schema: { type: "object" } }]);
    expect(a.tool_choice).toEqual({ type: "tool", name: "f" });
    expect(anthropicReqToOpenai(a)).toEqual({ ...req, max_tokens: 4096 });
  });

  it("tool role message <-> tool_result block", () => {
    const a = openaiReqToAnthropic({
      model: "m",
      messages: [
        { role: "tool", tool_call_id: "c1", content: "r1" },
        { role: "tool", tool_call_id: "c2", content: "r2" },
      ],
    });
    expect(a.messages).toEqual([
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "c1", content: "r1" },
          { type: "tool_result", tool_use_id: "c2", content: "r2" },
        ],
      },
    ]);
    expect(anthropicReqToOpenai(a).messages).toEqual([
      { role: "tool", tool_call_id: "c1", content: "r1" },
      { role: "tool", tool_call_id: "c2", content: "r2" },
    ]);
  });

  it("image_url data URI <-> anthropic base64 image block", () => {
    const a = openaiReqToAnthropic({
      model: "m",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "look" },
            { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
            { type: "image_url", image_url: { url: "https://x/y.png" } },
          ],
        },
      ],
    });
    const content = a.messages[0].content as unknown[];
    expect(content[1]).toEqual({ type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } });
    expect(content[2]).toEqual({ type: "image", source: { type: "url", url: "https://x/y.png" } });
    const o = anthropicReqToOpenai(a as AnthropicReq);
    expect(o.messages[0].content).toEqual([
      { type: "text", text: "look" },
      { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
      { type: "image_url", image_url: { url: "https://x/y.png" } },
    ]);
  });

  it("stop_reason end_turn/tool_use/max_tokens maps to stop/tool_calls/length", () => {
    const mk = (stop_reason: string) =>
      anthropicResToOpenai({
        id: "msg_1",
        type: "message",
        role: "assistant",
        model: "m",
        content: [
          { type: "text", text: "a" },
          { type: "text", text: "b" },
          { type: "tool_use", id: "t", name: "f", input: { q: 1 } },
        ],
        stop_reason: stop_reason as never,
        usage: { input_tokens: 3, output_tokens: 4 },
      });
    expect(mk("end_turn").choices[0].finish_reason).toBe("stop");
    expect(mk("tool_use").choices[0].finish_reason).toBe("tool_calls");
    expect(mk("max_tokens").choices[0].finish_reason).toBe("length");
    const r = mk("end_turn");
    expect(r.id).toBe("msg_1");
    expect(r.choices[0].message.content).toBe("ab");
    expect(r.choices[0].message.tool_calls?.[0].function.arguments).toBe('{"q":1}');
    expect(r.usage).toEqual({ prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 });

    const back = openaiResToAnthropic(mk("tool_use"));
    expect(back.stop_reason).toBe("tool_use");
    expect(back.content).toEqual([
      { type: "text", text: "ab" },
      { type: "tool_use", id: "t", name: "f", input: { q: 1 } },
    ]);
    expect(back.usage).toEqual({ input_tokens: 3, output_tokens: 4 });
  });

  it("extractUsage accepts either shape", () => {
    expect(extractUsage({ usage: { prompt_tokens: 1, completion_tokens: 2 } })).toEqual({ inputTokens: 1, outputTokens: 2 });
    expect(extractUsage({ usage: { input_tokens: 5, output_tokens: 6 } })).toEqual({ inputTokens: 5, outputTokens: 6 });
    expect(extractUsage({})).toBeNull();
    expect(extractUsage(null)).toBeNull();
  });
});
