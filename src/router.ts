import { callUpstream, type AuthHeaders, type Format, type Target } from "./providers";
import type { Account, Combo } from "./types";

export type { Target };

const err = (status: number, message: string) =>
  new Response(JSON.stringify({ error: { message } }), { status, headers: { "content-type": "application/json" } });

// Ignores the allow-list; callers use explainEmpty to tell 404 from 403.
function expand(model: string, accounts: Account[], combos: Combo[]): Target[] {
  const live = (id: string) => accounts.find((a) => a.id === id && a.enabled);
  const combo = combos.find((c) => c.name === model);
  if (combo) return combo.targets.flatMap((t) => (live(t.accountId) ? [{ account: live(t.accountId)!, model: t.model }] : []));
  const i = model.indexOf("/");
  if (i < 0) return [];
  const name = model.slice(0, i).toLowerCase();
  const account = accounts.find((a) => a.enabled && a.name.toLowerCase() === name);
  return account ? [{ account, model: model.slice(i + 1) }] : [];
}

export function resolveTargets(model: string, accounts: Account[], combos: Combo[], allowed: string[] | null): Target[] {
  return expand(model, accounts, combos).filter((t) => !allowed || allowed.includes(t.account.id));
}

export const explainEmpty = (model: string, accounts: Account[], combos: Combo[]): "unknown_model" | "not_allowed" =>
  expand(model, accounts, combos).length ? "not_allowed" : "unknown_model";

export const isFallbackEligible = (status: number) => status === 408 || status === 429 || status >= 500;

export async function routeWithFallback(
  targets: Target[],
  format: Format,
  body: unknown,
  fetchFn: typeof fetch,
  onAttempt?: (t: Target, res: Response | Error, reservationId?: string) => void,
  gate?: (t: Target) => Promise<Gate>,
  authHeaders?: AuthHeaders,
): Promise<Response> {
  if (!targets.length) return err(404, "no matching model");
  let last: Response | Error = new Error("no attempt");
  let gated: string | undefined;
  for (const t of targets) {
    let reservationId: string | undefined;
    if (gate) {
      let g: Gate;
      try {
        g = await gate(t);
      } catch (e) {
        if (!(last instanceof Response)) last = e instanceof Error ? e : new Error(String(e));
        continue;
      }
      if (!g.ok) {
        gated ??= g.reason;
        continue;
      }
      reservationId = g.reservationId;
    }
    if (last instanceof Response) await last.body?.cancel(); // superseded failed attempt
    try {
      last = await callUpstream(t, format, body, fetchFn, authHeaders);
    } catch (e) {
      last = e instanceof Error ? e : new Error(String(e));
    }
    try {
      onAttempt?.(t, last, reservationId);
    } catch {
      // a throwing hook must not break the fallback chain
    }
    if (last instanceof Response && !isFallbackEligible(last.status)) return last;
  }
  if (last instanceof Response) return last;
  if (gated)
    return Response.json({ error: { message: `limit: ${gated}`, type: "rate_limit" } }, { status: 429 });
  return err(502, `upstream failed: ${last.message}`);
}

export type Gate = { ok: true; reservationId: string } | { ok: false; reason: string };
