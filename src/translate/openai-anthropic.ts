import type {
  AnthropicBlock,
  AnthropicMessage,
  AnthropicReq,
  AnthropicRes,
  OAIFinishReason,
  OAIMessage,
  OAIPart,
  OAIToolCall,
  OpenAIChatReq,
  OpenAIChatRes,
} from "./types";

const DATA_URI = /^data:([^;,]+);base64,(.*)$/s;

const text = (blocks: AnthropicBlock[]) => blocks.map((b) => (b.type === "text" ? b.text : "")).join("");

function partToBlock(p: OAIPart): AnthropicBlock {
  if (p.type === "text") return { type: "text", text: p.text };
  const m = DATA_URI.exec(p.image_url.url);
  return m
    ? { type: "image", source: { type: "base64", media_type: m[1], data: m[2] } }
    : { type: "image", source: { type: "url", url: p.image_url.url } };
}

function blockToPart(b: AnthropicBlock): OAIPart | null {
  if (b.type === "text") return { type: "text", text: b.text };
  if (b.type !== "image") return null;
  const url = b.source.type === "base64" ? `data:${b.source.media_type};base64,${b.source.data}` : b.source.url;
  return { type: "image_url", image_url: { url } };
}

function parseArgs(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return {};
  }
}

const contentToBlocks = (c: OAIMessage["content"]): AnthropicBlock[] =>
  typeof c === "string" ? [{ type: "text", text: c }] : Array.isArray(c) ? c.map(partToBlock) : [];

const toolCalls = (blocks: AnthropicBlock[]): OAIToolCall[] =>
  blocks.flatMap((b) =>
    b.type === "tool_use"
      ? [{ id: b.id, type: "function" as const, function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) } }]
      : [],
  );

export function openaiReqToAnthropic(r: OpenAIChatReq): AnthropicReq {
  const system: string[] = [];
  const messages: AnthropicMessage[] = [];
  for (const m of r.messages) {
    if (m.role === "system" || m.role === "developer") {
      const t = typeof m.content === "string" ? m.content : text(contentToBlocks(m.content));
      if (t) system.push(t);
    } else if (m.role === "tool") {
      const block: AnthropicBlock = {
        type: "tool_result",
        tool_use_id: m.tool_call_id ?? "",
        content: typeof m.content === "string" ? m.content : text(contentToBlocks(m.content)),
      };
      const last = messages[messages.length - 1];
      if (last && last.role === "user" && Array.isArray(last.content) && last.content.every((b) => b.type === "tool_result")) {
        last.content.push(block);
      } else {
        messages.push({ role: "user", content: [block] });
      }
    } else if (m.role === "assistant" && m.tool_calls?.length) {
      const blocks = contentToBlocks(m.content).filter((b) => b.type !== "text" || b.text);
      for (const t of m.tool_calls) {
        blocks.push({ type: "tool_use", id: t.id, name: t.function.name, input: parseArgs(t.function.arguments) });
      }
      messages.push({ role: "assistant", content: blocks });
    } else {
      const content = typeof m.content === "string" ? m.content : contentToBlocks(m.content);
      // Omit messages with no content (e.g. assistant content:null); Anthropic rejects empty blocks.
      if (content.length) messages.push({ role: m.role as "user" | "assistant", content });
    }
  }
  const out: AnthropicReq = { model: r.model, messages, max_tokens: r.max_tokens ?? 4096 };
  if (system.length) out.system = system.join("\n\n");
  if (r.temperature !== undefined) out.temperature = r.temperature;
  if (r.top_p !== undefined) out.top_p = r.top_p;
  if (r.stop !== undefined) out.stop_sequences = Array.isArray(r.stop) ? r.stop : [r.stop];
  if (r.stream !== undefined) out.stream = r.stream;
  if (r.tools) {
    out.tools = r.tools.map((t) => ({
      name: t.function.name,
      ...(t.function.description !== undefined && { description: t.function.description }),
      input_schema: t.function.parameters ?? { type: "object" },
    }));
  }
  const tc = r.tool_choice;
  if (tc) {
    out.tool_choice =
      tc === "auto" ? { type: "auto" } : tc === "none" ? { type: "none" } : tc === "required" ? { type: "any" } : { type: "tool", name: tc.function.name };
  }
  return out;
}

