import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import app from "../src/index";
import { hub } from "../src/hub-client";
import { DEFAULT_OUT, MAX_OUT } from "../src/providers";

afterEach(() => vi.restoreAllMocks());

const sent: any[] = [];
const upstream = (res: () => Response) =>
  vi.spyOn(globalThis, "fetch").mockImplementation(async (u, init) => {
    if (!String(u).includes(".example/")) return new Response("nope", { status: 404 });
    sent.push(JSON.parse(String(init?.body)));
    return res();
  });
const noUsage = () => Response.json({ id: "1", choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }] });
const anthNoUsage = () => Response.json({ id: "1", type: "message", role: "assistant", model: "m", content: [{ type: "text", text: "ok" }], stop_reason: "end_turn" });

async function call(path: string, secret: string, body: object) {
  const ctx = createExecutionContext();
  const res = await app.fetch(
    new Request("http://x" + path, { method: "POST", headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" }, body: JSON.stringify(body) }),
    env,
    ctx,
  );
  await res.text().catch(() => {});
  await waitOnExecutionContext(ctx);
  return res;
}

async function setup(kind: "custom-openai" | "custom-anthropic", key: { monthlyUsd?: number } = {}) {
  sent.length = 0;
  const h = hub(env);
  const name = "rl" + crypto.randomUUID().slice(0, 8);
  const a = await h.upsertAccount({ kind, name, authType: "apikey", secret: "s", baseUrl: `https://${name}.example/v1` });
  // $100 per 1M output tokens, input free: $1 buys exactly 10,000 output tokens
  await h.setPriceOverride("rl-m", { inPerM: 0, outPerM: 100 });
  const k = await h.createKey({ name, ...key });
  const outOf = async () => (await h.usageSummary(0)).byKey.find((r) => r.id === k.key.id)?.outTokens;
  return { h, a, model: `${name}/rl-m`, secret: k.secret, outOf };
}

describe("I1: output limit is clamped and reserved exactly", () => {
  it("clamps max_tokens to the hard ceiling, forces n=1, reserves the clamped value", async () => {
    const s = await setup("custom-openai");
    upstream(noUsage);
    expect((await call("/v1/chat/completions", s.secret, { model: s.model, max_tokens: 10_000_000, n: 5, messages: [{ role: "user", content: "x" }] })).status).toBe(200);
    expect(sent[0]).toMatchObject({ max_tokens: MAX_OUT, n: 1 });
    expect(await s.outOf()).toBe(MAX_OUT); // no usage reported: the reservation estimate was charged
  });

  it("max_completion_tokens is clamped too (and max_tokens is not added)", async () => {
    const s = await setup("custom-openai");
    upstream(noUsage);
    await call("/v1/chat/completions", s.secret, { model: s.model, max_completion_tokens: 999_999, messages: [{ role: "user", content: "x" }] });
    expect(sent[0].max_completion_tokens).toBe(MAX_OUT);
    expect(sent[0].max_tokens).toBeUndefined();
    expect(await s.outOf()).toBe(MAX_OUT);
  });

  it("an openai client with no limit against an anthropic upstream: one default for both reservation and upstream", async () => {
    const s = await setup("custom-anthropic");
    upstream(anthNoUsage);
    await call("/v1/chat/completions", s.secret, { model: s.model, messages: [{ role: "user", content: "x" }] });
    expect(sent[0].max_tokens).toBe(DEFAULT_OUT);
    expect(await s.outOf()).toBe(DEFAULT_OUT);
  });

  it("a USD cap clamps the output so one request cannot exceed the remaining cap", async () => {
    const s = await setup("custom-anthropic", { monthlyUsd: 1 });
    upstream(anthNoUsage);
    await call("/v1/messages", s.secret, { model: s.model, max_tokens: 30_000, messages: [{ role: "user", content: "x" }] });
    expect(sent[0].max_tokens).toBe(10_000);
    expect(await s.outOf()).toBe(10_000);
  });

  it("rejects with key_monthly when even a minimal request would exceed the cap", async () => {
    const s = await setup("custom-openai", { monthlyUsd: 0.01 }); // affords 100 output tokens
    upstream(noUsage);
    const res = await call("/v1/chat/completions", s.secret, { model: s.model, max_tokens: 1000, messages: [{ role: "user", content: "x" }] });
    expect(res.status).toBe(429);
    expect(sent).toHaveLength(0);
  });
});

describe("I2: only allowed body fields reach upstream", () => {
  it("openai client: billing-relevant fields are dropped", async () => {
    const s = await setup("custom-openai");
    upstream(noUsage);
    await call("/v1/chat/completions", s.secret, {
      model: s.model, messages: [{ role: "user", content: "x" }], temperature: 0.5,
      models: ["openai/o1-pro"], route: "fallback", provider: { order: ["x"] }, plugins: [{ id: "web" }],
      web_search_options: {}, service_tier: "priority", modalities: ["audio"], audio: { voice: "x" }, store: true,
    });
    const b = sent[0];
    for (const f of ["models", "route", "provider", "plugins", "web_search_options", "service_tier", "modalities", "audio", "store"]) expect(b).not.toHaveProperty(f);
    expect(b).toMatchObject({ model: "rl-m", temperature: 0.5 });
  });

  it("anthropic client: service_tier/mcp_servers/container are dropped", async () => {
    const s = await setup("custom-anthropic");
    upstream(anthNoUsage);
    await call("/v1/messages", s.secret, {
      model: s.model, max_tokens: 10, messages: [{ role: "user", content: "x" }], top_k: 5,
      service_tier: "auto", mcp_servers: [{ url: "https://evil" }], container: "c",
    });
    for (const f of ["service_tier", "mcp_servers", "container"]) expect(sent[0]).not.toHaveProperty(f);
    expect(sent[0].top_k).toBe(5);
  });

  it("server tools are rejected with 400 and never reach upstream", async () => {
    const s = await setup("custom-anthropic");
    upstream(anthNoUsage);
    const res = await call("/v1/messages", s.secret, {
      model: s.model, max_tokens: 10, messages: [{ role: "user", content: "x" }],
      tools: [{ name: "f", input_schema: { type: "object" } }, { type: "web_search_20250305", name: "web_search" }],
    });
    expect(res.status).toBe(400);
    const o = await call("/v1/chat/completions", s.secret, { model: s.model, messages: [], tools: [{ type: "web_search" }] });
    expect(o.status).toBe(400);
    expect(sent).toHaveLength(0);
    // plain function / custom tools still pass
    expect((await call("/v1/messages", s.secret, { model: s.model, max_tokens: 10, messages: [{ role: "user", content: "x" }], tools: [{ type: "custom", name: "f", input_schema: {} }] })).status).toBe(200);
  });
});

describe("sanitize", () => {
  it("keeps thinking.budget_tokens below the clamped max_tokens, drops it when too small", async () => {
    const { sanitize } = await import("../src/providers");
    expect(sanitize("anthropic", { thinking: { type: "enabled", budget_tokens: 40_000 } }, 32_000).thinking.budget_tokens).toBe(31_999);
    expect(sanitize("anthropic", { thinking: { type: "enabled", budget_tokens: 2000 } }, 1000)).not.toHaveProperty("thinking");
  });
});
