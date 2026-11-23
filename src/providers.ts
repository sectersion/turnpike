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
  "codex-oauth": { native: "openai" }, // deferred until OpenAI offers an official third-party login usable here; no executor yet
  "copilot-oauth": { native: "openai", defaultBaseUrl: "https://api.githubcopilot.com" }, // verified: see src/oauth/copilot.ts
};

// Output-token limit: DEFAULT_OUT when the client sends none, never above MAX_OUT. The same value is
// reserved and sent upstream (the Hub may lower it further to fit a USD cap).
export const DEFAULT_OUT = 4096;
export const MAX_OUT = 32_000;
export const outCap = (body: any): number => {
  const r = body?.max_completion_tokens ?? body?.max_tokens;
  return typeof r === "number" && Number.isFinite(r) && r >= 1 ? Math.min(Math.floor(r), MAX_OUT) : DEFAULT_OUT;
};

// Request fields forwarded upstream; everything else (OpenRouter models/route/provider/plugins,
// service_tier, web_search_options, audio, mcp_servers, ...) is dropped because it can bill outside the price model.
const ALLOWED: Record<Format, string[]> = {
  openai: [
    "model", "messages", "max_tokens", "max_completion_tokens", "temperature", "top_p", "stop", "stream", "stream_options",
    "tools", "tool_choice", "parallel_tool_calls", "response_format", "seed", "frequency_penalty", "presence_penalty",
    "logit_bias", "logprobs", "top_logprobs", "user", "reasoning_effort", "n",
  ],
  anthropic: ["model", "messages", "system", "max_tokens", "temperature", "top_p", "top_k", "stop_sequences", "stream", "tools", "tool_choice", "thinking", "metadata"],
};

// Server-side tools (web search, code execution, computer use...) bill separately: refuse them.
export function badTools(format: Format, body: any): string | null {
  const tools = body?.tools;
  if (tools === undefined) return null;
  if (!Array.isArray(tools)) return "tools must be an array";
  const ok = (t: any) => (format === "openai" ? t?.type === "function" : t?.type === undefined || t?.type === "custom");
  return tools.every(ok) ? null : `only ${format === "openai" ? "function" : "custom (client)"} tools are supported; server tools are refused`;
}

// Allow-listed copy of the client body with the output limit set to maxOut and n forced to 1.
export function sanitize(format: Format, body: any, maxOut: number): any {
  const out: any = {};
  for (const k of ALLOWED[format]) if (body?.[k] !== undefined) out[k] = body[k];
  if (format === "openai") {
    if (out.max_completion_tokens !== undefined) out.max_completion_tokens = maxOut;
    else out.max_tokens = maxOut;
    if (out.n !== undefined) out.n = 1;
  } else {
    out.max_tokens = maxOut;
    // Anthropic requires budget_tokens < max_tokens (minimum 1024).
    const b = out.thinking?.budget_tokens;
    if (typeof b === "number" && b >= maxOut) out.thinking = maxOut > 1024 ? { ...out.thinking, budget_tokens: maxOut - 1 } : undefined;
    if (out.thinking === undefined) delete out.thinking;
  }
  return out;
}

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
  maxOut: number = outCap(body),
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

  let req: any = { ...sanitize(format, body, maxOut), model };
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
    redirect: "manual", // a cross-origin redirect would carry x-api-key / Copilot headers along
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
