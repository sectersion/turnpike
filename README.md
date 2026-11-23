# turnpike

A self-hosted LLM router for Cloudflare Workers. You add upstream provider accounts, group models into ordered fallback lists ("combos"), and hand out router keys with spend caps. Clients talk to one URL in either the OpenAI or the Anthropic format; turnpike translates between the two when the upstream speaks the other one. State lives in one SQLite-backed Durable Object (`Hub`).

| Route | Purpose | Auth |
|---|---|---|
| `POST /v1/chat/completions` | OpenAI-compatible chat (streaming supported) | router key |
| `POST /v1/messages` | Anthropic-compatible messages (streaming supported) | router key |
| `GET /v1/models` | Lists the combos the key may use (not provider models) | router key |
| `/` | Dashboard (static files in `public/`) | admin token, entered in the page |
| `/admin/*` | Admin API used by the dashboard | `Authorization: Bearer <ADMIN_TOKEN>` |
| `GET /health` | Returns `{"ok":true}` | none |

Router keys are sent as `Authorization: Bearer <key>` or `x-api-key: <key>`.

## Quick start (local)

```sh
npm install
cp .dev.vars.example .dev.vars   # then edit ADMIN_TOKEN
npm run dev
```

Open the URL `wrangler dev` prints (normally http://localhost:8787) and enter the admin token.

## Deploy

```sh
npx wrangler secret put ADMIN_TOKEN
npm run deploy
```

No resource IDs need pasting: `wrangler.jsonc` declares one Durable Object binding (`HUB`, class `Hub`) with a `new_sqlite_classes` migration, plus the static assets directory. `npx wrangler deploy --dry-run` succeeds without any account-specific values. The first deploy prints the Worker URL (`https://turnpike.<your-subdomain>.workers.dev`); that is your base URL below.

To rotate the admin token, run `npx wrangler secret put ADMIN_TOKEN` again with a new value and sign in again with it. If `ADMIN_TOKEN` is unset, `/admin/*` returns 503.

There is no "Deploy to Cloudflare" button; it was not set up or tested.

## First use (dashboard)

1. **Accounts tab, add an account.** Kinds:
   - `openrouter`, `opencode-zen`, `opencode-go`: API key plus a built-in default base URL (see Known limitations).
   - `custom-openai`, `custom-anthropic`: your own endpoint. A base URL is required (https, or http only for localhost/127.0.0.1); the API key is optional.
   - `copilot-oauth` (GitHub Copilot): the dashboard shows a device code and a GitHub URL; approve there and the account is created.

   Optional per-account limits: RPM, TPM, monthly USD. Accounts can be disabled or deleted.
2. **Combos tab, create a combo.** An ordered list of `{account, model}` targets. Requests for the combo name try targets in order and fall through to the next one on a 408, 429 or 5xx (or a network error). You can also skip combos and request `<account name>/<model>` directly (account name matched case-insensitively), for example `openrouter/anthropic/claude-sonnet-4`.
3. **Keys tab, create a router key.** Name, optional daily and monthly USD caps (UTC day and month), and an account allow-list ("All accounts" or a subset). The secret (prefix `tpk`) is shown once; copy it then.
4. **Usage tab.** Per-key and per-account requests, tokens and USD for a period, plus manual price overrides per model.

A friend uses the key like this:

```sh
# OpenAI SDKs and tools
export OPENAI_BASE_URL=https://<worker>/v1
export OPENAI_API_KEY=<router key>

# Anthropic SDKs and tools (no /v1: the SDK appends /v1/messages itself)
export ANTHROPIC_BASE_URL=https://<worker>
export ANTHROPIC_API_KEY=<router key>
```

Use a combo name or `<account>/<model>` as the model.

## curl examples

```sh
BASE=https://<worker>; KEY=<router key>

curl $BASE/v1/chat/completions -H "Authorization: Bearer $KEY" -H "content-type: application/json" \
  -d '{"model":"my-combo","messages":[{"role":"user","content":"hi"}]}'

curl $BASE/v1/messages -H "x-api-key: $KEY" -H "content-type: application/json" \
  -d '{"model":"my-combo","max_tokens":256,"messages":[{"role":"user","content":"hi"}]}'

curl $BASE/v1/models -H "Authorization: Bearer $KEY"
```

Errors: 401 bad key, 404 unknown model, 403 model exists but not on this key's allow-list, 429 `limit: <reason>` when every target is blocked by a limit (`key_daily`, `key_monthly`, `account_monthly`, `rpm`, `tpm`, `cooldown`, `unpriced`).

## Limits

| Limit | Scope | Behavior |
|---|---|---|
| Daily / monthly USD | per router key | Checked before each request against recorded spend, in-flight reservations and the estimated cost of this request. Overshoot is bounded by in-flight estimates. |
| RPM / TPM | per account | Rolling 60 seconds. TPM counts the estimated input tokens (about 4 characters per token) of the request. |
| Monthly USD | per account | Same check, per account. |
| Upstream 429 | per account | The account goes into cooldown for the upstream `Retry-After` (seconds or HTTP date; default 30 s, capped at 15 min). The request falls through to the next combo target. |

Expected output cost is estimated from `max_tokens`, or 1024 tokens if absent, then replaced by the real usage when the response completes (or kept as the estimate if the upstream reports none).

Pricing: OpenRouter's public model list (`openrouter.ai/api/v1/models`), refreshed daily by the Durable Object, plus manual overrides (Usage tab or `PUT /admin/prices`). Overrides win. A model matches by full id or by the part after the `/`.

"Unpriced" means no price is known for the model. A key with a daily or monthly USD cap is refused for unpriced models (429 `limit: unpriced`); a key with no cap is not. Add an override to price it. Subscription accounts (GitHub Copilot) count requests and tokens but always cost zero USD.

## Security

- The admin token controls everything: accounts, keys, prices. Use a long random value.
- Router keys are stored only as SHA-256 hashes; the secret is shown once at creation.
- Provider secrets (API keys, OAuth tokens) are stored in plain form in the Durable Object's SQLite storage. They are redacted (`***`) in admin API responses and never sent to the dashboard, but anyone with Cloudflare account access to the Worker's storage can read them.
- If the Worker URL is public, consider protecting `/` and `/admin/*` with Cloudflare Access and adding rate limiting; turnpike has no per-IP limiting of its own.

## Terms of service

Sharing a subscription login (GitHub Copilot) with other people through router keys may violate the provider's terms and put the account at risk. Key allow-lists exist so a friend's key can be limited to API-key accounts. Claude and ChatGPT subscription logins are intentionally not supported: Anthropic's docs forbid routing requests through Free, Pro or Max logins (and the tokens only work from clients that impersonate Claude Code), and OpenAI offers third parties no client registration for Codex-style login that works from a hosted app. A `codex-oauth` kind exists in the code as an unimplemented placeholder and is not offered in the dashboard.

## Known limitations and unverified items

- The default base URLs for `openrouter`, `opencode-zen` and `opencode-go` carry `TODO(verify)` in `src/providers.ts` and have not been confirmed against provider docs. Set a base URL on the account if they are wrong.
- The Copilot client ID, token exchange and editor headers are undocumented and were taken from open-source clients (see the header comment in `src/oauth/copilot.ts`). No live Copilot call has been made; live OAuth has to be tried by hand once.
- The dashboard has only a manual smoke script (`test/dashboard-smoke.md`). No real `wrangler deploy` has been run as part of writing this README.
- `GET /v1/models` lists combos only.
- Combos can be created and overwritten but not deleted; there is no delete route.
- The test suite is not fully offline: tests that reach `reserve` can trigger a real price-refresh request to openrouter.ai. Some tests also print "uncaught exception ... token refresh failed" lines; these come from deliberately failing refreshes and the run still passes.
- `@cloudflare/vitest-pool-workers` is a deprecated package name; vitest prints a migration notice.

## Development

```sh
npm test            # vitest on the Workers pool
npm run typecheck   # tsc --noEmit
```

| Path | Contents |
|---|---|
| `src/index.ts` | Hono app: `/health`, `/admin`, `/v1` |
| `src/auth.ts` | Admin token and router key middleware |
| `src/admin.ts` | Admin API and input validation |
| `src/proxy.ts` | `/v1` handlers, usage recording, 429 cooldown |
| `src/router.ts` | Model resolution and fallback loop |
| `src/providers.ts` | Account kinds, default base URLs, upstream call |
| `src/translate/` | OpenAI and Anthropic request, response and SSE translation |
| `src/hub.ts` | Durable Object: keys, accounts, combos, ledger, limits, prices, token refresh |
| `src/oauth/` | OAuth providers (Copilot device flow) |
| `src/pricing.ts` | Price lookup and OpenRouter refresh |
| `public/` | Dashboard (static HTML and ES modules, no build step) |
| `test/` | Vitest suites and `dashboard-smoke.md` |

The design and task history are in `docs/superpowers/plans/2026-11-22-turnpike.md`.
