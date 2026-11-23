import { Hono } from "hono";
import type { Env } from "./env";

export { Hub } from "./hub";

const app = new Hono<{ Bindings: Env }>();

app.get("/health", (c) => c.json({ ok: true }));

export default app;
