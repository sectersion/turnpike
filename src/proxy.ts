import { Hono } from "hono";
import type { AppEnv } from "./auth";
import { hub } from "./hub-client";
import { getProvider } from "./oauth";
import type { Format, Target } from "./providers";
import { explainEmpty, resolveTargets, routeWithFallback } from "./router";
import { extractUsage } from "./translate/openai-anthropic";
import { usageTap } from "./translate/stream";
import type { Account } from "./types";
import { recordUsage } from "./usage";

export const proxy = new Hono<AppEnv>();

const fail = (format: Format, status: number, type: string, message: string) =>
  Response.json(format === "anthropic" ? { type: "error", error: { type, message } } : { error: { message, type } }, { status });

// Rough input-token estimate for reservations: ~4 chars per token.
const jsonLen = (v: unknown) => (JSON.stringify(v) ?? "").length;
export const estimateTokens = (body: any): number => Math.max(1, Math.ceil((jsonLen(body?.messages) + jsonLen(body?.system)) / 4));

// Retry-After as seconds or an HTTP date; default 30s, capped at 15 minutes.
export function retryAfterMs(h: string | null): number {
  const s = h?.trim() ?? "";
  const ms = /^\d+$/.test(s) ? Number(s) * 1000 : Date.parse(s) - Date.now();
  return Number.isFinite(ms) && ms >= 0 ? Math.min(ms, 15 * 60_000) : 30_000;
}

async function handle(c: import("hono").Context<AppEnv>, format: Format): Promise<Response> {
  let body: any;
  try {
    body = await c.req.json();
  } catch {
    return fail(format, 400, "invalid_request_error", "malformed JSON body");
  }
  const model = body?.model;
  if (typeof model !== "string" || !model) return fail(format, 400, "invalid_request_error", "model is required");

  const key = c.get("key");
  const [accounts, combos] = await Promise.all([hub(c.env).listAccounts(false), hub(c.env).listCombos()]);
  const targets = resolveTargets(model, accounts, combos, key.allowedAccountIds);
  if (!targets.length)
    return explainEmpty(model, accounts, combos) === "not_allowed"
      ? fail(format, 403, "permission_error", "this key may not use that model")
      : fail(format, 404, "not_found_error", `unknown model: ${model}`);

  const h = hub(c.env);
  const safe = (p: Promise<void>) => p.catch(() => {});
  const bg = (p: () => Promise<void>) => {
    try {
      c.executionCtx.waitUntil(safe(p()));
    } catch {}
  };
  const estTokens = estimateTokens(body);
  const maxOutTokens = typeof body.max_tokens === "number" ? body.max_tokens : undefined;
  let gated: string | undefined;
  const gate = async (t: Target) => {
    const g = await h.reserve({ keyId: key.id, accountId: t.account.id, model: t.model, estTokens, maxOutTokens });
    if (!g.ok) gated ??= g.reason;
    return g;
  };
  const authHeaders = async (a: Account) => {
    const p = getProvider(a.kind);
    if (!p) throw new Error("oauth executor not implemented");
    return p.headers(await h.getFreshToken(a.id));
  };
  const attempts: { t: Target; r: Response | Error; rid?: string }[] = [];
  const res = await routeWithFallback(
    targets,
    format,
    body,
    fetch,
    (t, r, rid) => {
      attempts.push({ t, r, rid });
      if (r instanceof Response && r.status === 429) {
        const until = Date.now() + retryAfterMs(r.headers.get("retry-after"));
        bg(() => h.setCooldown(t.account.id, until));
      }
    },
    gate,
    authHeaders,
  );
  const win = attempts.find((a) => a.r === res);
  // Every attempt reached (or tried to reach) upstream: all but a successful winner are released, still counting toward rpm.
  for (const a of attempts) if (a.rid && (a !== win || !res.ok)) bg(() => h.release(a.rid!));
  if (!win && gated) return fail(format, 429, "rate_limit", `limit: ${gated}`);
  if (!res.ok || !win?.rid) return res;
  const winner = win.t;
  const reservationId = win.rid;

  const rec = (usage: { inputTokens: number; outputTokens: number } | null) =>
    recordUsage(c.env, { keyId: key.id, accountId: winner.account.id, model: winner.model, reservationId, usage });

  if (body.stream === true && res.body) {
    // bg never throws: usageTap calls this from flush/cancel.
    const tapped = res.body.pipeThrough(usageTap((u) => bg(() => rec(u))));
    return new Response(tapped, { status: res.status, headers: res.headers });
  }
  const clone = res.clone();
  bg(() => clone.json().then((j) => rec(extractUsage(j)), () => rec(null)));
  return res;
}

proxy.post("/chat/completions", (c) => handle(c, "openai"));
proxy.post("/messages", (c) => handle(c, "anthropic"));

// ponytail: provider models are not enumerable until accounts carry a model list; combos only.
proxy.get("/models", async (c) => {
  const allowed = c.get("key").allowedAccountIds;
  const [accounts, combos] = await Promise.all([hub(c.env).listAccounts(false), hub(c.env).listCombos()]);
  const data = combos
    .filter((cb) => resolveTargets(cb.name, accounts, combos, allowed).length)
    .map((cb) => ({ id: cb.name, object: "model", owned_by: "turnpike" }));
  return c.json({ object: "list", data });
});
