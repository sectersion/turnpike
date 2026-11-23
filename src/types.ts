export type AccountKind =
  | "openrouter"
  | "opencode-zen"
  | "opencode-go"
  | "custom-openai"
  | "custom-anthropic"
  | "claude-oauth"
  | "codex-oauth"
  | "copilot-oauth";

export type RouterKey = {
  id: string;
  name: string;
  dailyUsd: number | null;
  monthlyUsd: number | null;
  allowedAccountIds: string[] | null;
  revoked: boolean;
};

export type Account = {
  id: string;
  kind: AccountKind;
  name: string;
  baseUrl?: string;
  authType: "apikey" | "oauth";
  secret: unknown;
  rpm?: number;
  tpm?: number;
  monthlyUsd?: number;
  enabled: boolean;
};

export type Combo = { name: string; targets: { accountId: string; model: string }[] };