export function anthropicReqToOpenai(r: AnthropicReq): OpenAIChatReq {
  const messages: OAIMessage[] = [];
  if (r.system) {
    messages.push({ role: "system", content: typeof r.system === "string" ? r.system : r.system.map((b) => b.text).join("\n\n") });
  }
  for (const m of r.messages) {
    if (typeof m.content === "string") {
      messages.push({ role: m.role, content: m.content });
      continue;
    }
    for (const b of m.content) {
      if (b.type === "tool_result") {
        messages.push({ role: "tool", tool_call_id: b.tool_use_id, content: typeof b.content === "string" ? b.content : text(b.content) });
      }
    }
    const rest = m.content.filter((b) => b.type !== "tool_result" && b.type !== "tool_use");
    const calls = toolCalls(m.content);
    if (!rest.length && !calls.length) continue;
    const parts = rest.map(blockToPart).filter((p): p is OAIPart => p !== null);
    const allText = parts.every((p) => p.type === "text");
    const joined = parts.map((p) => (p.type === "text" ? p.text : "")).join("");
    const msg: OAIMessage = { role: m.role, content: allText ? (calls.length && !joined ? null : joined) : parts };
    if (calls.length) msg.tool_calls = calls;
    messages.push(msg);
  }
  const out: OpenAIChatReq = { model: r.model, messages, max_tokens: r.max_tokens };
  if (r.temperature !== undefined) out.temperature = r.temperature;
  if (r.top_p !== undefined) out.top_p = r.top_p;
  if (r.stop_sequences) out.stop = r.stop_sequences;
  if (r.stream !== undefined) out.stream = r.stream;
  if (r.tools) {
    out.tools = r.tools.map((t) => ({
      type: "function" as const,
      function: { name: t.name, ...(t.description !== undefined && { description: t.description }), parameters: t.input_schema },
    }));
  }
  const tc = r.tool_choice;
  if (tc) {
    out.tool_choice = tc.type === "auto" ? "auto" : tc.type === "none" ? "none" : tc.type === "any" ? "required" : { type: "function", function: { name: tc.name } };
  }
  return out;
}

const FINISH: Record<string, OAIFinishReason> = { end_turn: "stop", stop_sequence: "stop", tool_use: "tool_calls", max_tokens: "length" };
const STOP = { stop: "end_turn", tool_calls: "tool_use", length: "max_tokens" } as const;

const genId = (prefix: string) => `${prefix}_${crypto.randomUUID().replace(/-/g, "")}`;

export function anthropicResToOpenai(r: AnthropicRes): OpenAIChatRes {
  const calls = toolCalls(r.content);
  const message: OAIMessage = { role: "assistant", content: text(r.content) || (calls.length ? null : "") };
  if (calls.length) message.tool_calls = calls;
  const out: OpenAIChatRes = {
    id: r.id ?? genId("chatcmpl"),
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: r.model,
    choices: [{ index: 0, message, finish_reason: r.stop_reason ? (FINISH[r.stop_reason] ?? "stop") : null }],
  };
  if (r.usage) {
    out.usage = {
      prompt_tokens: r.usage.input_tokens,
      completion_tokens: r.usage.output_tokens,
      total_tokens: r.usage.input_tokens + r.usage.output_tokens,
    };
  }
  return out;
}

export function openaiResToAnthropic(r: OpenAIChatRes): AnthropicRes {
  const choice = r.choices[0];
  const content: AnthropicBlock[] = [];
  const c = choice?.message.content;
  if (typeof c === "string" && c) content.push({ type: "text", text: c });
  else if (Array.isArray(c)) content.push(...c.map(partToBlock));
  for (const t of choice?.message.tool_calls ?? []) {
    content.push({ type: "tool_use", id: t.id, name: t.function.name, input: parseArgs(t.function.arguments) });
  }
  const fr = choice?.finish_reason;
  const out: AnthropicRes = {
    id: r.id ?? genId("msg"),
    type: "message",
    role: "assistant",
    model: r.model,
    content,
    stop_reason: fr ? (STOP[fr] ?? "end_turn") : null,
  };
  if (r.usage) out.usage = { input_tokens: r.usage.prompt_tokens, output_tokens: r.usage.completion_tokens };
  return out;
}

export function extractUsage(res: unknown): { inputTokens: number; outputTokens: number } | null {
  const u = (res as { usage?: Record<string, unknown> } | null)?.usage;
  if (!u || typeof u !== "object") return null;
  const i = u.prompt_tokens ?? u.input_tokens;
  const o = u.completion_tokens ?? u.output_tokens;
  return typeof i === "number" && typeof o === "number" ? { inputTokens: i, outputTokens: o } : null;
}
