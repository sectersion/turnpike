// Local stub imitating LLM providers. One process plays many upstream accounts by path prefix.
// Usage: node scripts/stub-upstream.mjs [port]   (default 9101, or PORT env)
import http from "node:http";

const PORT = Number(process.argv[2] ?? process.env.PORT ?? 9101);
let log = [];
const IN = 11, OUT = 7; // deterministic usage
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sse = (res, ev, data) => res.write((ev ? `event: ${ev}\n` : "") + `data: ${typeof data === "string" ? data : JSON.stringify(data)}\n\n`);
const lastText = (b) => {
  const m = (b.messages ?? []).at(-1)?.content;
  return typeof m === "string" ? m : (m ?? []).map((p) => p.text ?? "").join("");
};
const json = (res, status, obj, headers = {}) => {
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(JSON.stringify(obj));
};

async function openai(req, res, body, mode) {
  if (mode === "rate") return json(res, 429, { error: { message: "rate limited" } }, { "retry-after": "2" });
  if (mode === "boom") return json(res, 500, { error: { message: "boom" } });
  if (mode === "bad") return json(res, 400, { error: { message: "bad request from stub" } });
  const tool = body.tools?.length && /use the tool/i.test(lastText(body));
  const words = ["Hello", " from", " stub"];
  const usage = { prompt_tokens: IN, completion_tokens: OUT, total_tokens: IN + OUT };
  if (!body.stream) {
    const message = tool
      ? { role: "assistant", content: null, tool_calls: [{ id: "call_1", type: "function", function: { name: body.tools[0].function.name, arguments: '{"city":"Paris"}' } }] }
      : { role: "assistant", content: words.join("") };
    return json(res, 200, { id: "chatcmpl-stub", object: "chat.completion", model: body.model, choices: [{ index: 0, message, finish_reason: tool ? "tool_calls" : "stop" }], usage });
  }
  res.writeHead(200, { "content-type": "text/event-stream" });
  const chunk = (delta, finish = null, extra = {}) => sse(res, null, { id: "chatcmpl-stub", object: "chat.completion.chunk", model: body.model, choices: [{ index: 0, delta, finish_reason: finish }], ...extra });
  chunk({ role: "assistant" });
  if (tool) {
    chunk({ tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: body.tools[0].function.name, arguments: "" } }] });
    chunk({ tool_calls: [{ index: 0, function: { arguments: '{"city":"Paris"}' } }] });
    chunk({}, "tool_calls");
  } else if (mode === "slow") {
    let closed = false;
    res.on("close", () => (closed = true));
    for (let i = 0; i < 15 && !closed; i++) { chunk({ content: `w${i} ` }); await sleep(200); }
    if (closed) return;
    chunk({}, "stop");
  } else {
    for (const w of words) chunk({ content: w });
    chunk({}, "stop");
  }
  if (body.stream_options?.include_usage) sse(res, null, { id: "chatcmpl-stub", object: "chat.completion.chunk", model: body.model, choices: [], usage });
  sse(res, null, "[DONE]");
  res.end();
}

function anthropic(req, res, body) {
  if (!req.headers["x-api-key"] || !req.headers["anthropic-version"]) return json(res, 401, { type: "error", error: { type: "authentication_error", message: "missing x-api-key/anthropic-version" } });
  const tool = body.tools?.length && /use the tool/i.test(lastText(body));
  const content = tool ? [{ type: "tool_use", id: "toolu_1", name: body.tools[0].name, input: { city: "Paris" } }] : [{ type: "text", text: "Hello from stub" }];
  const stop_reason = tool ? "tool_use" : "end_turn";
  if (!body.stream) return json(res, 200, { id: "msg_stub", type: "message", role: "assistant", model: body.model, content, stop_reason, stop_sequence: null, usage: { input_tokens: IN, output_tokens: OUT } });
  res.writeHead(200, { "content-type": "text/event-stream" });
  const ev = (type, d) => sse(res, type, { type, ...d });
  ev("message_start", { message: { id: "msg_stub", type: "message", role: "assistant", model: body.model, content: [], usage: { input_tokens: IN, output_tokens: 1 } } });
  if (tool) {
    ev("content_block_start", { index: 0, content_block: { type: "tool_use", id: "toolu_1", name: body.tools[0].name, input: {} } });
    ev("content_block_delta", { index: 0, delta: { type: "input_json_delta", partial_json: '{"city":' } });
    ev("content_block_delta", { index: 0, delta: { type: "input_json_delta", partial_json: '"Paris"}' } });
  } else {
    ev("content_block_start", { index: 0, content_block: { type: "text", text: "" } });
    for (const t of ["Hello", " from", " stub"]) ev("content_block_delta", { index: 0, delta: { type: "text_delta", text: t } });
  }
  ev("content_block_stop", { index: 0 });
  ev("message_delta", { delta: { stop_reason, stop_sequence: null }, usage: { output_tokens: OUT } });
  ev("message_stop", {});
  res.end();
}

http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  if (url.pathname === "/__requests") {
    if (req.method === "DELETE") { log = []; return json(res, 200, { ok: true }); }
    return json(res, 200, log);
  }
  let raw = "";
  for await (const c of req) raw += c;
  let body = {};
  try { body = raw ? JSON.parse(raw) : {}; } catch {}
  const h = req.headers;
  log.push({ method: req.method, url: req.url, authorization: h.authorization, "x-api-key": h["x-api-key"], "anthropic-version": h["anthropic-version"], "content-type": h["content-type"], body });
  const [, mode, ...rest] = url.pathname.split("/");
  const tail = "/" + rest.join("/");
  if (req.method !== "POST") return json(res, 404, { error: { message: "not found" } });
  if (mode === "anthropic" && tail === "/v1/messages") return anthropic(req, res, body);
  if (tail === "/v1/chat/completions" && ["ok", "rate", "boom", "slow", "bad"].includes(mode)) return openai(req, res, body, mode);
  json(res, 404, { error: { message: `stub: no route ${url.pathname}` } });
}).listen(PORT, "127.0.0.1", () => console.log(`stub upstream on :${PORT}`));
