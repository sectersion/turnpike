// Streaming SSE translation between Anthropic and OpenAI, plus a usage tap.
import type { Usage } from "../usage";
import { openaiUsage, toUsage, usageFields } from "./openai-anthropic";

type SseEvent = { event?: string; data: string };
type Emit = (s: string) => void;

const enc = new TextEncoder();
const FINISH: Record<string, string> = { end_turn: "stop", tool_use: "tool_calls", max_tokens: "length", stop_sequence: "stop" };
const STOP: Record<string, string> = { stop: "end_turn", tool_calls: "tool_use", length: "max_tokens" };

/** Incremental SSE parser: feed bytes, get complete events; end() flushes a trailing event. */
function sseParser(onEvent: (e: SseEvent) => void) {
  const dec = new TextDecoder();
  let buf = "";
  const parse = (block: string) => {
    let event: string | undefined;
    const data: string[] = [];
    for (const line of block.split("\n")) {
      if (line.startsWith(":")) continue;
      if (line.startsWith("event:")) event = line.slice(6).trim();
      else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
    }
    if (data.length) onEvent({ event, data: data.join("\n") });
  };
  const drain = () => {
    let i: number;
    while ((i = buf.indexOf("\n\n")) >= 0) {
      parse(buf.slice(0, i));
      buf = buf.slice(i + 2);
    }
  };
  return {
    push(chunk: Uint8Array) {
      buf = (buf + dec.decode(chunk, { stream: true })).replace(/\r\n/g, "\n");
      drain();
    },
    end() {
      buf = (buf + dec.decode()).replace(/\r\n/g, "\n");
      drain();
      if (buf.trim()) parse(buf);
      buf = "";
    },
  };
}

function translator(onEvent: (e: SseEvent, emit: Emit) => void, onEnd: (emit: Emit) => void) {
  let emit: Emit = () => {};
  const p = sseParser((e) => onEvent(e, emit));
  return new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, ctrl) {
      emit = (s) => ctrl.enqueue(enc.encode(s));
      p.push(chunk);
    },
    flush(ctrl) {
      emit = (s) => ctrl.enqueue(enc.encode(s));
      p.end();
      onEnd(emit);
    },
  });
}

const tryJson = (s: string): any => {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
};

export function anthropicSseToOpenaiSse(): TransformStream<Uint8Array, Uint8Array> {
  let id = "chatcmpl-0";
  let model = "";
  let inTok = 0;
  let outTok = 0;
  let cw = 0;
  let cr = 0;
  let finished = false; // usage chunk + [DONE] sent
  const toolOrdinal = new Map<number, number>();
  const chunk = (choices: unknown[], extra: object = {}) =>
    `data: ${JSON.stringify({ id, object: "chat.completion.chunk", model, choices, ...extra })}\n\n`;
  const delta = (d: object, finish: string | null = null) => chunk([{ index: 0, delta: d, finish_reason: finish }]);
  const finish = (emit: Emit) => {
    if (finished) return;
    finished = true;
    emit(chunk([], { usage: openaiUsage(inTok, outTok, cw, cr) }));
    emit("data: [DONE]\n\n");
  };

  return translator(
    ({ data }, emit) => {
      const d = tryJson(data);
      if (!d || finished) return;
      switch (d.type) {
        case "message_start":
          id = d.message?.id ?? id;
          model = d.message?.model ?? model;
          inTok = d.message?.usage?.input_tokens ?? 0;
          outTok = d.message?.usage?.output_tokens ?? 0;
          cw = d.message?.usage?.cache_creation_input_tokens ?? 0;
          cr = d.message?.usage?.cache_read_input_tokens ?? 0;
          emit(delta({ role: "assistant" }));
          break;
        case "content_block_start":
          if (d.content_block?.type === "tool_use") {
            const index = toolOrdinal.size;
            toolOrdinal.set(d.index, index);
            emit(delta({ tool_calls: [{ index, id: d.content_block.id, type: "function", function: { name: d.content_block.name, arguments: "" } }] }));
          }
          break;
        case "content_block_delta":
          if (d.delta?.type === "text_delta") emit(delta({ content: d.delta.text }));
          else if (d.delta?.type === "input_json_delta")
            emit(delta({ tool_calls: [{ index: toolOrdinal.get(d.index) ?? 0, function: { arguments: d.delta.partial_json } }] }));
          break;
        case "message_delta":
          outTok = d.usage?.output_tokens ?? outTok;
          inTok = d.usage?.input_tokens ?? inTok;
          cw = d.usage?.cache_creation_input_tokens ?? cw;
          cr = d.usage?.cache_read_input_tokens ?? cr;
          if (d.delta?.stop_reason) emit(delta({}, FINISH[d.delta.stop_reason] ?? "stop"));
          break;
        case "message_stop":
          finish(emit);
          break;
        case "error":
          finished = true;
          emit(`data: ${JSON.stringify({ error: d.error ?? { message: "upstream error" } })}\n\n`);
          emit("data: [DONE]\n\n");
          break;
      }
    },
    finish,
  );
}

