# Dashboard smoke test (manual)

Setup: create `.dev.vars` with `ADMIN_TOKEN=devtoken`, run `npx wrangler dev`, open http://localhost:8787/.
For an upstream, run any OpenAI-compatible stub on http://127.0.0.1:9999 (must answer `POST /chat/completions` with a `usage` object).

1. Page asks for the admin token. Enter a wrong one: any list call returns you to the prompt with an error. Enter `devtoken`. Reload the tab: still signed in (sessionStorage). Open in a new tab: prompted again. The token is never in the URL.
2. Accounts: add kind `custom-openai`, name `stub`, base URL `http://127.0.0.1:9999`, no key. It appears in the table; no secret is shown anywhere. Set RPM 100, Save limits; reload, value persists. Clear it and save: back to "none". Toggle Disabled/Enabled.
3. Combos: create combo `test`, Add target (account `stub`, model `m1`), add a second target, reorder with Up/Down, Remove one, Save combo. Reload: persisted.
4. Keys: the form starts with no account ticked, RPM 30 and max in flight 4. Submitting with no cap and "No USD cap" unticked shows an error; so does submitting with no account ticked. "All API-key accounts" ticks every account except Copilot ones. Create a key `smoke` with "No USD cap" ticked and the `stub` account ticked: the list shows UNCAPPED, RPM 30, in flight 4. The secret appears once in the highlighted box; click Copy. Refresh the tab (switch tabs and back): the secret is gone and not in the list.
5. `curl http://localhost:8787/v1/chat/completions -H "Authorization: Bearer <secret>" -H "content-type: application/json" -d '{"model":"test","messages":[{"role":"user","content":"hi"}]}'` returns the stub's reply.
6. Usage: choose "Today": the tiles show 1 request and the token counts, the charts draw (hover shows a crosshair and tooltip; arrow keys step through points; the Table button swaps in the same data), and the breakdown lists `smoke` and `stub`. Because `m1` is unpriced, a notice offers a price override: click the model name, fill 1 / 2, Set price, send another request: spend becomes non-zero.
7. Keys: Revoke `smoke` (a dialog asks to confirm; Esc and Cancel both keep the key). Repeat the curl: 401. Row shows "Revoked".
8. Combos: create `smoke-combo` with a `stub` target, Save, then Delete combo (dialog): it disappears. Accounts: Delete `stub` (dialog); it disappears and the empty state shows. "Download backup" saves a JSON file that contains no provider secret.
9. Layout: at 390px width there is no horizontal page scroll (tables scroll inside their box); check light and dark; Tab key shows focus rings everywhere.
10. Try a combo or account name like `<img src=x onerror=alert(1)>`: it displays as literal text and nothing executes.
11. `curl localhost:8787/health` -> `{"ok":true}`; `/admin/keys` without a token -> 401 JSON (not the dashboard).
