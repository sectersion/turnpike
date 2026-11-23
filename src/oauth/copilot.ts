/*
 * GitHub Copilot sign-in, verified 2026-11-22.
 *
 * Device flow (official docs, https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps):
 *   - POST https://github.com/login/device/code, form body client_id + scope, `Accept: application/json` for JSON.
 *     Response: device_code, user_code, verification_uri (https://github.com/login/device), expires_in, interval.
 *   - POST https://github.com/login/oauth/access_token, form body client_id, device_code,
 *     grant_type=urn:ietf:params:oauth:grant-type:device_code. Errors: authorization_pending, slow_down
 *     (+5s to interval), expired_token, access_denied, and others (incorrect_device_code, device_flow_disabled...).
 *
 * Copilot specifics (undocumented internal API; confirmed by agreement of open-source clients):
 *   - client_id Iv1.b507a08c87ecfe98 (the VS Code Copilot app), scope "read:user":
 *     https://raw.githubusercontent.com/ericc-ch/copilot-api/master/src/lib/api-config.ts ,
 *     https://github.com/earendil-works/pi/blob/209bc7b9/packages/ai/src/auth/oauth/github-copilot.ts (base64 of the same id),
 *     https://github.com/CopilotC-Nvim/CopilotChat.nvim/blob/2f3e0739/lua/CopilotChat/config/providers.lua (same id),
 *     https://raw.githubusercontent.com/BerriAI/litellm/main/litellm/llms/github_copilot/authenticator.py (scope read:user).
 *   - Exchange: GET https://api.github.com/copilot_internal/v2/token with `Authorization: token <github token>`
 *     (ericc-ch, CopilotChat.nvim; pi sends `Bearer`, both evidently work). Response {token, expires_at (unix seconds), refresh_in}.
 *   - Chat: POST https://api.githubcopilot.com/chat/completions (OpenAI format) with `Authorization: Bearer <copilot token>`,
 *     Copilot-Integration-Id: vscode-chat, Editor-Version, Editor-Plugin-Version, User-Agent (ericc-ch, CopilotChat.nvim).
 *     Version strings below are pi's verbatim. Business/enterprise accounts use other hosts
 *     (api.business.githubcopilot.com etc., per ericc-ch); set the account's baseUrl for those.
 *
 * NOT confirmed: which of the editor headers the API strictly requires (no live call was made), whether
 * stream_options.include_usage is honoured, and the slow_down handling below (we just report "pending").
 */
import type { OAuthProvider, OAuthTokens } from "./index";

const CLIENT_ID = "Iv1.b507a08c87ecfe98";
const UA = "GitHubCopilotChat/0.35.0";
const EDITOR = { "Editor-Version": "vscode/1.107.0", "Editor-Plugin-Version": "copilot-chat/0.35.0", "User-Agent": UA };

const form = (url: string, body: Record<string, string>) =>
  fetch(url, {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded", "User-Agent": UA },
    body: new URLSearchParams(body).toString(),
    redirect: "manual",
  });

async function exchange(gh: string): Promise<OAuthTokens> {
  const r = await fetch("https://api.github.com/copilot_internal/v2/token", {
    headers: { Accept: "application/json", Authorization: `token ${gh}`, ...EDITOR },
    redirect: "manual",
  });
  // status lets the Hub pick a cooldown (rejected grant vs transient failure).
  if (!r.ok) throw Object.assign(new Error(`copilot token exchange failed: HTTP ${r.status}`), { status: r.status });
  const j = (await r.json()) as { token?: unknown; expires_at?: unknown };
  if (typeof j.token !== "string" || typeof j.expires_at !== "number") throw new Error("copilot token exchange returned no token");
  return { accessToken: j.token, refreshToken: gh, expiresAt: j.expires_at * 1000 };
}

export const copilot: OAuthProvider = {
  kind: "copilot-oauth",

  async start() {
    const r = await form("https://github.com/login/device/code", { client_id: CLIENT_ID, scope: "read:user" });
    if (!r.ok) throw new Error(`github device code request failed: HTTP ${r.status}`);
    const j = (await r.json()) as { device_code: string; user_code: string; verification_uri: string };
    return { mode: "device", userCode: j.user_code, verifyUrl: j.verification_uri, state: { deviceCode: j.device_code } };
  },

  async complete(state) {
    const deviceCode = (state as { deviceCode?: unknown } | null)?.deviceCode;
    if (typeof deviceCode !== "string") throw new Error("missing device code in state");
    const r = await form("https://github.com/login/oauth/access_token", {
      client_id: CLIENT_ID,
      device_code: deviceCode,
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    });
    if (!r.ok) throw new Error(`github token poll failed: HTTP ${r.status}`);
    const j = (await r.json()) as { access_token?: string; error?: string };
    if (j.access_token) return exchange(j.access_token);
    if (j.error === "authorization_pending" || j.error === "slow_down") return "pending";
    throw new Error(`github sign-in failed: ${j.error ?? "no token returned"}`);
  },

  async refresh(t) {
    if (!t.refreshToken) throw new Error("no github token stored");
    return exchange(t.refreshToken);
  },

  headers: (t) => ({ Authorization: `Bearer ${t.accessToken}`, "Copilot-Integration-Id": "vscode-chat", ...EDITOR }),
};
