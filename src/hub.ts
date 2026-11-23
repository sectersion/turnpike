import { DurableObject } from "cloudflare:workers";
import { newSecret, sha256Hex } from "./crypto";
import { costUsd, priceFor, refreshOpenRouterPrices, type Price } from "./pricing";
import type { Account, AccountKind, Combo, RouterKey } from "./types";
import type { Env } from "./env";
import type { Usage } from "./usage";
import { getProvider, type OAuthTokens } from "./oauth";
import { DEFAULT_OUT, MAX_OUT } from "./providers";

export type LimitReason =
  | "key_daily" | "key_monthly" | "key_rpm" | "key_inflight" | "account_monthly" | "rpm" | "tpm" | "cooldown" | "unpriced";
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
const LEAK_MS = 60 * MINUTE; // a reservation this old is charged at its estimate (the request may still be running)
const SWEPT_KEEP_MS = 24 * 60 * MINUTE; // how long a late settle may still correct a swept reservation
const DAY = 86_400_000;
const RETRY_MS = 5 * MINUTE; // empty price cache after a failed refresh
const SKEW_MS = 60_000; // refresh OAuth tokens this long before they expire
const RETRY_COOLDOWN_MS = MINUTE; // refresh failed on network/5xx
const REJECTED_COOLDOWN_MS = 15 * MINUTE; // refresh rejected (400/401-style)
// Safe per-key defaults for new keys (and for keys that existed before these limits); null = unlimited.
export const DEFAULT_KEY_RPM = 30;
export const DEFAULT_KEY_INFLIGHT = 4;
const MIN_OUT = 256; // below this many affordable output tokens a capped request is refused
const SUBSCRIPTION = new Set<AccountKind>(["codex-oauth", "copilot-oauth"]);

type KeyRow = {
  id: string;
  name: string;
  daily_usd: number | null;
  monthly_usd: number | null;
  allowed: string | null;
  revoked: number;
  rpm: number | null;
  max_inflight: number | null;
};

const toKey = (r: KeyRow): RouterKey => ({
  id: r.id,
  name: r.name,
  dailyUsd: r.daily_usd,
  monthlyUsd: r.monthly_usd,
  allowedAccountIds: r.allowed === null ? null : JSON.parse(r.allowed),
  revoked: r.revoked === 1,
  rpm: r.rpm,
  maxInFlight: r.max_inflight,
});

