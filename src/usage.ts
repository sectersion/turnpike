import type { Env } from "./env";
import { hub } from "./hub-client";

export type UsageRecord = {
  keyId: string;
  accountId: string;
  model: string;
  reservationId: string;
  usage: { inputTokens: number; outputTokens: number } | null;
};

export async function recordUsage(env: Env, rec: UsageRecord): Promise<void> {
  await hub(env).settle(rec.reservationId, rec.usage);
}
