import type { Env } from "./env";

export const hub = (env: Env) => env.HUB.get(env.HUB.idFromName("main"));
