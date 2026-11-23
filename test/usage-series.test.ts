import { env, SELF } from "cloudflare:test";
import { expect, it } from "vitest";
import { hub } from "../src/hub-client";

const admin = (path: string) => SELF.fetch("http://x/admin" + path, { headers: { authorization: `Bearer ${env.ADMIN_TOKEN}` } });

it("usageSeries buckets ledger rows by hour and usageSummary groups by model", async () => {
  const h = hub(env);
  const { key } = await h.createKey({ name: "series", allowedAccountIds: [] });
  const H = 3_600_000;
  const base = Math.floor(Date.now() / H) * H - 10 * H; // a window no other test writes to
  const rec = async (ts: number, model: string, inT: number) => {
    const r = await h.reserve({ keyId: key.id, accountId: "acct-series", model, estTokens: 1, now: ts });
    if (!r.ok) throw new Error("reserve refused");
    await h.settle(r.reservationId, { inputTokens: inT, outputTokens: 1 }, ts);
  };
  await rec(base + 5, "ma", 10);
  await rec(base + 9, "mb", 20);
  await rec(base + H + 1, "ma", 40);
  const s = await h.usageSeries(base, base + 2 * H, H);
  expect(s.map((r) => [r.t, r.requests, r.inTokens])).toEqual([[base, 2, 30], [base + H, 1, 40]]);
  const m = (await h.usageSummary(base)).byModel.filter((r) => r.id === "ma" || r.id === "mb");
  expect(m.map((r) => [r.id, r.requests])).toEqual([["ma", 2], ["mb", 1]]);
  const ok = await admin(`/usage/series?since=${base}&until=${base + 2 * H}&bucket=${H}`);
  expect(ok.status).toBe(200);
  expect((await admin(`/usage/series?since=0&bucket=${H}`)).status).toBe(400);
  expect((await admin(`/usage/series?since=${base}&bucket=5`)).status).toBe(400);
});
