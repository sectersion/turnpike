import { Hono, type Context } from "hono";
import { HTTPException } from "hono/http-exception";
import { requireAdmin, type AppEnv } from "./auth";
import { hub } from "./hub-client";
import { getProvider } from "./oauth";
import { PROVIDERS } from "./providers";
import type { Account, AccountKind } from "./types";

export const admin = new Hono<AppEnv>();
admin.use("*", requireAdmin);

const bad = (message: string) => new HTTPException(400, { res: Response.json({ error: { message } }, { status: 400 }) });
// Malformed JSON is a client error, not a 500.
const body = async (c: Context): Promise<Record<string, unknown>> => {
  const b = await c.req.json().catch(() => null);
  if (!b || typeof b !== "object" || Array.isArray(b)) throw bad("body must be a JSON object");
  return b as Record<string, unknown>;
};
const num = (v: unknown) => typeof v === "number" && Number.isFinite(v) && v >= 0;
// https with a host, or plain http only to the loopback names; no userinfo.
const validBaseUrl = (s: unknown) => {
  if (typeof s !== "string") return false;
  let u: URL;
  try { u = new URL(s); } catch { return false; }
  if (u.username || u.password || !u.hostname) return false;
  return u.protocol === "https:" || (u.protocol === "http:" && (u.hostname === "localhost" || u.hostname === "127.0.0.1"));
};
// undefined: absent; null: clear; else a validated number (rpm/tpm must be integers).
const limit = (b: Record<string, unknown>, f: "rpm" | "tpm" | "monthlyUsd" | "dailyUsd" | "maxInFlight"): number | null | undefined => {
  if (!(f in b) || b[f] === undefined) return undefined;
  const v = b[f];
  if (v === null) return null;
  if (num(v) && (f === "monthlyUsd" || f === "dailyUsd" || Number.isInteger(v))) return v as number;
  throw bad(`${f} must be ${f === "monthlyUsd" || f === "dailyUsd" ? "a non-negative number" : "a non-negative integer"} or null`);
};
const redact = (a: Account) => ({ ...a, secret: "***" });
admin.onError((e, c) => (e instanceof HTTPException ? e.getResponse() : c.json({ error: { message: "internal error" } }, 500)));

admin.get("/keys", async (c) => c.json(await hub(c.env).listKeys()));
admin.post("/keys", async (c) => {
  const b = await body(c);
  if (typeof b.name !== "string" || !b.name.trim()) throw bad("name required");
  const i: Parameters<ReturnType<typeof hub>["createKey"]>[0] = { name: b.name.trim() };
  const d = limit(b, "dailyUsd"), m = limit(b, "monthlyUsd");
  if (d != null) i.dailyUsd = d;
  if (m != null) i.monthlyUsd = m;
  const rpm = limit(b, "rpm"), mif = limit(b, "maxInFlight");
  if (rpm !== undefined) i.rpm = rpm;
  if (mif !== undefined) i.maxInFlight = mif;
  const al = b.allowedAccountIds;
  if (al != null) {
    if (!Array.isArray(al) || al.length > 200 || al.some((x) => typeof x !== "string")) throw bad("allowedAccountIds must be an array of at most 200 strings");
    i.allowedAccountIds = al;
  }
  return c.json(await hub(c.env).createKey(i), 201);
});
admin.patch("/keys/:id", async (c) => {
  const b = await body(c);
  const k = await hub(c.env).patchKey(c.req.param("id"), { rpm: limit(b, "rpm"), maxInFlight: limit(b, "maxInFlight") });
  return k ? c.json(k) : c.json({ error: { message: "not found" } }, 404);
});
admin.delete("/keys/:id", async (c) => {
  await hub(c.env).revokeKey(c.req.param("id"));
  return c.json({ ok: true });
});

admin.get("/accounts", async (c) => c.json(await hub(c.env).listAccounts(true)));
admin.post("/accounts", async (c) => {
  const b = await body(c);
  const kind = b.kind as AccountKind;
  if (typeof kind !== "string" || !Object.hasOwn(PROVIDERS, kind)) throw bad("unknown kind");
  if (kind.endsWith("-oauth")) throw bad("oauth accounts are created via /admin/oauth/:kind/complete");
  if (typeof b.name !== "string" || !b.name.trim()) throw bad("name required");
  const custom = kind === "custom-openai" || kind === "custom-anthropic";
  const k = typeof b.secret === "string" ? b.secret : (b.secret as { apiKey?: unknown } | undefined)?.apiKey;
  if (!custom && (typeof k !== "string" || !k.trim())) throw bad("api key required");
  if (custom && k !== undefined && typeof k !== "string") throw bad("invalid secret");
  if (b.baseUrl !== undefined && !validBaseUrl(b.baseUrl)) throw bad("invalid baseUrl");
  if (custom && !b.baseUrl) throw bad("baseUrl required for custom kinds");
  if (b.enabled !== undefined && typeof b.enabled !== "boolean") throw bad("enabled must be boolean");
  const acc: Parameters<ReturnType<typeof hub>["upsertAccount"]>[0] = {
    kind, name: b.name.trim(), authType: "apikey", secret: (b.secret as any) ?? "",
  };
  if (b.baseUrl !== undefined) acc.baseUrl = b.baseUrl as string;
  if (b.enabled !== undefined) acc.enabled = b.enabled;
  for (const f of ["rpm", "tpm", "monthlyUsd"] as const) {
    const v = limit(b, f);
    if (v !== undefined && v !== null) acc[f] = v;
  }
  return c.json(redact(await hub(c.env).upsertAccount(acc)), 201);
});

