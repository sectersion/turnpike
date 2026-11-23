import { describe, expect, it } from "vitest";
import { explainEmpty, isFallbackEligible, resolveTargets, routeWithFallback } from "../src/router";
import { callUpstream } from "../src/providers";
import type { Account, Combo } from "../src/types";

const acc = (id: string, kind: Account["kind"], extra: Partial<Account> = {}): Account => ({
  id,
  kind,
  name: id,
  authType: "apikey",
  secret: "k-" + id,
  enabled: true,
  ...extra,
});
const A = acc("a", "openrouter");
const B = acc("b", "opencode-zen");
const C = acc("c", "custom-anthropic", { baseUrl: "https://anth.example/v1/" });
const accounts = [A, B, C];
const combos: Combo[] = [
  {
    name: "fast",
    targets: [
      { accountId: "a", model: "m1" },
      { accountId: "b", model: "m2" },
    ],
  },
];
const json = (status: number, body: unknown = { ok: status }) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const fakeFetch = (...rs: (Response | Error)[]) => {
  const calls: { url: string; init: RequestInit }[] = [];
  const f = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const r = rs[Math.min(calls.length - 1, rs.length - 1)];
    if (r instanceof Error) throw r;
    return r.clone();
  }) as unknown as typeof fetch;
  return { f, calls };
};
const oai = { model: "x", messages: [{ role: "user", content: "hi" }] };

describe("resolveTargets", () => {
  it("provider/model, model may contain slashes, case-insensitive", () => {
    const t = resolveTargets("A/anthropic/claude", accounts, combos, null);
    expect(t).toEqual([{ account: A, model: "anthropic/claude" }]);
  });
  it("combo expands in order; combo name wins", () => {
    expect(resolveTargets("fast", accounts, combos, null).map((t) => t.model)).toEqual(["m1", "m2"]);
  });
  it("allow-list removes disallowed targets; empty result is not_allowed", () => {
    expect(resolveTargets("fast", accounts, combos, ["b"]).map((t) => t.account.id)).toEqual(["b"]);
    expect(resolveTargets("fast", accounts, combos, [])).toEqual([]);
    expect(explainEmpty("fast", accounts, combos)).toBe("not_allowed");
    expect(explainEmpty("nope/x", accounts, combos)).toBe("unknown_model");
  });
  it("disabled accounts are skipped", () => {
    const off = [{ ...A, enabled: false }, B, C];
    expect(resolveTargets("fast", off, combos, null).map((t) => t.account.id)).toEqual(["b"]);
    expect(resolveTargets("a/x", off, combos, null)).toEqual([]);
  });
});

describe("isFallbackEligible", () => {
  it("408/429/5xx only", () => {
    expect([408, 429, 500, 503].every(isFallbackEligible)).toBe(true);
    expect([200, 400, 401, 404].some(isFallbackEligible)).toBe(false);
  });
});

describe("routeWithFallback", () => {
  const targets = resolveTargets("fast", accounts, combos, null);
  it("combo falls through to next target on 429", async () => {
    const { f, calls } = fakeFetch(json(429), json(200));
    const res = await routeWithFallback(targets, "openai", oai, f);
    expect(res.status).toBe(200);
    expect(calls.map((c) => c.url)).toEqual([
      "https://openrouter.ai/api/v1/chat/completions",
      "https://opencode.ai/zen/v1/chat/completions",
    ]);
    expect(JSON.parse(calls[0].init.body as string).model).toBe("m1");
    expect((calls[0].init.headers as Record<string, string>).Authorization).toBe("Bearer k-a");
  });
  it("does not fall through on 400 and returns it", async () => {
    const { f, calls } = fakeFetch(json(400), json(200));
    expect((await routeWithFallback(targets, "openai", oai, f)).status).toBe(400);
    expect(calls.length).toBe(1);
  });
  it("does not call next target after 2xx", async () => {
    const { f, calls } = fakeFetch(json(200), json(200));
    await routeWithFallback(targets, "openai", oai, f);
    expect(calls.length).toBe(1);
  });
  it("all failing returns the last upstream error", async () => {
    const { f } = fakeFetch(json(429), json(503, { e: "last" }));
    const res = await routeWithFallback(targets, "openai", oai, f);
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ e: "last" });
  });
  it("network error falls through; last throw gives 502", async () => {
    const r1 = await routeWithFallback(targets, "openai", oai, fakeFetch(new Error("boom"), json(200)).f);
    expect(r1.status).toBe(200);
    const seen: unknown[] = [];
    const r2 = await routeWithFallback(targets, "openai", oai, fakeFetch(new Error("boom")).f, (_t, r) => seen.push(r));
    expect(r2.status).toBe(502);
    expect(((await r2.json()) as any).error.message).toContain("boom");
    expect(seen.length).toBe(2);
  });
  it("no targets is 404", async () => {
    expect((await routeWithFallback([], "openai", oai, fakeFetch(json(200)).f)).status).toBe(404);
  });
});

