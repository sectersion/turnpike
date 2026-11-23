export type AccountKind =
  | "openrouter"
  | "opencode-zen"
  | "opencode-go"
  | "custom-openai"
  | "custom-anthropic"
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

export type AccountSecret =
  | string // plain API key, or the "***" redaction placeholder
  | { apiKey: string }
  | { accessToken: string; refreshToken?: string; expiresAt?: number; [k: string]: string | number | undefined };

export type Account = {
  id: string;
  kind: AccountKind;
  name: string;
  baseUrl?: string;
  authType: "apikey" | "oauth";
  secret: AccountSecret;
  rpm?: number;
  tpm?: number;
  monthlyUsd?: number;
  enabled: boolean;
};

export type Combo = { name: string; targets: { accountId: string; model: string }[] };