const KEY_COLS = "id, name, daily_usd, monthly_usd, allowed, revoked, rpm, max_inflight";

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
        CREATE INDEX IF NOT EXISTS ledger_key_ts ON ledger (key_id, ts);
        CREATE INDEX IF NOT EXISTS ledger_acct_ts ON ledger (account_id, ts);
        CREATE TABLE IF NOT EXISTS reservations (
          id TEXT PRIMARY KEY, key_id TEXT NOT NULL, account_id TEXT NOT NULL, model TEXT NOT NULL, ts INTEGER NOT NULL,
          est_tokens INTEGER NOT NULL, est_out INTEGER NOT NULL, est_cost_usd REAL NOT NULL, priced INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS swept (id TEXT PRIMARY KEY, ledger_rowid INTEGER NOT NULL, ts INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS cooldowns (account_id TEXT PRIMARY KEY, until_ms INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS prices (model TEXT PRIMARY KEY, in_per_m REAL NOT NULL, out_per_m REAL NOT NULL);
        CREATE TABLE IF NOT EXISTS price_overrides (model TEXT PRIMARY KEY, in_per_m REAL NOT NULL, out_per_m REAL NOT NULL);
        CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v INTEGER NOT NULL);`);
      this.migrate();
      this.orTable = this.priceTable("prices");
    });
  }

  // Versioned schema changes, each run once in a transaction. DO SQLite refuses PRAGMA user_version
  // (SQLITE_AUTH), so the version lives in meta. Append steps; never edit a shipped one.
  migrate(): void {
    const steps: (() => void)[] = [
      // 1: per-key rpm / in-flight limits; keys that already exist get the safe defaults.
      () => {
        this.sql.exec("ALTER TABLE keys ADD COLUMN rpm INTEGER; ALTER TABLE keys ADD COLUMN max_inflight INTEGER");
        this.sql.exec("UPDATE keys SET rpm = ?, max_inflight = ?", DEFAULT_KEY_RPM, DEFAULT_KEY_INFLIGHT);
      },
    ];
    const v = this.sql.exec<{ v: number }>("SELECT v FROM meta WHERE k = 'schema'").toArray()[0]?.v ?? 0;
    for (let i = v; i < steps.length; i++)
      this.ctx.storage.transactionSync(() => {
        steps[i]();
        this.sql.exec("INSERT OR REPLACE INTO meta VALUES ('schema', ?)", i + 1);
      });
  }

  private orTable: Record<string, Price> = {};
  private alarmChecked = false;
  private refreshing = new Map<string, Promise<OAuthTokens>>();

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
    // Keep the later end: a short cooldown never cuts a longer one short.
    this.sql.exec(
      "INSERT INTO cooldowns VALUES (?, ?) ON CONFLICT(account_id) DO UPDATE SET until_ms = MAX(until_ms, excluded.until_ms)",
      accountId,
      untilMs,
    );
  }

  async reserve(i: { keyId: string; accountId: string; model: string; estTokens: number; maxOutTokens?: number; now?: number }): Promise<
    { ok: true; reservationId: string; maxOut: number } | { ok: false; reason: LimitReason }
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
    let estOut = typeof i.maxOutTokens === "number" && i.maxOutTokens >= 0 ? Math.min(Math.ceil(i.maxOutTokens), MAX_OUT) : DEFAULT_OUT;
    this.sweep(now);
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
    if (key?.rpm != null) {
      const n =
        num("SELECT COUNT(*) AS n FROM ledger WHERE key_id = ? AND ts > ?", i.keyId, since) +
        num("SELECT COUNT(*) AS n FROM reservations WHERE key_id = ? AND ts > ?", i.keyId, since);
      if (n + 1 > key.rpm) return { ok: false, reason: "key_rpm" };
    }
    if (key?.max_inflight != null && num("SELECT COUNT(*) AS n FROM reservations WHERE key_id = ?", i.keyId) + 1 > key.max_inflight)
      return { ok: false, reason: "key_inflight" };
    const sub = acc ? SUBSCRIPTION.has(acc.kind) : false;
    const price = sub ? null : priceFor(i.model, this.priceTable("price_overrides"), this.orTable);
    if (!sub && !price && key && (key.daily_usd !== null || key.monthly_usd !== null)) return { ok: false, reason: "unpriced" };
    const d = new Date(now);
    const dayStart = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
    const monthStart = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
    const spent = (col: "key_id" | "account_id", id: string, from: number) =>
      num(`SELECT SUM(cost_usd) AS n FROM ledger WHERE ${col} = ? AND ts >= ?`, id, from) +
      num(`SELECT SUM(est_cost_usd) AS n FROM reservations WHERE ${col} = ?`, id);
    const caps: [number | null | undefined, () => number, LimitReason][] = [
      [key?.daily_usd, () => spent("key_id", i.keyId, dayStart), "key_daily"],
      [key?.monthly_usd, () => spent("key_id", i.keyId, monthStart), "key_monthly"],
      [acc?.monthlyUsd, () => spent("account_id", i.accountId, monthStart), "account_monthly"],
    ];
    for (const [cap, spentFn, reason] of caps) {
      if (cap == null) continue;
      const left = cap - spentFn();
      // Clamp the output so this request's worst case fits what is left of the cap.
      if (price && price.outPerM > 0) {
        const afford = Math.floor(((left - costUsd(price, estIn, 0)) * 1e6) / price.outPerM);
        if (afford < Math.min(MIN_OUT, estOut)) return { ok: false, reason };
        estOut = Math.min(estOut, afford);
      }
      if ((price ? costUsd(price, estIn, estOut) : 0) > left + 1e-9) return { ok: false, reason };
    }
    const est = price ? costUsd(price, estIn, estOut) : 0;

    const id = crypto.randomUUID();
    this.sql.exec(
      "INSERT INTO reservations VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      id, i.keyId, i.accountId, i.model, now, estIn, estOut, est, sub || price ? 1 : 0,
    );
    return { ok: true, reservationId: id, maxOut: estOut };
  }

  // Stale reservations (request still running past LEAK_MS, or its settle never arrived) are charged at
  // their estimate, never dropped; `swept` remembers the row so a late settle can replace it once.
  private sweep(now: number) {
    for (const r of this.sql.exec<ResRow>("DELETE FROM reservations WHERE ts < ? RETURNING *", now - LEAK_MS).toArray()) {
      const row = this.sql
        .exec<{ id: number }>(
          "INSERT INTO ledger VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING rowid AS id",
          r.ts, r.key_id, r.account_id, r.model, r.est_tokens, r.est_out, r.est_cost_usd, r.priced,
        )
        .one();
      this.sql.exec("INSERT OR REPLACE INTO swept VALUES (?, ?, ?)", r.id, row.id, r.ts);
    }
    this.sql.exec("DELETE FROM swept WHERE ts < ?", now - SWEPT_KEEP_MS);
  }

  private costOf(accountId: string, model: string, u: Usage): { inT: number; cost: number } {
    const acc = this.accountSync(accountId);
    const price = acc && SUBSCRIPTION.has(acc.kind) ? null : priceFor(model, this.priceTable("price_overrides"), this.orTable);
    const cw = u.cacheWriteTokens ?? 0, cr = u.cacheReadTokens ?? 0;
    return { inT: u.inputTokens + cw + cr, cost: price ? costUsd(price, u.inputTokens, u.outputTokens, cw, cr) : 0 };
  }

  // Idempotent: an unknown or already-settled id is a no-op. A swept reservation's estimate row is
  // replaced by the actual usage (once).
  async settle(reservationId: string, u: Usage | null, now = Date.now()): Promise<void> {
    const r = this.takeReservation(reservationId);
    if (!r) {
      const s = this.sql.exec<{ ledger_rowid: number }>("DELETE FROM swept WHERE id = ? RETURNING ledger_rowid", reservationId).toArray()[0];
      if (!s || !u) return;
      const row = this.sql.exec<{ account_id: string; model: string }>("SELECT account_id, model FROM ledger WHERE rowid = ?", s.ledger_rowid).toArray()[0];
      if (!row) return;
      const { inT, cost } = this.costOf(row.account_id, row.model, u);
      this.sql.exec("UPDATE ledger SET in_tokens = ?, out_tokens = ?, cost_usd = ? WHERE rowid = ?", inT, u.outputTokens, cost, s.ledger_rowid);
      return;
    }
    const { inT, cost } = u ? this.costOf(r.account_id, r.model, u) : { inT: r.est_tokens, cost: r.est_cost_usd };
    const outT = u ? u.outputTokens : r.est_out;
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
    rpm?: number | null; // undefined: DEFAULT_KEY_RPM; null: unlimited
    maxInFlight?: number | null;
  }): Promise<{ key: RouterKey; secret: string }> {
    const secret = newSecret("tpk");
    const id = crypto.randomUUID();
    this.sql.exec(
      "INSERT INTO keys (id, name, hash, daily_usd, monthly_usd, allowed, rpm, max_inflight) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      id,
      i.name,
      await sha256Hex(secret),
      i.dailyUsd ?? null,
      i.monthlyUsd ?? null,
      i.allowedAccountIds ? JSON.stringify(i.allowedAccountIds) : null,
      i.rpm === undefined ? DEFAULT_KEY_RPM : i.rpm,
      i.maxInFlight === undefined ? DEFAULT_KEY_INFLIGHT : i.maxInFlight,
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

  // null clears a limit; undefined leaves it.
  async patchKey(id: string, f: { rpm?: number | null; maxInFlight?: number | null }): Promise<RouterKey | null> {
    if (f.rpm !== undefined) this.sql.exec("UPDATE keys SET rpm = ? WHERE id = ?", f.rpm, id);
    if (f.maxInFlight !== undefined) this.sql.exec("UPDATE keys SET max_inflight = ? WHERE id = ?", f.maxInFlight, id);
    const r = this.sql.exec<KeyRow>(`SELECT ${KEY_COLS} FROM keys WHERE id = ?`, id).toArray()[0];
    return r ? toKey(r) : null;
  }

  async revokeKey(id: string): Promise<void> {
    this.sql.exec("UPDATE keys SET revoked = 1 WHERE id = ?", id);
  }

  async upsertAccount(a: Omit<Account, "id" | "enabled"> & { id?: string; enabled?: boolean }): Promise<Account> {
    const acc: Account = { ...a, id: a.id ?? crypto.randomUUID(), enabled: a.enabled ?? true };
    this.sql.exec("INSERT OR REPLACE INTO accounts (id, data) VALUES (?, ?)", acc.id, JSON.stringify(acc));
    return acc;
  }

  // Read-merge-write with no await in between, so it cannot interleave with a token rotation.
  // Only whitelisted fields are applied; null clears one. secret/id/kind/authType are never touched.
  async patchAccount(
    id: string,
    f: Partial<Record<"enabled" | "name" | "baseUrl" | "rpm" | "tpm" | "monthlyUsd", unknown>>,
  ): Promise<{ account: Account } | { error: string }> {
    const cur = this.accountSync(id);
    if (!cur) return { error: "not found" };
    const next: Account = { ...cur };
    if (typeof f.enabled === "boolean") next.enabled = f.enabled;
    if (typeof f.name === "string" && f.name.trim()) next.name = f.name.trim();
    for (const k of ["rpm", "tpm", "monthlyUsd"] as const) {
      if (f[k] === null) delete next[k];
      else if (typeof f[k] === "number") next[k] = f[k] as number;
    }
    if (f.baseUrl === null) {
      if (cur.kind === "custom-openai" || cur.kind === "custom-anthropic") return { error: "baseUrl required for custom kinds" };
      delete next.baseUrl;
    } else if (typeof f.baseUrl === "string") next.baseUrl = f.baseUrl;
    this.sql.exec("UPDATE accounts SET data = ? WHERE id = ?", JSON.stringify(next), id);
    return { account: next };
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

  // Only headers cross the RPC boundary, never the stored (long-lived) tokens.
  async getAuthHeaders(accountId: string): Promise<Record<string, string>> {
    const provider = getProvider(this.accountSync(accountId)?.kind ?? "");
    if (!provider) throw new Error("oauth executor not implemented");
    return provider.headers(await this.getFreshToken(accountId));
  }

  // Single-flight per account; rotated tokens are written before any caller sees them. The write is
  // a compare-and-swap on refreshToken, so an edit made during the refresh wins. A failed refresh
  // leaves the stored tokens untouched and cools the account down. Never log tokens here.
  async getFreshToken(accountId: string): Promise<OAuthTokens> {
    const acc = this.accountSync(accountId);
    const t = acc?.secret;
    if (!acc || acc.authType !== "oauth" || typeof t !== "object" || !("accessToken" in t)) throw new Error("not an oauth account");
    if (t.expiresAt === undefined || t.expiresAt - SKEW_MS > Date.now()) return t;
    const inflight = this.refreshing.get(accountId);
    if (inflight) return inflight;
    const p = (async () => {
      const provider = getProvider(acc.kind);
      if (!provider) throw new Error(`no oauth provider for ${acc.kind}`);
      let next: OAuthTokens;
      try {
        next = await provider.refresh(t);
      } catch (e) {
        // A 4xx (bar 429) means the grant was rejected: retrying soon won't help.
        const s = (e as { status?: unknown }).status;
        const rejected = typeof s === "number" && s >= 400 && s < 500 && s !== 429;
        await this.setCooldown(accountId, Date.now() + (rejected ? REJECTED_COOLDOWN_MS : RETRY_COOLDOWN_MS));
        throw new Error(`token refresh failed for account ${accountId}: ${e instanceof Error ? e.message : String(e)}`);
      }
      const cur = this.accountSync(accountId); // re-read: don't clobber edits made during the refresh
      if (!cur) return next;
      const s = cur.secret;
      if (typeof s !== "object" || !("accessToken" in s)) throw new Error("account changed during token refresh");
      if (s.refreshToken !== t.refreshToken) return s;
      this.sql.exec("UPDATE accounts SET data = ? WHERE id = ?", JSON.stringify({ ...cur, secret: next }), accountId);
      return next;
    })().finally(() => this.refreshing.delete(accountId));
    this.refreshing.set(accountId, p);
    return p;
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
