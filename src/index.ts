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

export default app;
