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
const validUrl = (u: unknown) => typeof u === "string" && /^(https:\/\/|http:\/\/(localhost|127\.0\.0\.1)([:/]|$))/.test(u);
const redact = (a: Account) => ({ ...a, secret: "***" });
admin.onError((e, c) => (e instanceof HTTPException ? e.getResponse() : c.json({ error: { message: "internal error" } }, 500)));

admin.get("/keys", async (c) => c.json(await hub(c.env).listKeys()));
admin.post("/keys", async (c) => c.json(await hub(c.env).createKey(await body(c) as any), 201));
admin.delete("/keys/:id", async (c) => {
  await hub(c.env).revokeKey(c.req.param("id"));
  return c.json({ ok: true });
});

admin.get("/accounts", async (c) => c.json(await hub(c.env).listAccounts(true)));
admin.post("/accounts", async (c) => {
  const b = await body(c);
  const kind = b.kind as AccountKind;
  if (typeof kind !== "string" || !Object.hasOwn(PROVIDERS, kind)) throw bad("unknown kind");
  if (typeof b.name !== "string" || !b.name.trim()) throw bad("name required");
  const custom = kind === "custom-openai" || kind === "custom-anthropic";
  if (!kind.endsWith("-oauth")) {
    const k = typeof b.secret === "string" ? b.secret : (b.secret as { apiKey?: unknown } | undefined)?.apiKey;
    if (!custom && (typeof k !== "string" || !k.trim())) throw bad("api key required");
    if (custom && k !== undefined && typeof k !== "string") throw bad("invalid secret");
  }
  if (b.baseUrl !== undefined && !validUrl(b.baseUrl)) throw bad("baseUrl must start with https://");
  if (custom && !b.baseUrl) throw bad("baseUrl required for custom kinds");
  const a = await hub(c.env).upsertAccount({ ...(b as any), secret: (b.secret as any) ?? "" });
  return c.json(redact(a), 201);
});

// Limits may be cleared with null; the secret is never accepted here.
admin.patch("/accounts/:id", async (c) => {
  const b = await body(c);
  const cur = await hub(c.env).getAccount(c.req.param("id"));
  if (!cur) return c.json({ error: { message: "not found" } }, 404);
  const next: Account = { ...cur };
  if ("enabled" in b) {
    if (typeof b.enabled !== "boolean") throw bad("enabled must be boolean");
    next.enabled = b.enabled;
  }
  if ("name" in b) {
    if (typeof b.name !== "string" || !b.name.trim()) throw bad("name required");
    next.name = b.name;
  }
  for (const f of ["rpm", "tpm", "monthlyUsd"] as const) {
    if (!(f in b)) continue;
    if (b[f] === null) delete next[f];
    else if (num(b[f])) next[f] = b[f] as number;
    else throw bad(`${f} must be a number >= 0 or null`);
  }
  if ("baseUrl" in b) {
    if (b.baseUrl === null || b.baseUrl === "") delete next.baseUrl;
    else if (validUrl(b.baseUrl)) next.baseUrl = b.baseUrl as string;
    else throw bad("baseUrl must start with https://");
  }
  return c.json(redact(await hub(c.env).upsertAccount(next)));
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
  await hub(c.env).upsertCombo(await body(c) as any);
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
