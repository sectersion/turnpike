# turnpike

A self-hosted LLM router for Cloudflare Workers. You add upstream provider accounts, group models into ordered fallback lists ("combos"), and hand out router keys with spend caps. Clients talk to one URL in either the OpenAI or the Anthropic format; turnpike translates between the two when the upstream speaks the other one. State lives in one SQLite-backed Durable Object (`Hub`).

| Route | Purpose | Auth |
|---|---|---|
| `POST /v1/chat/completions` | OpenAI-compatible chat (streaming supported) | router key |
| `POST /v1/messages` | Anthropic-compatible messages (streaming supported) | router key |
| `GET /v1/models` | Lists the combos the key may use (not provider models) | router key |
| `/` | Dashboard (static files in `public/`) | none for the page itself; the admin token is entered in it |
| `/admin/*` | Admin API used by the dashboard | `Authorization: Bearer <ADMIN_TOKEN>` |
| `GET /health` | Returns `{"ok":true}` | none |

Router keys are sent as `Authorization: Bearer <key>` or `x-api-key: <key>`.

## Quick start (local)

```sh
npm install
cp .dev.vars.example .dev.vars   # then edit ADMIN_TOKEN
npm run dev
```

`.dev.vars.example` ships `ADMIN_TOKEN=change-me`. Change it: a left-in example value is the real admin token locally.

