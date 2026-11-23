import { DurableObject } from "cloudflare:workers";
import { newSecret, sha256Hex } from "./crypto";
import type { Account, Combo, RouterKey } from "./types";
import type { Env } from "./env";

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
        CREATE TABLE IF NOT EXISTS combos (name TEXT PRIMARY KEY, targets TEXT NOT NULL);`);
    });
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
    const r = this.sql.exec<{ data: string }>("SELECT data FROM accounts WHERE id = ?", id).toArray()[0];
    return r ? JSON.parse(r.data) : null;
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
