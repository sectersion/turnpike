import { Hono } from "hono";
import { requireAdmin, type AppEnv } from "./auth";
import { hub } from "./hub-client";

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
