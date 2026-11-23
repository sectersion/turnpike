import { DurableObject } from "cloudflare:workers";
import { newSecret, sha256Hex } from "./crypto";
import { costUsd, priceFor, refreshOpenRouterPrices, type Price } from "./pricing";
import type { Account, AccountKind, Combo, RouterKey } from "./types";
import type { Env } from "./env";

export type LimitReason = "key_daily" | "key_monthly" | "account_monthly" | "rpm" | "tpm" | "cooldown" | "unpriced";
export type UsageRow = { id: string; requests: number; inTokens: number; outTokens: number; costUsd: number };
type PriceRow = { model: string; in_per_m: number; out_per_m: number };
type ResRow = {
  id: string;
  key_id: string;
  account_id: string;
  model: string;
  ts: number;
  est_tokens: number;
  est_out: number;
  est_cost_usd: number;
  priced: number;
};

const MINUTE = 60_000;
const LEAK_MS = 10 * MINUTE;
const DAY = 86_400_000;
const RETRY_MS = 5 * MINUTE; // empty price cache after a failed refresh
const SUBSCRIPTION = new Set<AccountKind>(["claude-oauth", "codex-oauth", "copilot-oauth"]);

type KeyRow = {
  id: string;
  name: string;
  daily_usd: number | null;
  monthly_usd: number | null;
  allowed: string | null;
  revoked: number;
};

const toKey = (r: KeyRow): RouterKey => ({
  id: r.id,
  name: r.name,
  dailyUsd: r.daily_usd,
  monthlyUsd: r.monthly_usd,
  allowedAccountIds: r.allowed === null ? null : JSON.parse(r.allowed),
  revoked: r.revoked === 1,
});

const KEY_COLS = "id, name, daily_usd, monthly_usd, allowed, revoked";

