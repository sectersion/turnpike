import { env, SELF } from "cloudflare:test";
import { expect, it } from "vitest";
import { hub } from "../src/hub-client";

const call = (path: string, ip: string, token = env.ADMIN_TOKEN as string, init: RequestInit = {}) =>
  SELF.fetch("http://x/admin" + path, { ...init, headers: { authorization: `Bearer ${token}`, "cf-connecting-ip": ip, ...(init.headers as object) } });

it("locks an IP out of /admin after 10 failures, and others stay unaffected", async () => {
  const ip = "203.0.113." + Math.floor(Math.random() * 200);
  for (let i = 0; i < 10; i++) expect((await call("/keys", ip, "wrong")).status).toBe(401);
  const locked = await call("/keys", ip); // even the right token is refused while locked
  expect(locked.status).toBe(429);
  expect(locked.headers.get("retry-after")).toBe("60");
  expect((await call("/keys", "198.51.100.7")).status).toBe(200);
});

it("lockout expires after the window", async () => {
  const h = hub(env);
  const ip = "192.0.2." + Math.floor(Math.random() * 200);
  const t0 = Date.now() - 120_000;
  for (let i = 0; i < 10; i++) await h.adminFailed(ip, t0);
  expect(await h.adminLocked(ip, t0 + 1000)).toBe(true);
  expect(await h.adminLocked(ip)).toBe(false);
});

it("export redacts provider secrets and keeps key hashes", async () => {
  const h = hub(env);
  const tag = crypto.randomUUID().slice(0, 8);
  await h.upsertAccount({ kind: "custom-openai", name: "ex" + tag, authType: "apikey", secret: "sk-very-secret-" + tag, baseUrl: "https://ex.example/v1" });
  await h.createKey({ name: "ex" + tag });
  const res = await call("/export?ledger=0", "198.51.100.8");
  expect(res.status).toBe(200);
  expect(res.headers.get("content-disposition")).toContain("turnpike-backup-");
  const text = await res.text();
  expect(text).not.toContain("sk-very-secret-");
  const j = JSON.parse(text);
  expect(j.accounts.some((a: any) => a.name === "ex" + tag && a.secret === "***")).toBe(true);
  expect(j.keys.find((k: any) => k.name === "ex" + tag).hash).toMatch(/^[0-9a-f]{64}$/);
  expect(j.ledger).toBeUndefined();
});

it("pruneLedger deletes only rows older than the retention window; combos can be deleted", async () => {
  const h = hub(env);
  const { key } = await h.createKey({ name: "prune" });
  const old = Date.now() - 500 * 86_400_000;
  const r = await h.reserve({ keyId: key.id, accountId: "acct-prune", model: "mp", estTokens: 1, now: old });
  if (!r.ok) throw new Error("reserve refused");
  await h.settle(r.reservationId, { inputTokens: 1, outputTokens: 1 }, old);
  expect((await h.usageSeries(old - 1000, old + 1000, 3_600_000)).length).toBe(1);
  await h.pruneLedger();
  expect((await h.usageSeries(old - 1000, old + 1000, 3_600_000)).length).toBe(0);

  await h.upsertCombo({ name: "gone", targets: [{ accountId: "a", model: "m" }] });
  expect((await call("/combos/gone", "198.51.100.9", undefined, { method: "DELETE" })).status).toBe(200);
  expect((await call("/combos/gone", "198.51.100.9", undefined, { method: "DELETE" })).status).toBe(404);
});
