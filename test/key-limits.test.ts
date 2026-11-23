import { SELF, env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { Hub } from "../src/hub";

const T = Date.UTC(2026, 10, 22, 12);
const MIN = 60_000;
const A = { authorization: "Bearer test-admin", "content-type": "application/json" };

async function setup(key: { rpm?: number | null; maxInFlight?: number | null } = {}) {
  const h = env.HUB.get(env.HUB.idFromName("kl-" + crypto.randomUUID()));
  const { key: k } = await h.createKey({ name: "k", ...key });
  const a = await h.upsertAccount({ kind: "custom-openai", name: "a", authType: "apikey", secret: "s", baseUrl: "https://a.example" });
  const r = (now = T) => h.reserve({ keyId: k.id, accountId: a.id, model: "m", estTokens: 1, now });
  return { h, k, a, r };
}
const rid = (x: any) => x.reservationId as string;

describe("I5: per-key rpm and in-flight limits", () => {
  it("new keys get safe defaults: 30 rpm, 4 in flight", async () => {
    const { k } = await setup();
    expect(k).toMatchObject({ rpm: 30, maxInFlight: 4 });
  });

  it("the 5th concurrent request is refused with key_inflight; settling one frees a slot", async () => {
    const { h, r } = await setup();
    const ids = [];
    for (let i = 0; i < 4; i++) ids.push(rid(await r(T + i)));
    expect(await r(T + 5)).toEqual({ ok: false, reason: "key_inflight" });
    await h.settle(ids[0], { inputTokens: 1, outputTokens: 1 }, T + 6);
    expect((await r(T + 7)).ok).toBe(true);
  });

  it("key rpm counts settled and released requests in the last minute", async () => {
    const { h, r } = await setup({ rpm: 2, maxInFlight: null });
    await h.release(rid(await r(T)), T);
    await h.settle(rid(await r(T + 1)), null, T + 1);
    expect(await r(T + 2)).toEqual({ ok: false, reason: "key_rpm" });
    expect((await r(T + MIN + 2)).ok).toBe(true);
  });

  it("null clears both limits", async () => {
    const { k, r } = await setup({ rpm: null, maxInFlight: null });
    expect(k).toMatchObject({ rpm: null, maxInFlight: null });
    for (let i = 0; i < 40; i++) expect((await r(T + i)).ok).toBe(true);
  });

  it("a shorter cooldown cannot shorten a longer one", async () => {
    const { h, a, r } = await setup();
    await h.setCooldown(a.id, T + 15 * MIN);
    await h.setCooldown(a.id, T + 30_000);
    expect(await r(T + MIN)).toEqual({ ok: false, reason: "cooldown" });
    await h.setCooldown(a.id, T + 20 * MIN); // a longer one still extends it
    expect(await r(T + 16 * MIN)).toEqual({ ok: false, reason: "cooldown" });
  });

  it("migration: keys created before the columns existed get the safe defaults, once", async () => {
    const stub = env.HUB.get(env.HUB.idFromName("kl-mig-" + crypto.randomUUID()));
    const out = await runInDurableObject(stub, async (inst: Hub, state) => {
      const sql = state.storage.sql;
      // Rebuild the pre-migration shape: no rpm/max_inflight columns, schema version 0.
      sql.exec("ALTER TABLE keys DROP COLUMN rpm");
      sql.exec("ALTER TABLE keys DROP COLUMN max_inflight");
      sql.exec("DELETE FROM meta");
      sql.exec("INSERT INTO keys (id, name, hash) VALUES ('old', 'old', 'h')");
      inst.migrate();
      inst.migrate(); // idempotent
      return (await inst.listKeys())[0];
    });
    expect(out).toMatchObject({ id: "old", rpm: 30, maxInFlight: 4 });
  });

  it("admin API validates and can raise or clear the limits", async () => {
    const post = (b: object) => SELF.fetch("http://x/admin/keys", { method: "POST", headers: A, body: JSON.stringify({ name: "kl", ...b }) });
    for (const x of [{ rpm: 1.5 }, { rpm: -1 }, { maxInFlight: "4" }]) expect((await post(x)).status).toBe(400);
    const { key } = (await (await post({ rpm: null, maxInFlight: 10 })).json()) as any;
    expect(key).toMatchObject({ rpm: null, maxInFlight: 10 });
    const patch = (b: object) => SELF.fetch(`http://x/admin/keys/${key.id}`, { method: "PATCH", headers: A, body: JSON.stringify(b) });
    expect((await (await patch({ rpm: 120, maxInFlight: null })).json()) as any).toMatchObject({ rpm: 120, maxInFlight: null });
    expect((await patch({ rpm: "x" })).status).toBe(400);
    expect((await SELF.fetch("http://x/admin/keys/nope", { method: "PATCH", headers: A, body: "{}" })).status).toBe(404);
  });
});

describe("I7: ledger indexes and schema version", () => {
  it("ledger has (key_id, ts) and (account_id, ts) indexes; meta records the schema version", async () => {
    const stub = env.HUB.get(env.HUB.idFromName("idx-" + crypto.randomUUID()));
    const { idx, v } = await runInDurableObject(stub, async (_i, state) => ({
      idx: state.storage.sql.exec<{ name: string; sql: string }>("SELECT name, sql FROM sqlite_master WHERE type = 'index' AND tbl_name = 'ledger'").toArray(),
      v: state.storage.sql.exec<{ v: number }>("SELECT v FROM meta WHERE k = 'schema'").one().v,
    }));
    const by = Object.fromEntries(idx.map((r) => [r.name, r.sql.replace(/\s+/g, " ")]));
    expect(by.ledger_key_ts).toMatch(/ON ledger ?\(key_id, ts\)/);
    expect(by.ledger_acct_ts).toMatch(/ON ledger ?\(account_id, ts\)/);
    expect(v).toBeGreaterThanOrEqual(1);
  });
});
