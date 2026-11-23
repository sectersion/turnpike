import type { AccountKind } from "../types";
import { copilot } from "./copilot";

export type OAuthTokens = { accessToken: string; refreshToken?: string; expiresAt?: number; [k: string]: string | number | undefined };
export type OAuthStart = { mode: "device"; userCode: string; verifyUrl: string; state: unknown } | { mode: "paste"; authUrl: string; state: unknown };

export interface OAuthProvider {
  kind: AccountKind;
  start(): Promise<OAuthStart>;
  // Device flow: one poll per call, "pending" until the user approves; throws on denial or expiry.
  complete(state: unknown, input: string): Promise<OAuthTokens | "pending">;
  refresh(t: OAuthTokens): Promise<OAuthTokens>;
  headers(t: OAuthTokens): Record<string, string>;
}

const PROVIDERS = new Map<string, OAuthProvider>([[copilot.kind, copilot]]);

export const getProvider = (kind: string): OAuthProvider | undefined => PROVIDERS.get(kind);
