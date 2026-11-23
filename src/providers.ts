import type { Account, AccountKind } from "./types";
import {
  anthropicReqToOpenai,
  anthropicResToOpenai,
  openaiReqToAnthropic,
  openaiResToAnthropic,
} from "./translate/openai-anthropic";
import { anthropicSseToOpenaiSse, openaiSseToAnthropicSse } from "./translate/stream";

export type Format = "openai" | "anthropic";
export type Target = { account: Account; model: string };

// TODO(verify): the three default base URLs below are unverified; confirm against provider docs before shipping.
export const PROVIDERS: Record<AccountKind, { native: Format; defaultBaseUrl?: string }> = {
  openrouter: { native: "openai", defaultBaseUrl: "https://openrouter.ai/api/v1" },
  "opencode-zen": { native: "openai", defaultBaseUrl: "https://opencode.ai/zen/v1" },
  "opencode-go": { native: "openai", defaultBaseUrl: "https://opencode.ai/zen/go/v1" },
  "custom-openai": { native: "openai" },
  "custom-anthropic": { native: "anthropic" },
  "claude-oauth": { native: "anthropic" },
  "codex-oauth": { native: "openai" },
  "copilot-oauth": { native: "openai", defaultBaseUrl: "https://api.githubcopilot.com" }, // verified: see src/oauth/copilot.ts
};

const apiKey = (a: Account): string =>
  typeof a.secret === "string" ? a.secret : "apiKey" in a.secret ? String(a.secret.apiKey) : "";

export type AuthHeaders = (account: Account) => Promise<Record<string, string>>;

// authHeaders supplies the auth for -oauth kinds (it may throw, e.g. on a failed token refresh).
export async function callUpstream(
  t: Target,
  format: Format,
  body: unknown,
  fetchFn: typeof fetch,
  authHeaders?: AuthHeaders,
): Promise<Response> {
  const { account, model } = t;
  const oauth = account.kind.endsWith("-oauth");
  if (oauth && !authHeaders) throw new Error("oauth executor not implemented");
  const oauthHeaders = oauth ? await authHeaders!(account) : {};
  const { native, defaultBaseUrl } = PROVIDERS[account.kind];
  const base = (account.baseUrl ?? defaultBaseUrl ?? "").replace(/\/+$/, "");
  if (!base) throw new Error("account has no baseUrl");
  const key = oauth ? "" : apiKey(account);
  if (!oauth && !key && account.kind !== "custom-openai" && account.kind !== "custom-anthropic") throw new Error("account has no api key");
  const stream = (body as { stream?: unknown }).stream === true;

  let req: any = { ...(body as object), model };
  if (format !== native) req = { ...(format === "openai" ? openaiReqToAnthropic(req) : anthropicReqToOpenai(req)), model };

  if (stream && native === "openai") req.stream_options = { ...req.stream_options, include_usage: true };

  const headers: Record<string, string> = { "content-type": "application/json", ...oauthHeaders };
  if (native === "anthropic") {
    if (key) headers["x-api-key"] = key;
    headers["anthropic-version"] = "2023-06-01";
  } else if (key) headers.Authorization = `Bearer ${key}`;

  const res = await fetchFn(`${base}${native === "openai" ? "/chat/completions" : "/messages"}`, {
    method: "POST",
    headers,
    body: JSON.stringify(req),
  });
  if (!res.ok || format === native) return res;

  const h = new Headers(res.headers);
  h.delete("content-length");
  if (stream && res.body) {
    const tr = native === "anthropic" ? anthropicSseToOpenaiSse() : openaiSseToAnthropicSse(model);
    return new Response(res.body.pipeThrough(tr), { status: res.status, headers: h });
  }
  const data: any = await res.json();
  return new Response(JSON.stringify(native === "anthropic" ? anthropicResToOpenai(data) : openaiResToAnthropic(data)), {
    status: res.status,
    headers: h,
  });
}
