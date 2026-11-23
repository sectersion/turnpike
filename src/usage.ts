import type { Env } from "./env";

export type UsageRecord = {
  keyId: string;
  accountId: string;
  model: string;
  usage: { inputTokens: number; outputTokens: number } | null;
};

// Seam for Task 7 (Hub reserve/settle); no-op for now.
export async function recordUsage(_env: Env, _rec: UsageRecord): Promise<void> {}
