import { createExecutionContext, env, runInDurableObject, waitOnExecutionContext } from "cloudflare:test";
import type { Hub } from "../src/hub";
import { afterEach, describe, expect, it, vi } from "vitest";
import app from "../src/index";
import { hub as mainHub } from "../src/hub-client";
import { estimateTokens, retryAfterMs } from "../src/proxy";
import type { Account } from "../src/types";

const T = Date.UTC(2026, 10, 22, 12);
const MIN = 60_000;

// Model "pm" costs $0.10 per input token, nothing for output, so estTokens 1 reserves exactly $0.10.
async function setup(key: { dailyUsd?: number; monthlyUsd?: number } = {}, acc: Partial<Account> = {}) {
  const h = env.HUB.get(env.HUB.idFromName("lim-" + crypto.randomUUID()));
  const k = (await h.createKey({ name: "k", ...key })).key;
  const a = await h.upsertAccount({ kind: "custom-openai", name: "a", authType: "apikey", secret: "s", ...acc });
  await h.setPriceOverride("pm", { inPerM: 100_000, outPerM: 0 });
  const r = (now = T, model = "pm", estTokens = 1) => h.reserve({ keyId: k.id, accountId: a.id, model, estTokens, now });
  return { h, k, a, r };
}
const id = (x: { ok: boolean; reservationId?: string }) => (x as { reservationId: string }).reservationId;

