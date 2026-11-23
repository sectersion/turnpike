import { Hono } from "hono";
import type { AppEnv } from "./auth";
import { hub } from "./hub-client";
import { badTools, outCap, type Format, type Target } from "./providers";
import { explainEmpty, isAccountFailure, resolveTargets, routeWithFallback } from "./router";
import { extractUsage } from "./translate/openai-anthropic";
import { usageTap } from "./translate/stream";
import type { Account } from "./types";
import { recordUsage, type Usage } from "./usage";

export const proxy = new Hono<AppEnv>();

const fail = (format: Format, status: number, type: string, message: string) =>
  Response.json(format === "anthropic" ? { type: "error", error: { type, message } } : { error: { message, type } }, { status });

const ACCOUNT_COOLDOWN_MS = 15 * 60_000;
const PASS_HEADERS = ["content-type", "retry-after", "cache-control"];
const pickHeaders = (h: Headers) => {
  const out = new Headers();
  for (const k of PASS_HEADERS) {
    const v = h.get(k);
    if (v) out.set(k, v);
  }
  return out;
};

// What a friend sees for a failed upstream: validation bodies pass, everything else is generic so no
// account, org, balance or key detail leaks. 401/402/403/3xx would read as "your router key is bad": 502.
function upstreamError(format: Format, res: Response): Response {
  const s = res.status;
  if (s === 400 || s === 422) return new Response(res.body, { status: s, headers: pickHeaders(res.headers) });
  void res.body?.cancel().catch(() => {});
  if (isAccountFailure(s) || s < 400) return fail(format, 502, "api_error", "upstream account error");
  const out = fail(format, s, s === 429 ? "rate_limit" : "api_error", `upstream error (HTTP ${s})`);
  const ra = res.headers.get("retry-after");
  if (ra) out.headers.set("retry-after", ra);
  return out;
}

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

  const toolErr = badTools(format, body);
  if (toolErr) return fail(format, 400, "invalid_request_error", toolErr);

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
  const maxOutTokens = outCap(body);
  let gated: string | undefined;
  const reserved: string[] = [];
  const gate = async (t: Target) => {
    const g = await h.reserve({ keyId: key.id, accountId: t.account.id, model: t.model, estTokens, maxOutTokens });
    if (g.ok) reserved.push(g.reservationId);
    else gated ??= g.reason;
    return g;
  };
  const authHeaders = (a: Account) => h.getAuthHeaders(a.id);
  const attempts: { t: Target; r: Response | Error; rid?: string }[] = [];
  let res: Response | undefined;
  try {
    res = await routeWithFallback(
      targets,
      format,
      body,
      fetch,
      (t, r, rid) => {
        attempts.push({ t, r, rid });
        if (r instanceof Response && (r.status === 429 || isAccountFailure(r.status))) {
          const until = Date.now() + (r.status === 429 ? retryAfterMs(r.headers.get("retry-after")) : ACCOUNT_COOLDOWN_MS);
          bg(() => h.setCooldown(t.account.id, until));
        }
      },
      gate,
      authHeaders,
    );
  } catch {
    return fail(format, 502, "api_error", "upstream failed");
  } finally {
    // Every reservation but a successful winner's is released (still counting toward rpm), even on a throw.
    const keep = res?.ok ? attempts.find((a) => a.r === res)?.rid : undefined;
    for (const rid of reserved) if (rid !== keep) bg(() => h.release(rid));
  }
  const win = attempts.find((a) => a.r === res);
  if (!win && gated) return fail(format, 429, "rate_limit", `limit: ${gated}`);
  if (win && !res.ok) return upstreamError(format, res);
  if (!res.ok || !win?.rid) return res;
  const winner = win.t;
  const reservationId = win.rid;

  const rec = (usage: Usage | null) =>
    recordUsage(c.env, { keyId: key.id, accountId: winner.account.id, model: winner.model, reservationId, usage });

  if (body.stream === true && res.body) {
    // bg never throws: usageTap calls this from flush/cancel.
    const tapped = res.body.pipeThrough(usageTap((u) => bg(() => rec(u))));
    return new Response(tapped, { status: res.status, headers: pickHeaders(res.headers) });
  }
  const clone = res.clone();
  bg(() => clone.json().then((j) => rec(extractUsage(j)), () => rec(null)));
  return new Response(res.body, { status: res.status, headers: pickHeaders(res.headers) });
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