export class Hub extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      this.sql.exec(`
        CREATE TABLE IF NOT EXISTS keys (
          id TEXT PRIMARY KEY, name TEXT NOT NULL, hash TEXT NOT NULL UNIQUE,
          daily_usd REAL, monthly_usd REAL, allowed TEXT, revoked INTEGER NOT NULL DEFAULT 0);
        CREATE TABLE IF NOT EXISTS accounts (id TEXT PRIMARY KEY, data TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS combos (name TEXT PRIMARY KEY, targets TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS ledger (
          ts INTEGER NOT NULL, key_id TEXT NOT NULL, account_id TEXT NOT NULL, model TEXT NOT NULL,
          in_tokens INTEGER NOT NULL, out_tokens INTEGER NOT NULL, cost_usd REAL NOT NULL, priced INTEGER NOT NULL);
        CREATE INDEX IF NOT EXISTS ledger_ts ON ledger (ts);
        CREATE TABLE IF NOT EXISTS reservations (
          id TEXT PRIMARY KEY, key_id TEXT NOT NULL, account_id TEXT NOT NULL, model TEXT NOT NULL, ts INTEGER NOT NULL,
          est_tokens INTEGER NOT NULL, est_out INTEGER NOT NULL, est_cost_usd REAL NOT NULL, priced INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS cooldowns (account_id TEXT PRIMARY KEY, until_ms INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS prices (model TEXT PRIMARY KEY, in_per_m REAL NOT NULL, out_per_m REAL NOT NULL);
        CREATE TABLE IF NOT EXISTS price_overrides (model TEXT PRIMARY KEY, in_per_m REAL NOT NULL, out_per_m REAL NOT NULL);`);
      this.orTable = this.priceTable("prices");
    });
  }

  private orTable: Record<string, Price> = {};
  private alarmChecked = false;

  private priceTable(t: "prices" | "price_overrides"): Record<string, Price> {
    const out: Record<string, Price> = {};
    for (const r of this.sql.exec<PriceRow>(`SELECT model, in_per_m, out_per_m FROM ${t}`))
      out[r.model] = { inPerM: r.in_per_m, outPerM: r.out_per_m };
    return out;
  }

  // Daily OpenRouter refresh; the first one runs immediately while the cache is empty.
  async alarm(): Promise<void> {
    try {
      const t = await refreshOpenRouterPrices();
      if (Object.keys(t).length) {
        this.ctx.storage.transactionSync(() => {
          this.sql.exec("DELETE FROM prices");
          for (const [m, p] of Object.entries(t)) this.sql.exec("INSERT INTO prices VALUES (?, ?, ?)", m, p.inPerM, p.outPerM);
        });
        this.orTable = t;
      }
    } catch {}
    await this.ctx.storage.setAlarm(Date.now() + (Object.keys(this.orTable).length ? DAY : RETRY_MS));
  }

  async setPriceOverride(model: string, p: Price): Promise<void> {
    this.sql.exec("INSERT OR REPLACE INTO price_overrides VALUES (?, ?, ?)", model, p.inPerM, p.outPerM);
  }

  async setCooldown(accountId: string, untilMs: number): Promise<void> {
    this.sql.exec("INSERT OR REPLACE INTO cooldowns VALUES (?, ?)", accountId, untilMs);
  }

  async reserve(i: { keyId: string; accountId: string; model: string; estTokens: number; maxOutTokens?: number; now?: number }): Promise<
    { ok: true; reservationId: string } | { ok: false; reason: LimitReason }
  > {
    if (!this.alarmChecked) {
      this.alarmChecked = true;
      if ((await this.ctx.storage.getAlarm()) === null)
        await this.ctx.storage.setAlarm(Date.now() + (Object.keys(this.orTable).length ? DAY : 0));
    }
    // Everything below is synchronous SQL: no await between the checks and the insert, so the DO's
    // single-threading makes check-and-reserve atomic.
    const now = i.now ?? Date.now();
    const estIn = Math.max(0, Math.ceil(i.estTokens) || 0);
    const estOut = typeof i.maxOutTokens === "number" && i.maxOutTokens >= 0 ? Math.ceil(i.maxOutTokens) : 1024;
    this.sql.exec("DELETE FROM reservations WHERE ts < ?", now - LEAK_MS);
    const num = (q: string, ...b: unknown[]) => (this.sql.exec<{ n: number | null }>(q, ...b).one().n ?? 0);

    const cd = this.sql.exec<{ until_ms: number }>("SELECT until_ms FROM cooldowns WHERE account_id = ?", i.accountId).toArray()[0];
    if (cd && cd.until_ms > now) return { ok: false, reason: "cooldown" };

    const acc = this.accountSync(i.accountId);
    const since = now - MINUTE;
    if (acc?.rpm != null) {
      const n =
        num("SELECT COUNT(*) AS n FROM ledger WHERE account_id = ? AND ts > ?", i.accountId, since) +
        num("SELECT COUNT(*) AS n FROM reservations WHERE account_id = ? AND ts > ?", i.accountId, since);
      if (n + 1 > acc.rpm) return { ok: false, reason: "rpm" };
    }
    if (acc?.tpm != null) {
      const n =
        num("SELECT SUM(in_tokens + out_tokens) AS n FROM ledger WHERE account_id = ? AND ts > ?", i.accountId, since) +
        num("SELECT SUM(est_tokens) AS n FROM reservations WHERE account_id = ? AND ts > ?", i.accountId, since);
      if (n + estIn > acc.tpm) return { ok: false, reason: "tpm" };
    }

    const key = this.sql.exec<KeyRow>(`SELECT ${KEY_COLS} FROM keys WHERE id = ?`, i.keyId).toArray()[0];
    const sub = acc ? SUBSCRIPTION.has(acc.kind) : false;
    const price = sub ? null : priceFor(i.model, this.priceTable("price_overrides"), this.orTable);
    if (!sub && !price && key && (key.daily_usd !== null || key.monthly_usd !== null)) return { ok: false, reason: "unpriced" };
    const est = price ? costUsd(price, estIn, estOut) : 0;

    const d = new Date(now);
    const dayStart = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
    const monthStart = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
    const spend = (col: "key_id" | "account_id", id: string, from: number) =>
      num(`SELECT SUM(cost_usd) AS n FROM ledger WHERE ${col} = ? AND ts >= ?`, id, from) +
      num(`SELECT SUM(est_cost_usd) AS n FROM reservations WHERE ${col} = ?`, id) +
      est;
    if (key?.daily_usd != null && spend("key_id", i.keyId, dayStart) > key.daily_usd) return { ok: false, reason: "key_daily" };
    if (key?.monthly_usd != null && spend("key_id", i.keyId, monthStart) > key.monthly_usd) return { ok: false, reason: "key_monthly" };
    if (acc?.monthlyUsd != null && spend("account_id", i.accountId, monthStart) > acc.monthlyUsd)
      return { ok: false, reason: "account_monthly" };

    const id = crypto.randomUUID();
    this.sql.exec(
      "INSERT INTO reservations VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      id, i.keyId, i.accountId, i.model, now, estIn, estOut, est, sub || price ? 1 : 0,
    );
    return { ok: true, reservationId: id };
  }

  // Idempotent: an unknown or already-settled id is a no-op.
  async settle(reservationId: string, u: { inputTokens: number; outputTokens: number } | null, now = Date.now()): Promise<void> {
    const r = this.takeReservation(reservationId);
    if (!r) return;
    const acc = this.accountSync(r.account_id);
    const price = acc && SUBSCRIPTION.has(acc.kind) ? null : priceFor(r.model, this.priceTable("price_overrides"), this.orTable);
    const [inT, outT] = u ? [u.inputTokens, u.outputTokens] : [r.est_tokens, r.est_out];
    const cost = u ? (price ? costUsd(price, inT, outT) : 0) : r.est_cost_usd;
    this.sql.exec("INSERT INTO ledger VALUES (?, ?, ?, ?, ?, ?, ?, ?)", now, r.key_id, r.account_id, r.model, inT, outT, cost, r.priced);
  }

  // Drops the reservation without charging; a zero row keeps the request counted toward rpm.
  async release(reservationId: string, now = Date.now()): Promise<void> {
    const r = this.takeReservation(reservationId);
    if (r) this.sql.exec("INSERT INTO ledger VALUES (?, ?, ?, ?, 0, 0, 0, ?)", now, r.key_id, r.account_id, r.model, r.priced);
  }

  async usageSummary(sinceMs: number): Promise<{ byKey: UsageRow[]; byAccount: UsageRow[] }> {
    const by = (col: "key_id" | "account_id") =>
      this.sql
        .exec<UsageRow>(
          `SELECT ${col} AS id, COUNT(*) AS requests, SUM(in_tokens) AS inTokens, SUM(out_tokens) AS outTokens, SUM(cost_usd) AS costUsd
           FROM ledger WHERE ts >= ? GROUP BY ${col} ORDER BY ${col}`,
          sinceMs,
        )
        .toArray()
        .map((r) => ({ ...r }));
    return { byKey: by("key_id"), byAccount: by("account_id") };
  }

  private takeReservation(id: string) {
    return this.sql.exec<ResRow>("DELETE FROM reservations WHERE id = ? RETURNING *", id).toArray()[0];
  }

  private accountSync(id: string): Account | null {
    const r = this.sql.exec<{ data: string }>("SELECT data FROM accounts WHERE id = ?", id).toArray()[0];
    return r ? JSON.parse(r.data) : null;
  }

  private get sql() {
    return this.ctx.storage.sql;
  }

  async createKey(i: {
    name: string;
    dailyUsd?: number;
    monthlyUsd?: number;
    allowedAccountIds?: string[];
  }): Promise<{ key: RouterKey; secret: string }> {
    const secret = newSecret("tpk");
    const id = crypto.randomUUID();
    this.sql.exec(
      "INSERT INTO keys (id, name, hash, daily_usd, monthly_usd, allowed) VALUES (?, ?, ?, ?, ?, ?)",
      id,
      i.name,
      await sha256Hex(secret),
      i.dailyUsd ?? null,
      i.monthlyUsd ?? null,
      i.allowedAccountIds ? JSON.stringify(i.allowedAccountIds) : null,
    );
    const key = toKey(this.sql.exec<KeyRow>(`SELECT ${KEY_COLS} FROM keys WHERE id = ?`, id).one());
    return { key, secret };
  }

  async resolveKey(secret: string): Promise<RouterKey | null> {
    const r = this.sql
      .exec<KeyRow>(`SELECT ${KEY_COLS} FROM keys WHERE hash = ? AND revoked = 0`, await sha256Hex(secret))
      .toArray()[0];
    return r ? toKey(r) : null;
  }

  async listKeys(): Promise<RouterKey[]> {
    return this.sql.exec<KeyRow>(`SELECT ${KEY_COLS} FROM keys ORDER BY rowid`).toArray().map(toKey);
  }

  async revokeKey(id: string): Promise<void> {
    this.sql.exec("UPDATE keys SET revoked = 1 WHERE id = ?", id);
  }

  async upsertAccount(a: Omit<Account, "id" | "enabled"> & { id?: string; enabled?: boolean }): Promise<Account> {
    const acc: Account = { ...a, id: a.id ?? crypto.randomUUID(), enabled: a.enabled ?? true };
    this.sql.exec("INSERT OR REPLACE INTO accounts (id, data) VALUES (?, ?)", acc.id, JSON.stringify(acc));
    return acc;
  }

  async listAccounts(redact: boolean): Promise<Account[]> {
    return this.sql
      .exec<{ data: string }>("SELECT data FROM accounts ORDER BY rowid")
      .toArray()
      .map((r) => {
        const a: Account = JSON.parse(r.data);
        return redact ? { ...a, secret: "***" } : a;
      });
  }

  async getAccount(id: string): Promise<Account | null> {
    return this.accountSync(id);
  }

  async deleteAccount(id: string): Promise<void> {
    this.sql.exec("DELETE FROM accounts WHERE id = ?", id);
  }

  async upsertCombo(c: Combo): Promise<void> {
    this.sql.exec("INSERT OR REPLACE INTO combos (name, targets) VALUES (?, ?)", c.name, JSON.stringify(c.targets));
  }

  async listCombos(): Promise<Combo[]> {
    return this.sql
      .exec<{ name: string; targets: string }>("SELECT name, targets FROM combos ORDER BY rowid")
      .toArray()
      .map((r) => ({ name: r.name, targets: JSON.parse(r.targets) }));
  }
}