describe("limits", () => {
  it("reserve rejects key_daily once cap is reached", async () => {
    const { h, r } = await setup({ dailyUsd: 0.25 });
    await h.settle(id(await r()), null, T);
    expect((await r()).ok).toBe(true); // 0.1 settled + 0.1 reserved
    expect(await r()).toEqual({ ok: false, reason: "key_daily" });
  });

  it("key_daily resets at the UTC day boundary; key_monthly and account_monthly hold", async () => {
    const { h, r } = await setup({ dailyUsd: 0.15, monthlyUsd: 0.25 });
    await h.settle(id(await r()), null, T);
    expect(await r()).toEqual({ ok: false, reason: "key_daily" });
    const day2 = Date.UTC(2026, 10, 23);
    await h.settle(id(await r(day2)), null, day2);
    expect(await r(Date.UTC(2026, 10, 24))).toEqual({ ok: false, reason: "key_monthly" });
    expect((await r(Date.UTC(2026, 11, 1))).ok).toBe(true);

    const s = await setup({}, { monthlyUsd: 0.15 });
    await s.h.settle(id(await s.r()), null, T);
    expect(await s.r()).toEqual({ ok: false, reason: "account_monthly" });
  });

  it("two concurrent reserves at the cap: only one succeeds", async () => {
    const { r } = await setup({ dailyUsd: 0.15 });
    const res = await Promise.all([r(), r()]);
    expect(res.filter((x) => x.ok)).toHaveLength(1);
    expect(res.find((x) => !x.ok)).toEqual({ ok: false, reason: "key_daily" });
  });

  it("unpriced model is rejected for a key with a USD cap, allowed for an uncapped key", async () => {
    const capped = await setup({ monthlyUsd: 100 });
    expect(await capped.r(T, "no-such-model-zz9")).toEqual({ ok: false, reason: "unpriced" });
    const free = await setup();
    expect((await free.r(T, "no-such-model-zz9")).ok).toBe(true);
    const sub = await setup({ monthlyUsd: 100 }, { kind: "codex-oauth" });
    expect((await sub.r(T, "no-such-model-zz9")).ok).toBe(true);
  });

  it("settle with null usage records the estimate", async () => {
    const { h, k, a, r } = await setup();
    const x = await h.reserve({ keyId: k.id, accountId: a.id, model: "pm", estTokens: 10, maxOutTokens: 5, now: T });
    await h.settle(id(x), null, T);
    const { byKey, byAccount } = await h.usageSummary(0);
    expect(byKey).toEqual([{ id: k.id, requests: 1, inTokens: 10, outTokens: 5, costUsd: 1 }]);
    expect(byAccount[0]).toMatchObject({ id: a.id, costUsd: 1 });
    await h.settle(id(await r()), { inputTokens: 2, outputTokens: 7 }, T);
    expect((await h.usageSummary(0)).byKey[0]).toMatchObject({ requests: 2, inTokens: 12, outTokens: 12 });
    expect((await h.usageSummary(0)).byKey[0].costUsd).toBeCloseTo(1.2);
  });

  it("settle is idempotent", async () => {
    const { h, r } = await setup();
    const rid = id(await r());
    await h.settle(rid, { inputTokens: 1, outputTokens: 1 });
    await h.settle(rid, { inputTokens: 1, outputTokens: 1 });
    await h.settle("unknown", null);
    expect((await h.usageSummary(0)).byKey[0].requests).toBe(1);
  });

  it("rpm cap rejects the N+1th request in a minute and recovers after", async () => {
    const { h, r } = await setup({}, { rpm: 2 });
    await h.release(id(await r(T)), T); // released requests still count toward rpm
    expect((await r(T + 1)).ok).toBe(true);
    expect(await r(T + 2)).toEqual({ ok: false, reason: "rpm" });
    // the live reservation from T+1 is still inside the window at T+MIN, the released one is not
    expect((await r(T + MIN)).ok).toBe(true);
    expect(await r(T + MIN)).toEqual({ ok: false, reason: "rpm" });
  });

  it("tpm counts settled tokens plus the estimate", async () => {
    const { h, r } = await setup({}, { tpm: 100 });
    await h.settle(id(await r(T, "pm", 50)), { inputTokens: 40, outputTokens: 20 }, T);
    expect(await r(T + 1, "pm", 41)).toEqual({ ok: false, reason: "tpm" });
    expect((await r(T + 1, "pm", 40)).ok).toBe(true);
    expect((await r(T + MIN + 1, "pm", 60)).ok).toBe(true);
  });

  it("setCooldown makes reserve return cooldown until it expires", async () => {
    const { h, a, r } = await setup();
    await h.setCooldown(a.id, T + 1000);
    expect(await r(T)).toEqual({ ok: false, reason: "cooldown" });
    expect((await r(T + 1000)).ok).toBe(true);
  });

  it("subscription accounts accrue tokens but zero USD", async () => {
    const { h, r } = await setup({ dailyUsd: 0 }, { kind: "codex-oauth" });
    await h.settle(id(await r()), { inputTokens: 100, outputTokens: 50 });
    expect((await h.usageSummary(0)).byAccount[0]).toMatchObject({ requests: 1, inTokens: 100, outTokens: 50, costUsd: 0 });
  });

  it("C2: a reservation older than the sweep window becomes a ledger row at its estimate", async () => {
    const { h, k, r } = await setup({ dailyUsd: 0.15 });
    expect((await r(T)).ok).toBe(true);
    expect((await r(T + 1)).ok).toBe(false);
    // swept after an hour, but still charged: the cap stays reached
    expect(await r(T + 60 * MIN + 1)).toEqual({ ok: false, reason: "key_daily" });
    const row = (await h.usageSummary(0)).byKey.find((x) => x.id === k.id);
    expect(row).toMatchObject({ requests: 1, inTokens: 1, outTokens: 1024 });
    expect(row!.costUsd).toBeCloseTo(0.1);
  });

  it("C2: a late settle for a swept reservation records actual usage exactly once", async () => {
    const { h, k, r } = await setup();
    const rid = id(await r(T));
    expect((await r(T + 60 * MIN + 1)).ok).toBe(true); // sweeps rid into the ledger at its estimate
    await h.settle(rid, { inputTokens: 3, outputTokens: 0 }, T + 61 * MIN);
    await h.settle(rid, { inputTokens: 3, outputTokens: 0 }, T + 62 * MIN);
    const row = (await h.usageSummary(0)).byKey.find((x) => x.id === k.id)!;
    expect(row).toMatchObject({ requests: 1, inTokens: 3, outTokens: 0 }); // the second (live) reservation is unsettled
    expect(row.costUsd).toBeCloseTo(0.3);
  });

  it("null account limits mean unlimited", async () => {
    const { r } = await setup({}, { rpm: null, tpm: null, monthlyUsd: null } as unknown as Partial<Account>);
    expect((await r()).ok).toBe(true);
  });

  it("price refresh alarm retries in ~5 minutes when empty, ~24h after success", async () => {
    const h = env.HUB.get(env.HUB.idFromName("alarm-" + crypto.randomUUID()));
    const next = async () =>
      runInDurableObject(h, async (inst: Hub, state) => {
        await inst.alarm();
        return ((await state.storage.getAlarm()) ?? 0) - Date.now();
      });
    const f = vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response("down", { status: 503 }));
    const empty = await next();
    expect(empty).toBeGreaterThan(4 * MIN);
    expect(empty).toBeLessThanOrEqual(5 * MIN);
    f.mockImplementation(async () => Response.json({ data: [{ id: "x/y", pricing: { prompt: "0.000001", completion: "0.000002" } }] }));
    expect(await next()).toBeGreaterThan(23 * 60 * MIN);
    f.mockRestore();
  });

  it("estimateTokens and retryAfterMs", () => {
    expect(estimateTokens({})).toBe(1);
    expect(estimateTokens({ messages: [{ role: "user", content: "x".repeat(400) }] })).toBeGreaterThan(100);
    expect(retryAfterMs(null)).toBe(30_000);
    expect(retryAfterMs("5")).toBe(5000);
    expect(retryAfterMs("99999")).toBe(15 * MIN);
    expect(retryAfterMs(new Date(Date.now() + 60_000).toUTCString())).toBeGreaterThan(50_000);
    expect(retryAfterMs("junk")).toBe(30_000);
  });
});