// Limits may be cleared with null. The merge runs inside the Hub; secret/id/kind/authType are never touched.
admin.patch("/accounts/:id", async (c) => {
  const b = await body(c);
  const f: Record<string, unknown> = {};
  if ("enabled" in b) {
    if (typeof b.enabled !== "boolean") throw bad("enabled must be boolean");
    f.enabled = b.enabled;
  }
  if ("name" in b) {
    if (typeof b.name !== "string" || !b.name.trim()) throw bad("name required");
    f.name = b.name.trim();
  }
  for (const k of ["rpm", "tpm", "monthlyUsd"] as const) {
    const v = limit(b, k);
    if (v !== undefined) f[k] = v;
  }
  if ("baseUrl" in b) {
    if (b.baseUrl === null || b.baseUrl === "") f.baseUrl = null;
    else if (validBaseUrl(b.baseUrl)) f.baseUrl = b.baseUrl;
    else throw bad("invalid baseUrl");
  }
  const r = await hub(c.env).patchAccount(c.req.param("id"), f);
  if ("error" in r) return c.json({ error: { message: r.error } }, r.error === "not found" ? 404 : 400);
  return c.json(redact(r.account));
});
admin.delete("/accounts/:id", async (c) => {
  await hub(c.env).deleteAccount(c.req.param("id"));
  return c.json({ ok: true });
});

admin.get("/usage", async (c) => {
  const q = c.req.query("since");
  const d = new Date();
  const since = q === undefined ? Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1) : Number(q);
  if (!Number.isFinite(since) || since < 0 || (q !== undefined && q.trim() === "")) throw bad("since must be a non-negative number");
  return c.json(await hub(c.env).usageSummary(since));
});

admin.put("/prices", async (c) => {
  const b = await body(c);
  if (typeof b.model !== "string" || !b.model.trim() || !num(b.inPerM) || !num(b.outPerM)) throw bad("model and non-negative inPerM, outPerM required");
  await hub(c.env).setPriceOverride(b.model, { inPerM: b.inPerM as number, outPerM: b.outPerM as number });
  return c.json({ ok: true });
});

admin.get("/combos", async (c) => c.json(await hub(c.env).listCombos()));
admin.put("/combos", async (c) => {
  const b = await body(c);
  const t = b.targets;
  if (typeof b.name !== "string" || !b.name.trim()) throw bad("name required");
  if (!Array.isArray(t) || t.length < 1 || t.length > 50) throw bad("targets must be an array of 1 to 50 items");
  const targets = t.map((x) => {
    if (!x || typeof x.accountId !== "string" || !x.accountId || typeof x.model !== "string" || !x.model) throw bad("each target needs accountId and model");
    return { accountId: x.accountId as string, model: x.model as string };
  });
  await hub(c.env).upsertCombo({ name: b.name, targets });
  return c.json({ ok: true });
});

// OAuth sign-in. Errors carry only provider status/error codes, never tokens.
const oauthErr = (e: unknown) => ({ error: { message: e instanceof Error ? e.message : "oauth failed" } });

admin.post("/oauth/:kind/start", async (c) => {
  const p = getProvider(c.req.param("kind"));
  if (!p) return c.json({ error: { message: "unknown oauth kind" } }, 404);
  try {
    return c.json(await p.start());
  } catch (e) {
    return c.json(oauthErr(e), 400);
  }
});

admin.post("/oauth/:kind/complete", async (c) => {
  const p = getProvider(c.req.param("kind"));
  if (!p) return c.json({ error: { message: "unknown oauth kind" } }, 404);
  try {
    const { state, input, name } = (await body(c)) as { state: unknown; input?: string; name?: string };
    const t = await p.complete(state, input ?? "");
    if (t === "pending") return c.json({ status: "pending" }, 202);
    const a = await hub(c.env).upsertAccount({ kind: p.kind, name: name || p.kind, authType: "oauth", secret: t, enabled: true });
    return c.json(redact(a));
  } catch (e) {
    return c.json(oauthErr(e), 400);
  }
});
