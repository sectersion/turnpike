import { Hono } from "hono";
import { admin } from "./admin";
import { requireKey, type AppEnv } from "./auth";

export { Hub } from "./hub";

const app = new Hono<AppEnv>();

app.get("/health", (c) => c.json({ ok: true }));
app.route("/admin", admin);

app.use("/v1/*", requireKey);
app.get("/v1/models", (c) => c.json({ object: "list", data: [] })); // Task 6 fills this in

export default app;
