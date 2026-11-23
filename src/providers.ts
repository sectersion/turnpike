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
  "copilot-oauth": { native: "openai" },
};

const apiKey = (a: Account): string =>
  typeof a.secret === "string" ? a.secret : "apiKey" in a.secret ? String(a.secret.apiKey) : "";

export async function callUpstream(t: Target, format: Format, body: unknown, fetchFn: typeof fetch): Promise<Response> {
  const { account, model } = t;
  if (account.kind.endsWith("-oauth")) throw new Error("oauth executor not implemented");
  const { native, defaultBaseUrl } = PROVIDERS[account.kind];
  const base = (account.baseUrl ?? defaultBaseUrl ?? "").replace(/\/+$/, "");
  const stream = (body as { stream?: unknown }).stream === true;

  let req: any = { ...(body as object), model };
  if (format !== native) req = { ...(format === "openai" ? openaiReqToAnthropic(req) : anthropicReqToOpenai(req)), model };

  const headers: Record<string, string> = { "content-type": "application/json" };
  if (native === "anthropic") {
    headers["x-api-key"] = apiKey(account);
    headers["anthropic-version"] = "2023-06-01";
  } else headers.Authorization = `Bearer ${apiKey(account)}`;

  const res = await fetchFn(`${base}${native === "openai" ? "/chat/completions" : "/messages"}`, {
    method: "POST",
    headers,
    body: JSON.stringify(req),
  });
  if (!res.ok || format === native) return res;

  const h = new Headers(res.headers);
  if (stream && res.body) {
    const tr = native === "anthropic" ? anthropicSseToOpenaiSse() : openaiSseToAnthropicSse(model);
    return new Response(res.body.pipeThrough(tr), { status: res.status, headers: h });
  }
  const data: any = await res.json();
  h.delete("content-length");
  return new Response(JSON.stringify(native === "anthropic" ? anthropicResToOpenai(data) : openaiResToAnthropic(data)), {
    status: res.status,
    headers: h,
  });
}
