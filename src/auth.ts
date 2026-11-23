import type { MiddlewareHandler } from "hono";
import type { Env } from "./env";
import type { RouterKey } from "./types";
import { hub } from "./hub-client";

export type AppEnv = { Bindings: Env; Variables: { key: RouterKey } };

const digest = async (s: string) => new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)));

// Compares SHA-256 digests so length never leaks and there is no early return.
export async function safeEqual(a: string, b: string): Promise<boolean> {
  const [x, y] = await Promise.all([digest(a), digest(b)]);
  let d = 0;
  for (let i = 0; i < x.length; i++) d |= x[i] ^ y[i];
  return d === 0;
}

const bearer = (h: string | undefined) => h?.match(/^Bearer\s+(.+)$/i)?.[1] ?? "";

export const requireAdmin: MiddlewareHandler<AppEnv> = async (c, next) => {
  const token = c.env.ADMIN_TOKEN;
  if (!token) return c.json({ error: "admin disabled: ADMIN_TOKEN not set" }, 503);
  if (!(await safeEqual(bearer(c.req.header("authorization")), token))) return c.json({ error: "unauthorized" }, 401);
  await next();
};

export const requireKey: MiddlewareHandler<AppEnv> = async (c, next) => {
  const secret = bearer(c.req.header("authorization")) || c.req.header("x-api-key") || "";
  const key = secret ? await hub(c.env).resolveKey(secret) : null;
  if (!key) return c.json({ error: "unauthorized" }, 401);
  c.set("key", key);
  await next();
};
