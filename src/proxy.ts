import { Hono } from "hono";
import type { AppEnv } from "./auth";
import { hub } from "./hub-client";
import type { Format, Target } from "./providers";
import { explainEmpty, isFallbackEligible, resolveTargets, routeWithFallback } from "./router";
import { extractUsage } from "./translate/openai-anthropic";
import { usageTap } from "./translate/stream";
import { recordUsage } from "./usage";

export const proxy = new Hono<AppEnv>();

const fail = (format: Format, status: number, type: string, message: string) =>
  Response.json(format === "anthropic" ? { type: "error", error: { type, message } } : { error: { message, type } }, { status });

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

  let winner: Target | undefined;
  const res = await routeWithFallback(targets, format, body, fetch, (t, r) => {
    if (r instanceof Response ? !isFallbackEligible(r.status) : t === targets[targets.length - 1]) winner = t;
  });
  if (!res.ok || !winner) return res;

  const rec = (usage: { inputTokens: number; outputTokens: number } | null) =>
    recordUsage(c.env, { keyId: key.id, accountId: winner!.account.id, model: winner!.model, usage });
  const safe = (p: Promise<void>) => p.catch(() => {});

  if (body.stream === true && res.body) {
    // Must never throw: usageTap calls this from flush/cancel.
    const tapped = res.body.pipeThrough(
      usageTap((u) => {
        try {
          c.executionCtx.waitUntil(safe(rec(u)));
        } catch {}
      }),
    );
    return new Response(tapped, { status: res.status, headers: res.headers });
  }
  const clone = res.clone();
  c.executionCtx.waitUntil(safe(clone.json().then((j) => rec(extractUsage(j)), () => rec(null))));
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