export function openaiSseToAnthropicSse(model: string): TransformStream<Uint8Array, Uint8Array> {
  let started = false;
  let closed = false;
  let open: { kind: "text" | "tool"; oaiIndex: number } | null = null;
  let blocks = 0;
  let stopReason: string | null = null;
  let outTok = 0;
  let inTok = 0;
  const ev = (name: string, data: object) => `event: ${name}\ndata: ${JSON.stringify({ type: name, ...data })}\n\n`;
  const start = (emit: Emit, id = "msg_0") => {
    if (started) return;
    started = true;
    emit(ev("message_start", { message: { id, type: "message", role: "assistant", model, content: [], usage: { input_tokens: inTok, output_tokens: 0 } } }));
  };
  const closeBlock = (emit: Emit) => {
    if (open) emit(ev("content_block_stop", { index: blocks - 1 }));
    open = null;
  };
  const openBlock = (emit: Emit, kind: "text" | "tool", oaiIndex: number, content_block: object) => {
    closeBlock(emit);
    emit(ev("content_block_start", { index: blocks++, content_block }));
    open = { kind, oaiIndex };
  };
  // message_delta/stop are deferred to [DONE]/flush so the trailing usage chunk is included.
  const close = (emit: Emit) => {
    if (closed) return;
    start(emit);
    closed = true;
    closeBlock(emit);
    emit(ev("message_delta", { delta: { stop_reason: stopReason ?? "end_turn", stop_sequence: null }, usage: { input_tokens: inTok, output_tokens: outTok } }));
    emit(ev("message_stop", {}));
  };

  return translator(
    ({ data }, emit) => {
      if (data.trim() === "[DONE]") return close(emit);
      const d = tryJson(data);
      if (!d || closed) return;
      start(emit, d.id);
      if (d.usage) {
        inTok = d.usage.prompt_tokens ?? inTok;
        outTok = d.usage.completion_tokens ?? outTok;
      }
      const choice = d.choices?.[0];
      if (!choice) return;
      const dl = choice.delta ?? {};
      if (typeof dl.content === "string" && dl.content) {
        if (open?.kind !== "text") openBlock(emit, "text", -1, { type: "text", text: "" });
        emit(ev("content_block_delta", { index: blocks - 1, delta: { type: "text_delta", text: dl.content } }));
      }
      for (const tc of dl.tool_calls ?? []) {
        if (open?.kind !== "tool" || open.oaiIndex !== tc.index)
          openBlock(emit, "tool", tc.index, { type: "tool_use", id: tc.id ?? `call_${tc.index}`, name: tc.function?.name ?? "", input: {} });
        if (tc.function?.arguments)
          emit(ev("content_block_delta", { index: blocks - 1, delta: { type: "input_json_delta", partial_json: tc.function.arguments } }));
      }
      if (choice.finish_reason) {
        closeBlock(emit);
        stopReason = STOP[choice.finish_reason] ?? "end_turn";
      }
    },
    close,
  );
}

export function usageTap(onUsage: (u: Usage | null) => void): TransformStream<Uint8Array, Uint8Array> {
  let seen: { i?: number; o?: number; cw?: number; cr?: number } = {};
  let reported = false;
  let chars = 0; // streamed text/tool-argument characters, for an output floor if the stream is cut short
  // aborted: the client cancelled or upstream failed, so the final output count (Anthropic sends it only in
  // the last message_delta) may be missing; charge at least ~4 characters per streamed token.
  const report = (aborted = false) => {
    if (reported) return;
    reported = true;
    const { i, o, cw, cr } = seen;
    const out = aborted ? Math.max(o ?? 0, Math.ceil(chars / 4)) : (o ?? 0);
    onUsage(i === undefined && o === undefined ? null : toUsage(i ?? 0, out, cw, cr));
  };
  const merge = (u: unknown) => {
    const f = usageFields(u);
    seen = { i: f.i ?? seen.i, o: f.o ?? seen.o, cw: f.cw ?? seen.cw, cr: f.cr ?? seen.cr };
  };
  const p = sseParser(({ data }) => {
    const d = tryJson(data);
    if (!d) return;
    const dl = d.delta ?? d.choices?.[0]?.delta;
    for (const s of [dl?.text, dl?.partial_json, dl?.content, ...(dl?.tool_calls ?? []).map((t: any) => t?.function?.arguments)])
      if (typeof s === "string") chars += s.length;
    if (d.type === "message_start" && d.message?.usage) merge(d.message.usage);
    else if (d.type === "message_delta" && d.usage) merge(d.usage);
    else if (d.usage && typeof d.usage.prompt_tokens === "number") merge({ completion_tokens: 0, ...d.usage });
  });
  const ts = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, ctrl) {
      p.push(chunk);
      ctrl.enqueue(chunk);
    },
    flush() {
      p.end();
      report();
    },
  });
  // TransformStream has no readable-side cancel hook, so wrap the readable to report on cancel.
  const reader = ts.readable.getReader();
  const readable = new ReadableStream<Uint8Array>({
    async pull(ctrl) {
      try {
        const { done, value } = await reader.read();
        if (done) ctrl.close();
        else ctrl.enqueue(value);
      } catch (e) {
        report(true); // upstream aborted/errored: keep usage seen so far
        throw e;
      }
    },
    async cancel(reason) {
      p.end();
      report(true);
      await reader.cancel(reason);
    },
  });
  return { readable, writable: ts.writable };
}
