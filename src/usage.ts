import type { Env } from "./env";
import { hub } from "./hub-client";

export type UsageRecord = {
  keyId: string;
  accountId: string;
  model: string;
  reservationId: string;
  usage: Usage | null;
};

// inputTokens excludes cache tokens; the cache counts are priced separately (see costUsd).
export type Usage = { inputTokens: number; outputTokens: number; cacheWriteTokens?: number; cacheReadTokens?: number };

export async function recordUsage(env: Env, rec: UsageRecord): Promise<void> {
  await hub(env).settle(rec.reservationId, rec.usage);
}
