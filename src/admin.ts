import { Hono } from "hono";
import { requireAdmin, type AppEnv } from "./auth";
import { hub } from "./hub-client";
import { getProvider } from "./oauth";

export const admin = new Hono<AppEnv>();
admin.use("*", requireAdmin);

admin.get("/keys", async (c) => c.json(await hub(c.env).listKeys()));
admin.post("/keys", async (c) => c.json(await hub(c.env).createKey(await c.req.json()), 201));
admin.delete("/keys/:id", async (c) => {
  await hub(c.env).revokeKey(c.req.param("id"));
  return c.json({ ok: true });
});

admin.get("/accounts", async (c) => c.json(await hub(c.env).listAccounts(true)));
admin.post("/accounts", async (c) => {
  const a = await hub(c.env).upsertAccount(await c.req.json());
  return c.json({ ...a, secret: "***" }, 201);
});
admin.delete("/accounts/:id", async (c) => {
  await hub(c.env).deleteAccount(c.req.param("id"));
  return c.json({ ok: true });
});

admin.get("/combos", async (c) => c.json(await hub(c.env).listCombos()));
admin.put("/combos", async (c) => {
  await hub(c.env).upsertCombo(await c.req.json());
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
    const { state, input, name } = await c.req.json<{ state: unknown; input?: string; name?: string }>();
    const t = await p.complete(state, input ?? "");
    if (t === "pending") return c.json({ status: "pending" }, 202);
    const a = await hub(c.env).upsertAccount({ kind: p.kind, name: name || p.kind, authType: "oauth", secret: t, enabled: true });
    return c.json({ ...a, secret: "***" });
  } catch (e) {
    return c.json(oauthErr(e), 400);
  }
});