Open the URL `wrangler dev` prints (normally http://localhost:8787) and enter the admin token.

## Deploy

```sh
npx wrangler login
npm run deploy
npx wrangler secret put ADMIN_TOKEN
```

`wrangler login` (or a `CLOUDFLARE_API_TOKEN` environment variable) is a prerequisite. Deploy first, then set the secret: until `ADMIN_TOKEN` is set, `/admin/*` answers 503. Running `secret put` on a Worker that has never been deployed may prompt you to create it.

No resource IDs need pasting: `wrangler.jsonc` declares one Durable Object binding (`HUB`, class `Hub`) with a `new_sqlite_classes` migration, plus the static assets directory. `npx wrangler deploy --dry-run` succeeds without any account-specific values. The first deploy prints the Worker URL (`https://turnpike.<your-subdomain>.workers.dev`); that is your base URL below.

To rotate the admin token, run `npx wrangler secret put ADMIN_TOKEN` again with a new value and sign in again with it. If `ADMIN_TOKEN` is unset, `/admin/*` returns 503.

There is no "Deploy to Cloudflare" button; it was not set up or tested.

## First use (dashboard)

1. **Accounts tab, add an account.** Kinds:
   - `openrouter`, `opencode-zen`, `opencode-go`: API key plus a built-in default base URL (see Known limitations).
   - `custom-openai`, `custom-anthropic`: your own endpoint. A base URL is required (https, or http only for localhost/127.0.0.1); the API key is optional.
   - `copilot-oauth` (GitHub Copilot): the dashboard shows a device code and a GitHub URL; approve there and the account is created.

   Optional per-account limits: RPM, TPM, monthly USD. Accounts can be disabled or deleted.
2. **Combos tab, create a combo.** An ordered list of `{account, model}` targets. Requests for the combo name try targets in order and fall through to the next one on a 408, 429 or 5xx, on a network error, and on an account-level failure (401, 402, 403, or any 3xx: redirects are never followed). An account-level failure also puts that account in a 15-minute cooldown for every key. You can also skip combos and request `<account name>/<model>` directly (account name matched case-insensitively), for example `openrouter/anthropic/claude-sonnet-4`.
3. **Keys tab, create a router key.** Name, daily and/or monthly USD caps (UTC day and month) or an explicit "No USD cap" tick, a per-key requests-per-minute limit and a max-in-flight limit (prefilled 30 and 4; clear a field for no limit), and the accounts the key may use. No account is ticked by default; "All API-key accounts" ticks the current non-subscription accounts, and subscription accounts (Copilot) must be ticked one by one. The dashboard always stores an explicit list, so accounts added later are not reachable until you add them. The list shows `UNCAPPED` for keys with no USD cap. The secret (prefix `tpk`) is shown once; copy it then.

   Per-key limits via the API: `POST /admin/keys` takes `rpm` and `maxInFlight` (omitted: 30 and 4; `null`: unlimited); `PATCH /admin/keys/:id` with `{"rpm": 120, "maxInFlight": null}` changes them later. The API itself still accepts a key with no caps and no allow-list (`allowedAccountIds` omitted means every account, including future and subscription ones); only the dashboard enforces the safer defaults.

   **Upgrading an existing deployment:** keys created before these limits existed get 30 rpm and 4 in flight when the Durable Object first starts on the new code (a one-time schema migration). Raise or clear them with `PATCH /admin/keys/:id`.
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

Errors:

- 401 bad key.
- 404 unknown model, also when the model exists but is not on this key's allow-list (same message, so names cannot be probed). Unsupported endpoints (`/v1/embeddings`, `/v1/completions`, `/v1/responses`, `/v1/messages/count_tokens`, ...) are a JSON 404 too.
- 400 for malformed requests, for server-side tools (Anthropic tools with a `type` other than `custom`, such as `web_search_*`, `code_execution_*`, `computer_*`, `bash_*`; OpenAI tools other than `function`), and `limit: unpriced` (a capped key asked for a model with no known price).
- 429 `limit: <reason>` when every target is blocked by a limit: `key_daily`, `key_monthly`, `key_rpm`, `key_inflight`, `account_monthly`, `rpm`, `tpm`, `cooldown`.
- Upstream failures: a 400 or 422 from the upstream is passed through (validation messages). 401, 402, 403 and 3xx become 502 `upstream account error`; other upstream errors keep their status with a generic `upstream error (HTTP n)` message; network errors are 502 `upstream failed`. Upstream bodies and headers (org ids, rate-limit headers, cookies, request ids) never reach the client: only `content-type`, `retry-after` and `cache-control` are forwarded.

## Limits

| Limit | Scope | Behavior |
|---|---|---|
| Daily / monthly USD | per router key | Checked before each request against recorded spend, in-flight reservations and the worst-case cost of this request; the output limit is lowered so that worst case fits what is left (see below). |
| RPM / max in flight | per router key | Rolling 60 seconds (released and failed attempts count) / unsettled requests. New keys: 30 and 4. |
| RPM / TPM | per account | Rolling 60 seconds. TPM counts the estimated input tokens (about 4 characters per token) of the request. |
| Monthly USD | per account | Same check, per account. |
| Upstream 429 | per account | The account goes into cooldown for the upstream `Retry-After` (seconds or HTTP date; default 30 s, capped at 15 min). The request falls through to the next combo target. |
| Upstream 401 / 402 / 403 / 3xx | per account | 15-minute cooldown, fall through to the next target. A shorter cooldown never shortens a running longer one. |

**Output tokens are enforced, not just estimated.** turnpike sets the upstream output limit itself: the client's `max_completion_tokens` or `max_tokens`, or 4096 if it sent neither, never above 32000. If the key (or the account) has a USD cap, the limit is lowered further so that the request's worst-case cost fits the remaining cap; when fewer than 256 output tokens (or the requested amount, if smaller) would fit, the request is refused with `key_daily`, `key_monthly` or `account_monthly`. The same number is reserved and sent upstream; OpenAI `n` is forced to 1. Anthropic `thinking.budget_tokens` is lowered below the clamped `max_tokens` when needed. Reservations are replaced by the real usage when the response completes, or kept at the estimate if the upstream reports none.

Only known chat fields are forwarded. OpenAI format: `model`, `messages`, `max_tokens`, `max_completion_tokens`, `temperature`, `top_p`, `stop`, `stream`, `stream_options`, `tools`, `tool_choice`, `parallel_tool_calls`, `response_format`, `seed`, `frequency_penalty`, `presence_penalty`, `logit_bias`, `logprobs`, `top_logprobs`, `user`, `reasoning_effort`, `n`. Anthropic format: `model`, `messages`, `system`, `max_tokens`, `temperature`, `top_p`, `top_k`, `stop_sequences`, `stream`, `tools`, `tool_choice`, `thinking`, `metadata`. Everything else, notably OpenRouter's `models`, `route`, `provider` and `plugins`, and `service_tier`, `web_search_options`, `audio`/`modalities` and `mcp_servers`, is dropped.

**What a USD cap really bounds.** The output part of every request is hard-capped by the clamp above, and in-flight reservations count against the cap, so concurrent requests cannot jointly exceed it on output. What can still overshoot:

- Input is estimated at about 4 characters per token from `messages` and `system` only (tool definitions are not counted). If the real input is larger, the difference is charged after the fact; with the default 4 requests in flight, the overshoot is at most four requests' worth of under-estimated input.
- Anthropic prompt caching is priced at 1.25x the input price for cache writes and 0.1x for cache reads (the 5-minute cache). One-hour cache writes cost 2x at Anthropic and are undercharged. OpenAI-format upstreams (OpenRouter) count cached tokens at the full input price, which overcharges.
- A stream the client cancels before Anthropic's final usage event is charged at least one output token per ~4 streamed characters, an approximation.
- A request still running after 1 hour, or whose usage never arrives, is charged at its full reservation (clamped output plus input estimate); if its real usage arrives later (within 24 h) it replaces that charge once.
- Caps do not cover unpriced models (see below), and subscription accounts always cost $0.

Pricing: OpenRouter's public model list (`openrouter.ai/api/v1/models`), refreshed daily by the Durable Object, plus manual overrides (Usage tab or `PUT /admin/prices`). Overrides win. An override matches only the exact model string sent upstream (the part after `<account>/`, or the combo target's `model`), so `gpt-4o` does not price `openai/gpt-4o`. The OpenRouter table matches by full id or by the part after the `/`.

