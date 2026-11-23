const a = (event: string, data: unknown) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
const o = (data: unknown) => `data: ${JSON.stringify(data)}\n\n`;

export const ANTHROPIC_TEXT =
  a("message_start", { type: "message_start", message: { id: "msg_1", model: "claude-x", usage: { input_tokens: 11, output_tokens: 1 } } }) +
  a("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }) +
  ": comment\n\n" +
  a("ping", { type: "ping" }) +
  a("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Héllo " } }) +
  a("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "wörld 🌍" } }) +
  a("content_block_stop", { type: "content_block_stop", index: 0 }) +
  a("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 7 } }) +
  a("message_stop", { type: "message_stop" });

export const ANTHROPIC_TOOL =
  a("message_start", { type: "message_start", message: { id: "msg_2", model: "claude-x", usage: { input_tokens: 20, output_tokens: 1 } } }) +
  a("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }) +
  a("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } }) +
  a("content_block_stop", { type: "content_block_stop", index: 0 }) +
  a("content_block_start", { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "tu_1", name: "get_weather", input: {} } }) +
  a("content_block_delta", { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"city":' } }) +
  a("content_block_delta", { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '"Paris"}' } }) +
  a("content_block_stop", { type: "content_block_stop", index: 1 }) +
  a("message_delta", { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 15 } }) +
  a("message_stop", { type: "message_stop" });

export const ANTHROPIC_ERROR =
  a("message_start", { type: "message_start", message: { id: "msg_3", model: "claude-x", usage: { input_tokens: 1, output_tokens: 0 } } }) +
  a("error", { type: "error", error: { type: "overloaded_error", message: "Overloaded" } });

const c = (delta: unknown, finish: string | null = null) =>
  o({ id: "c1", object: "chat.completion.chunk", model: "gpt-x", choices: [{ index: 0, delta, finish_reason: finish }] });

export const OPENAI_TEXT =
  c({ role: "assistant" }) + c({ content: "Héllo " }) + c({ content: "wörld 🌍" }) + c({}, "stop") +
  o({ id: "c1", object: "chat.completion.chunk", model: "gpt-x", choices: [], usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 } }) +
  "data: [DONE]\n\n";

export const OPENAI_TOOL =
  c({ role: "assistant" }) + c({ content: "ok" }) +
  c({ tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "get_weather", arguments: "" } }] }) +
  c({ tool_calls: [{ index: 0, function: { arguments: '{"city":' } }] }) +
  c({ tool_calls: [{ index: 0, function: { arguments: '"Paris"}' } }] }) +
  c({}, "tool_calls") + "data: [DONE]\n\n";
