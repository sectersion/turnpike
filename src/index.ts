import { Hono } from "hono";
import { admin } from "./admin";
import { requireKey, type AppEnv } from "./auth";
import { proxy } from "./proxy";

export { Hub } from "./hub";

const app = new Hono<AppEnv>();

app.get("/health", (c) => c.json({ ok: true }));
app.route("/admin", admin);

app.use("/v1/*", requireKey);
app.route("/v1", proxy);

app.notFound((c) => {
  const p = c.req.path;
  const message = `endpoint not supported: ${c.req.method} ${p}`;
  if (p.startsWith("/v1/messages")) return c.json({ type: "error", error: { type: "not_found_error", message } }, 404);
  return c.json({ error: { message, type: "not_found_error" } }, 404);
});

export default app;