"Unpriced" means no price is known for the model. A key with a daily or monthly USD cap is refused for unpriced models (400 `limit: unpriced`); a key with no cap is not. Add an override, with the exact model string, to price it. Account USD caps (`account_monthly`) likewise do not cover unpriced models, because their recorded cost is 0; put an override on any model you want an account cap to cover. Subscription accounts (GitHub Copilot) count requests and tokens but always cost zero USD.

## What is stored

The Durable Object's SQLite holds keys (name, SHA-256 hash, limits), accounts (including provider secrets, see Security), combos, prices, cooldowns, live reservations, and a ledger. Per request the ledger stores: timestamp, key id, account id, model, input and output token counts, cost in USD, and whether the model was priced. No prompts, responses, IP addresses or headers are stored. Ledger rows are kept forever; there is no pruning yet, so the table grows without bound (it is indexed by time, key and account).

## Security

- The admin token controls everything: accounts, keys, prices. Use a long random value.
- Router keys are stored only as SHA-256 hashes; the secret is shown once at creation.
- Provider secrets (API keys, OAuth tokens) are stored in plain form in the Durable Object's SQLite storage. They are redacted (`***`) in admin API responses and never sent to the dashboard, but anyone with Cloudflare account access to the Worker's storage can read them.
- The Worker URL is public (workers.dev, unless you disable it). The dashboard HTML is served without auth; the only gates are the admin token for `/admin/*` and router keys for `/v1/*`. There is no rate limiting, so a weak admin token can be brute-forced. Consider Cloudflare Access in front of `/` and `/admin/*`, and Cloudflare rate limiting rules.
- To cut off a key, use Revoke in the Keys tab (API: `DELETE /admin/keys/:id`). A revoked key gets 401 on `/v1/*`.

## Terms of service

Sharing a subscription login (GitHub Copilot) with other people through router keys may violate the provider's terms and put the account at risk. Key allow-lists exist so a friend's key can be limited to API-key accounts. Claude and ChatGPT subscription logins are intentionally not supported: Anthropic's docs forbid routing requests through Free, Pro or Max logins (and the tokens only work from clients that impersonate Claude Code), and OpenAI offers third parties no client registration for Codex-style login that works from a hosted app. A `codex-oauth` kind exists in the code as an unimplemented placeholder and is not offered in the dashboard.

## Known limitations and unverified items

- The default base URLs for `openrouter`, `opencode-zen` and `opencode-go` carry `TODO(verify)` in `src/providers.ts` and have not been confirmed against provider docs. Set a base URL on the account if they are wrong.
- The Copilot client ID, token exchange and editor headers are undocumented and were taken from open-source clients (see the header comment in `src/oauth/copilot.ts`). No live Copilot call has been made; live OAuth has to be tried by hand once.
- The dashboard has only a manual smoke script (`test/dashboard-smoke.md`). No real `wrangler deploy` has been run as part of writing this README.
- `GET /v1/models` lists combos only.
- Translation gaps when the client and upstream formats differ: `response_format`, `parallel_tool_calls`, `reasoning_effort` and `thinking` are dropped, thinking deltas are not translated, and `tool_result` `is_error` and images inside tool results are lost.
- The OpenRouter price table is empty until the Durable Object's first alarm has fetched it (moments after the first request, retried every 5 minutes on failure). Until then capped keys get `limit: unpriced` for anything without a manual override.
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
| `src/proxy.ts` | `/v1` handlers, usage recording, cooldowns, upstream error and header filtering |
| `src/router.ts` | Model resolution and fallback loop |
| `src/providers.ts` | Account kinds, default base URLs, request allow-list and output clamp, upstream call |
| `src/translate/` | OpenAI and Anthropic request, response and SSE translation |
| `src/hub.ts` | Durable Object: keys, accounts, combos, ledger, limits, prices, token refresh |
| `src/oauth/` | OAuth providers (Copilot device flow) |
| `src/pricing.ts` | Price lookup and OpenRouter refresh |
| `public/` | Dashboard (static HTML and ES modules, no build step) |
| `test/` | Vitest suites and `dashboard-smoke.md` |

The design and task history are in `docs/superpowers/plans/2026-11-22-turnpike.md`.