describe("callUpstream translation", () => {
  const t = { account: C, model: "claude-x" };
  it("anthropic client to openai-style upstream translates request and response", async () => {
    const { f, calls } = fakeFetch(
      json(200, {
        id: "1",
        object: "chat.completion",
        model: "m",
        choices: [{ index: 0, message: { role: "assistant", content: "yo" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
      }),
    );
    const body = { model: "z", max_tokens: 10, messages: [{ role: "user", content: "hi" }] };
    const res = await callUpstream({ account: A, model: "gpt" }, "anthropic", body, f);
    expect(calls[0].url).toBe("https://openrouter.ai/api/v1/chat/completions");
    const sent = JSON.parse(calls[0].init.body as string);
    expect(sent.model).toBe("gpt");
    expect(sent.messages[0]).toEqual({ role: "user", content: "hi" });
    const out: any = await res.json();
    expect(out.type).toBe("message");
    expect(out.content[0].text).toBe("yo");
  });
  it("openai client to custom-anthropic: url, headers, translation", async () => {
    const { f, calls } = fakeFetch(
      json(200, {
        id: "1",
        type: "message",
        role: "assistant",
        model: "m",
        content: [{ type: "text", text: "yo" }],
        stop_reason: "end_turn",
        usage: { input_tokens: 1, output_tokens: 2 },
      }),
    );
    const res = await callUpstream(t, "openai", oai, f);
    expect(calls[0].url).toBe("https://anth.example/v1/messages");
    const h = calls[0].init.headers as Record<string, string>;
    expect(h["x-api-key"]).toBe("k-c");
    expect(h["anthropic-version"]).toBe("2023-06-01");
    expect(JSON.parse(calls[0].init.body as string).model).toBe("claude-x");
    expect(((await res.json()) as any).choices[0].message.content).toBe("yo");
  });
  it("non-2xx is returned untranslated", async () => {
    const res = await callUpstream(t, "openai", oai, fakeFetch(json(429, { err: 1 })).f);
    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({ err: 1 });
  });
  it("{apiKey} secrets work", async () => {
    const { f, calls } = fakeFetch(json(200));
    await callUpstream({ account: { ...A, secret: { apiKey: "zz" } }, model: "m" }, "openai", oai, f);
    expect((calls[0].init.headers as Record<string, string>).Authorization).toBe("Bearer zz");
  });
  it("oauth kinds are not implemented yet", async () => {
    await expect(callUpstream({ account: acc("o", "claude-oauth"), model: "m" }, "openai", oai, fakeFetch(json(200)).f)).rejects.toThrow(
      "oauth executor not implemented",
    );
  });
  it("streams are translated across formats", async () => {
    const sse = (s: string) => new Response(s, { status: 200, headers: { "content-type": "text/event-stream" } });
    const oaiSse =
      'data: {"id":"1","object":"chat.completion.chunk","model":"m","choices":[{"index":0,"delta":{"content":"hi"},"finish_reason":null}]}\n\n' +
      'data: {"id":"1","object":"chat.completion.chunk","model":"m","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n' +
      "data: [DONE]\n\n";
    const res = await callUpstream(
      { account: A, model: "gpt" },
      "anthropic",
      { max_tokens: 5, stream: true, messages: [{ role: "user", content: "hi" }] },
      fakeFetch(sse(oaiSse)).f,
    );
    const text = await res.text();
    expect(text).toContain("event: message_start");
    expect(text).toContain("hi");

    const antSse =
      'event: message_start\ndata: {"type":"message_start","message":{"id":"m1","model":"m","usage":{"input_tokens":1,"output_tokens":0}}}\n\n' +
      'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n' +
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hey"}}\n\n' +
      'event: message_stop\ndata: {"type":"message_stop"}\n\n';
    const res2 = await callUpstream(t, "openai", { ...oai, stream: true }, fakeFetch(sse(antSse)).f);
    const text2 = await res2.text();
    expect(text2).toContain("chat.completion.chunk");
    expect(text2).toContain("hey");
    expect(text2).toContain("[DONE]");
  });
});

describe("robustness", () => {
  const two = resolveTargets("fast", accounts, combos, null);
  it("cancels a failed attempt's body before the next target", async () => {
    const order: string[] = [];
    let n = 0;
    const f = (async () => {
      if (n++ === 0) {
        const body = new ReadableStream({ cancel: () => void order.push("cancel") });
        return new Response(body, { status: 429 });
      }
      order.push("second");
      return json(200);
    }) as unknown as typeof fetch;
    expect((await routeWithFallback(two, "openai", oai, f)).status).toBe(200);
    expect(order).toEqual(["cancel", "second"]);
  });
  it("empty baseUrl fails before fetch with a clear 502", async () => {
    const { f, calls } = fakeFetch(json(200));
    const t = [{ account: acc("x", "custom-openai"), model: "m" }];
    const res = await routeWithFallback(t, "openai", oai, f);
    expect(calls.length).toBe(0);
    expect(res.status).toBe(502);
    expect(((await res.json()) as any).error.message).toContain("no baseUrl");
  });
  it("missing api key fails before fetch", async () => {
    const { f, calls } = fakeFetch(json(200));
    const t = [{ account: acc("x", "openrouter", { secret: "" }), model: "m" }];
    const res = await routeWithFallback(t, "openai", oai, f);
    expect(calls.length).toBe(0);
    expect(((await res.json()) as any).error.message).toContain("no api key");
  });
  it("a throwing onAttempt does not break routing", async () => {
    const { f, calls } = fakeFetch(json(429), json(200, { second: true }));
    const res = await routeWithFallback(two, "openai", oai, f, () => {
      throw new Error("log fail");
    });
    expect(calls.length).toBe(2);
    expect(await res.json()).toEqual({ second: true });
  });
});