describe("limits through the proxy", () => {
  afterEach(() => vi.restoreAllMocks());
  const call = async (key: string, model: string) => {
    const ctx = createExecutionContext();
    const res = await app.fetch(
      new Request("http://x/v1/chat/completions", {
        method: "POST",
        headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
        body: JSON.stringify({ model, messages: [{ role: "user", content: "hi" }] }),
      }),
      env,
      ctx,
    );
    await waitOnExecutionContext(ctx);
    return res;
  };
  const acc = (name: string) =>
    mainHub(env).upsertAccount({ kind: "custom-openai", name, authType: "apikey", secret: "s", baseUrl: `https://${name}.example/v1` });
  const upstreamCalls = (f: { mock: { calls: unknown[][] } }) => f.mock.calls.filter((c) => String(c[0]).includes(".example/"));

  it("a $0 daily cap gets 429 limit: key_daily without calling upstream", async () => {
    const h = mainHub(env);
    const a = await acc("lim-cap-acc");
    await h.setPriceOverride("lim-priced", { inPerM: 1, outPerM: 1 });
    await h.upsertCombo({ name: "lim-cap", targets: [{ accountId: a.id, model: "lim-priced" }] });
    const { secret } = await h.createKey({ name: "zero", dailyUsd: 0 });
    const f = vi.spyOn(globalThis, "fetch").mockImplementation(async () => Response.json({}));
    const res = await call(secret, "lim-cap");
    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({ error: { message: "limit: key_daily", type: "rate_limit" } });
    expect(upstreamCalls(f)).toHaveLength(0);
  });

  it("fallback skips a gated first target and bills only the second", async () => {
    const h = mainHub(env);
    const [a, b] = [await acc("lim-fa"), await acc("lim-fb")];
    await h.setCooldown(a.id, Date.now() + 60 * MIN);
    await h.upsertCombo({ name: "lim-fb", targets: [{ accountId: a.id, model: "m" }, { accountId: b.id, model: "m" }] });
    const { secret } = await h.createKey({ name: "fb" });
    const f = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async () => Response.json({ choices: [], usage: { prompt_tokens: 7, completion_tokens: 3 } }));
    expect((await call(secret, "lim-fb")).status).toBe(200);
    expect(upstreamCalls(f).map((c) => String(c[0]))).toEqual(["https://lim-fb.example/v1/chat/completions"]);
    const { byAccount } = await h.usageSummary(0);
    expect(byAccount.find((r) => r.id === a.id)).toBeUndefined();
    expect(byAccount.find((r) => r.id === b.id)).toMatchObject({ requests: 1, inTokens: 7, outTokens: 3 });
  });

  it("a network error on A then a gated B releases A's reservation", async () => {
    const h = mainHub(env);
    const [a, b] = [await acc("lim-la"), await acc("lim-lb")];
    await h.setPriceOverride("lim-leak-m", { inPerM: 100_000, outPerM: 0 }); // $0.10/token; the request estimates 8 tokens = $0.80
    await h.setCooldown(b.id, Date.now() + 60 * MIN);
    await h.upsertCombo({ name: "lim-leak", targets: [{ accountId: a.id, model: "lim-leak-m" }, { accountId: b.id, model: "lim-leak-m" }] });
    const { secret, key } = await h.createKey({ name: "leak", dailyUsd: 1 });
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      throw new Error("net down");
    });
    const res = await call(secret, "lim-leak");
    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({ error: { message: "limit: cooldown", type: "rate_limit" } });
    // $0.50 fits under the $1 cap only if A's $0.80 reservation was released
    expect((await h.reserve({ keyId: key.id, accountId: a.id, model: "lim-leak-m", estTokens: 5, maxOutTokens: 0 })).ok).toBe(true);
  });

  it("an upstream 429 puts the account in cooldown and is not billed", async () => {
    const h = mainHub(env);
    const a = await acc("lim-429");
    const { secret, key } = await h.createKey({ name: "429" });
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response("slow down", { status: 429, headers: { "retry-after": "120" } }));
    expect((await call(secret, "lim-429/m")).status).toBe(429);
    expect(await h.reserve({ keyId: key.id, accountId: a.id, model: "m", estTokens: 1 })).toEqual({ ok: false, reason: "cooldown" });
    expect((await h.usageSummary(0)).byKey.find((r) => r.id === key.id)).toMatchObject({ requests: 1, inTokens: 0, costUsd: 0 });
  });
});
