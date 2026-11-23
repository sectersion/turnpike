# Dashboard smoke test (manual)

Setup: create `.dev.vars` with `ADMIN_TOKEN=devtoken`, run `npx wrangler dev`, open http://localhost:8787/.
For an upstream, run any OpenAI-compatible stub on http://127.0.0.1:9999 (must answer `POST /chat/completions` with a `usage` object).

1. Page asks for the admin token. Enter a wrong one: any list call returns you to the prompt with an error. Enter `devtoken`. Reload the tab: still signed in (sessionStorage). Open in a new tab: prompted again. The token is never in the URL.
2. Accounts: add kind `custom-openai`, name `stub`, base URL `http://127.0.0.1:9999`, no key. It appears in the table; no secret is shown anywhere. Set RPM 100, Save limits; reload, value persists. Clear it and save: back to "none". Toggle Disabled/Enabled.
3. Combos: create combo `test`, Add target (account `stub`, model `m1`), add a second target, reorder with Up/Down, Remove one, Save combo. Reload: persisted.
4. Keys: create a key `smoke` (leave "All accounts" ticked). The secret appears once in the highlighted box; click Copy. Refresh the tab (switch tabs and back): the secret is gone and not in the list.
5. `curl http://localhost:8787/v1/chat/completions -H "Authorization: Bearer <secret>" -H "content-type: application/json" -d '{"model":"test","messages":[{"role":"user","content":"hi"}]}'` returns the stub's reply.
6. Usage: choose "Today": a row for `smoke` and for `stub` with 1 request and the token counts. Set a price override for `m1` (e.g. 1 / 2) and send another request: USD becomes non-zero.
7. Keys: Revoke `smoke` (confirm). Repeat the curl: 401. Row shows "Revoked".
8. Accounts: Delete `stub` (confirm); it disappears.
9. Layout: at 390px width there is no horizontal page scroll (tables scroll inside their box); check light and dark; Tab key shows focus rings everywhere.
10. Try a combo or account name like `<img src=x onerror=alert(1)>`: it displays as literal text and nothing executes.
11. `curl localhost:8787/health` -> `{"ok":true}`; `/admin/keys` without a token -> 401 JSON (not the dashboard).
