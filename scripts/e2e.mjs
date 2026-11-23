// End-to-end smoke test against a running `wrangler dev` and scripts/stub-upstream.mjs.
import assert from "node:assert/strict";

const BASE = process.env.BASE ?? "http://127.0.0.1:8787";
const TOKEN = process.env.ADMIN_TOKEN ?? "e2e-admin-token";
const STUB = process.env.STUB ?? "http://127.0.0.1:9101";
const T = Date.now().toString(36);
const results = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function check(name, fn) {
  try { await fn(); results.push([name, true]); console.log(`PASS  ${name}`); }
  catch (e) { results.push([name, false, e.message]); console.log(`FAIL  ${name}\n      ${String(e.message).split("\n").slice(0, 6).join("\n      ")}`); }
}
const raw = async (method, path, { token, body, headers = {}, signal } = {}) => {
  const h = { ...headers };
  if (token) h.authorization = `Bearer ${token}`;
  if (body !== undefined) h["content-type"] = "application/json";
  return fetch(BASE + path, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body), signal });
};
const jr = async (res) => { const text = await res.text(); let json; try { json = JSON.parse(text); } catch {} return { status: res.status, text, json, headers: res.headers }; };
const admin = async (method, path, body) => jr(await raw(method, "/admin" + path, { token: TOKEN, body }));
const oai = async (key, body) => jr(await raw("POST", "/v1/chat/completions", { token: key, body }));
const ant = async (key, body) => jr(await raw("POST", "/v1/messages", { token: key, body }));
const stubReqs = async () => (await fetch(STUB + "/__requests")).json();
const stubClear = () => fetch(STUB + "/__requests", { method: "DELETE" });
const sseEvents = (text) => text.split("\n\n").filter(Boolean).map((blk) => {
  const ev = blk.match(/^event: (.*)$/m)?.[1];
  const data = blk.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).join("\n");
  let j; try { j = JSON.parse(data); } catch {}
  return { ev, data, j };
});
const mkAccount = async (name, kind, path, extra = {}, secret = `sk-${name}`) => {
  const r = await admin("POST", "/accounts", { kind, name, baseUrl: STUB + path, secret, ...extra });
  assert.equal(r.status, 201, r.text);
  return r.json.id;
};
const mkKey = async (name, extra = {}) => {
  const r = await admin("POST", "/keys", { name: `${name}-${T}`, ...extra });
  assert.equal(r.status, 201, r.text);
  return { id: r.json.key.id, secret: r.json.secret };
};
const mkCombo = async (name, targets) => assert.equal((await admin("PUT", "/combos", { name, targets })).status, 200);
const setPrice = async (model, inPerM, outPerM) => assert.equal((await admin("PUT", "/prices", { model, inPerM, outPerM })).status, 200);
const msg = (text, extra = {}) => ({ messages: [{ role: "user", content: text }], ...extra });
const usageFor = async (id, kind) => (await admin("GET", "/usage?since=0")).json[kind].find((r) => r.id === id);

const state = {};
console.log(`turnpike e2e  BASE=${BASE} STUB=${STUB} run=${T}`);

// ---------------- Platform ----------------
await check("platform: /health", async () => {
  const r = await jr(await raw("GET", "/health"));
  assert.equal(r.status, 200); assert.deepEqual(r.json, { ok: true });
});
await check("platform: / serves dashboard with <title> and CSP meta", async () => {
  const r = await jr(await raw("GET", "/"));
  assert.equal(r.status, 200); assert.match(r.headers.get("content-type"), /html/);
  assert.match(r.text, /<title>/); assert.match(r.text, /Content-Security-Policy/);
});
await check("platform: /app.js and /style.css served", async () => {
  const a = await jr(await raw("GET", "/app.js")), s = await jr(await raw("GET", "/style.css"));
  assert.equal(a.status, 200); assert.match(a.headers.get("content-type"), /javascript/);
  assert.equal(s.status, 200); assert.match(s.headers.get("content-type"), /css/);
  state.appjs = a.text;
});
await check("platform: dashboard has four tab labels (static check of app.js only; NO browser)", async () => {
  for (const t of ["Accounts", "Keys", "Combos", "Usage"]) assert.ok(state.appjs.includes(t), t);
});
await check("platform: /admin/nope and /v1/nope are JSON, not HTML", async () => {
  for (const [p, token] of [["/admin/nope", undefined], ["/admin/nope", TOKEN], ["/v1/nope", undefined]]) {
    const res = await raw("GET", p, { token });
    assert.ok([401, 404].includes(res.status), `${p} -> ${res.status}`);
    const t = await res.text();
    assert.ok(!/<html|<!doctype/i.test(t), `${p} returned HTML`);
    if (res.status === 401) assert.deepEqual(JSON.parse(t), { error: "unauthorized" });
  }
});
await check("platform: /admin/keys 401 without and with wrong token", async () => {
  assert.equal((await raw("GET", "/admin/keys")).status, 401);
  assert.equal((await raw("GET", "/admin/keys", { token: "wrong" })).status, 401);
  assert.equal((await raw("GET", "/admin/keys", { token: TOKEN })).status, 200);
});

// ---------------- Admin validation ----------------
const OKN = `ok-${T}`, ANN = `anth-${T}`;
const OKKEY = `sk-secret-ok-${T}`, ANKEY = `sk-secret-anth-${T}`;
await check("admin: create custom-openai and custom-anthropic accounts (secret redacted in response)", async () => {
  const a = await admin("POST", "/accounts", { kind: "custom-openai", name: OKN, baseUrl: `${STUB}/ok/v1`, secret: OKKEY });
  assert.equal(a.status, 201, a.text); assert.equal(a.json.secret, "***"); assert.ok(!a.text.includes(OKKEY));
  state.ok = a.json.id;
  const b = await admin("POST", "/accounts", { kind: "custom-anthropic", name: ANN, baseUrl: `${STUB}/anthropic/v1`, secret: { apiKey: ANKEY } });
  assert.equal(b.status, 201, b.text); assert.ok(!b.text.includes(ANKEY));
  state.anth = b.json.id;
});
await check("admin: rejects bad baseUrl userinfo trick, bad kind, oauth kinds, non-loopback http; client id not honoured", async () => {
  const base = { name: `x-${T}`, secret: "k" };
  const cases = [
    { kind: "custom-openai", baseUrl: "http://localhost:80@evil.com" },
    { kind: "nonsense", baseUrl: STUB },
    { kind: "copilot-oauth", baseUrl: "https://x.example" },
    { kind: "codex-oauth" },
    { kind: "custom-openai", baseUrl: "http://example.com/v1" },
    { kind: "custom-openai", baseUrl: `${STUB}/ok/v1`, id: "client-chosen-id" },
  ];
  for (const c of cases) {
    const r = await admin("POST", "/accounts", { ...base, ...c });
    if (c.id && r.status === 201) { assert.notEqual(r.json.id, c.id, "client-supplied id was honoured"); await admin("DELETE", `/accounts/${r.json.id}`); continue; }
    assert.equal(r.status, 400, `${JSON.stringify(c)} -> ${r.status} ${r.text}`);
  }
});
await check("admin: list endpoints never contain secrets", async () => {
  const a = await admin("GET", "/accounts");
  assert.equal(a.status, 200);
  assert.ok(!a.text.includes(OKKEY) && !a.text.includes(ANKEY));
  assert.equal(a.json.find((x) => x.id === state.ok).secret, "***");
});
await check("admin: PATCH ignores kind/secret/id, 404 on unknown id", async () => {
  const p = await admin("PATCH", `/accounts/${state.ok}`, { kind: "custom-anthropic", rpm: 1000, secret: "hijack", id: "zzz" });
  assert.equal(p.status, 200, p.text);
  assert.equal(p.json.kind, "custom-openai"); assert.equal(p.json.id, state.ok); assert.equal(p.json.rpm, 1000);
  assert.equal((await admin("PATCH", "/accounts/nonexistent", { rpm: 1 })).status, 404);
});

// ---------------- Keys ----------------
await check("keys: secret shown once, list never contains it, caps stored", async () => {
  const r = await admin("POST", "/keys", { name: `main-${T}` });
  assert.equal(r.status, 201); assert.match(r.json.secret, /^tpk/);
  state.main = { id: r.json.key.id, secret: r.json.secret };
  const l = await admin("GET", "/keys");
  assert.ok(!l.text.includes(state.main.secret)); assert.ok(l.json.some((k) => k.id === state.main.id));
  const c = await admin("POST", "/keys", { name: `caps-${T}`, dailyUsd: 5, monthlyUsd: 50 });
  assert.equal(c.json.key.dailyUsd, 5); assert.equal(c.json.key.monthlyUsd, 50);
  assert.equal((await admin("POST", "/keys", { name: "" })).status, 400);
});
const CO = `c-ok-${T}`, CA = `c-anth-${T}`;
await mkCombo(CO, [{ accountId: state.ok, model: "gpt-ok" }]);
await mkCombo(CA, [{ accountId: state.anth, model: "claude-stub" }]);
await check("keys: revoked key gets 401", async () => {
  const k = await mkKey("revoke");
  assert.equal((await oai(k.secret, msg("hi", { model: CO }))).status, 200);
  assert.equal((await admin("DELETE", `/keys/${k.id}`)).status, 200);
  assert.equal((await oai(k.secret, msg("hi", { model: CO }))).status, 401);
});

// ---------------- Proxy basics ----------------
const tool = { type: "function", function: { name: "get_weather", parameters: { type: "object", properties: { city: { type: "string" } } } } };
const atool = { name: "get_weather", description: "w", input_schema: { type: "object", properties: { city: { type: "string" } } } };

await check("proxy: OpenAI -> openai-style stub: shape, model rewrite, Bearer key", async () => {
  await stubClear();
  const r = await oai(state.main.secret, msg("hello", { model: CO }));
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.choices[0].message.content, "Hello from stub");
  assert.deepEqual([r.json.usage.prompt_tokens, r.json.usage.completion_tokens], [11, 7]);
  const log = await stubReqs();
  assert.equal(log.length, 1); assert.equal(log[0].url, "/ok/v1/chat/completions");
  assert.equal(log[0].body.model, "gpt-ok"); assert.equal(log[0].authorization, `Bearer ${OKKEY}`);
});
await check("proxy: PATCHed account still sends original secret", async () => {
  await stubClear();
  assert.equal((await oai(state.main.secret, msg("hello", { model: CO }))).status, 200);
  assert.equal((await stubReqs())[0].authorization, `Bearer ${OKKEY}`);
});
await check("proxy: direct 'account/model' form routes without a combo", async () => {
  await stubClear();
  const r = await oai(state.main.secret, msg("hello", { model: `${OKN}/direct-model` }));
  assert.equal(r.status, 200, r.text);
  assert.equal((await stubReqs())[0].body.model, "direct-model");
});
await check("proxy: Anthropic client -> openai-style stub returns Anthropic shape", async () => {
  await stubClear();
  const r = await ant(state.main.secret, { model: CO, max_tokens: 50, messages: [{ role: "user", content: "hello" }] });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.type, "message"); assert.equal(r.json.role, "assistant");
  assert.equal(r.json.content[0].type, "text"); assert.equal(r.json.content[0].text, "Hello from stub");
  assert.deepEqual([r.json.usage.input_tokens, r.json.usage.output_tokens], [11, 7]);
  const l = (await stubReqs())[0]; assert.equal(l.url, "/ok/v1/chat/completions"); assert.equal(l.body.model, "gpt-ok");
});
await check("proxy: OpenAI client -> anthropic-style stub (translation), x-api-key + version", async () => {
  await stubClear();
  const r = await oai(state.main.secret, msg("hello", { model: CA, max_tokens: 50 }));
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.choices[0].message.content, "Hello from stub");
  assert.deepEqual([r.json.usage.prompt_tokens, r.json.usage.completion_tokens], [11, 7]);
  const l = (await stubReqs())[0];
  assert.equal(l.url, "/anthropic/v1/messages"); assert.equal(l["x-api-key"], ANKEY);
  assert.equal(l["anthropic-version"], "2023-06-01"); assert.equal(l.body.model, "claude-stub");
});
await check("proxy: Anthropic client -> anthropic stub passthrough", async () => {
  const r = await ant(state.main.secret, { model: CA, max_tokens: 50, messages: [{ role: "user", content: "hello" }] });
  assert.equal(r.status, 200, r.text); assert.equal(r.json.content[0].text, "Hello from stub");
});

const streamOai = async (model, extra = {}) => {
  const res = await raw("POST", "/v1/chat/completions", { token: state.main.secret, body: msg("hello", { model, stream: true, max_tokens: 50, ...extra }) });
  assert.equal(res.status, 200); return { text: await res.text() };
};
const streamAnt = async (model, extra = {}) => {
  const res = await raw("POST", "/v1/messages", { token: state.main.secret, body: { model, max_tokens: 50, stream: true, messages: [{ role: "user", content: "hello" }], ...extra } });
  assert.equal(res.status, 200); return { text: await res.text() };
};
const oaiAssert = (text) => {
  const ev = sseEvents(text);
  assert.equal(ev.at(-1).data, "[DONE]");
  assert.equal(ev.map((e) => e.j?.choices?.[0]?.delta?.content ?? "").join(""), "Hello from stub");
  const u = ev.map((e) => e.j?.usage).filter(Boolean).at(-1);
  assert.deepEqual([u.prompt_tokens, u.completion_tokens], [11, 7]);
};
const antAssert = (text) => {
  const ev = sseEvents(text);
  assert.deepEqual(ev.map((e) => e.ev).filter((x) => ["message_start", "message_delta", "message_stop"].includes(x)), ["message_start", "message_delta", "message_stop"]);
  assert.equal(ev.at(-1).ev, "message_stop");
  assert.equal(ev.map((e) => e.j?.delta?.text ?? "").join(""), "Hello from stub");
  assert.equal(ev.find((e) => e.ev === "message_delta").j.usage.output_tokens, 7);
};
await check("stream: OpenAI client <- openai stub (usage chunk, [DONE], include_usage forwarded)", async () => {
  await stubClear(); oaiAssert((await streamOai(CO)).text);
  assert.equal((await stubReqs())[0].body.stream_options.include_usage, true);
});
await check("stream: Anthropic client <- openai stub", async () => { antAssert((await streamAnt(CO)).text); });
await check("stream: OpenAI client <- anthropic stub", async () => { oaiAssert((await streamOai(CA)).text); });
await check("stream: Anthropic client <- anthropic stub", async () => { antAssert((await streamAnt(CA)).text); });
await check("tools: OpenAI client -> anthropic stub -> tool_calls (non-stream)", async () => {
  await stubClear();
  const r = await oai(state.main.secret, msg("please use the tool", { model: CA, max_tokens: 50, tools: [tool] }));
  assert.equal(r.status, 200, r.text);
  const c = r.json.choices[0]; assert.equal(c.finish_reason, "tool_calls");
  assert.equal(c.message.tool_calls[0].function.name, "get_weather");
  assert.deepEqual(JSON.parse(c.message.tool_calls[0].function.arguments), { city: "Paris" });
  assert.equal((await stubReqs())[0].body.tools[0].name, "get_weather");
});
await check("tools: OpenAI client -> anthropic stub -> tool_calls (stream)", async () => {
  const { text } = await streamOai(CA, { messages: [{ role: "user", content: "use the tool" }], tools: [tool] });
  const ev = sseEvents(text);
  const calls = ev.flatMap((e) => e.j?.choices?.[0]?.delta?.tool_calls ?? []);
  assert.equal(calls[0].function.name, "get_weather");
  assert.deepEqual(JSON.parse(calls.map((c) => c.function.arguments ?? "").join("")), { city: "Paris" });
  assert.ok(ev.some((e) => e.j?.choices?.[0]?.finish_reason === "tool_calls"));
});
await check("tools: Anthropic client -> openai stub -> tool_use", async () => {
  const r = await ant(state.main.secret, { model: CO, max_tokens: 50, tools: [atool], messages: [{ role: "user", content: "use the tool" }] });
  assert.equal(r.status, 200, r.text);
  const b = r.json.content.find((x) => x.type === "tool_use");
  assert.equal(b.name, "get_weather"); assert.deepEqual(b.input, { city: "Paris" }); assert.equal(r.json.stop_reason, "tool_use");
});

// ---------------- Routing ----------------
const rateId = await mkAccount(`rate-${T}`, "custom-openai", "/rate/v1");
const boomId = await mkAccount(`boom-${T}`, "custom-openai", "/boom/v1");
const badId = await mkAccount(`bad-${T}`, "custom-openai", "/bad/v1");
const hits = (log, prefix) => log.filter((l) => l.url.startsWith(prefix)).length;

await mkCombo(`c-fb-${T}`, [{ accountId: rateId, model: "m" }, { accountId: state.ok, model: "gpt-ok" }]);
await check("routing: [rate, ok] falls through 429; rate hit once", async () => {
  await stubClear();
  const r = await oai(state.main.secret, msg("hi", { model: `c-fb-${T}` }));
  assert.equal(r.status, 200, r.text); assert.equal(r.json.choices[0].message.content, "Hello from stub");
  const log = await stubReqs(); assert.equal(hits(log, "/rate/"), 1); assert.equal(hits(log, "/ok/"), 1);
});
await check("routing: 429 sets cooldown from Retry-After (2s): next request skips rate; hit again after expiry", async () => {
  await sleep(300); await stubClear();
  assert.equal((await oai(state.main.secret, msg("hi", { model: `c-fb-${T}` }))).status, 200);
  let log = await stubReqs(); assert.equal(hits(log, "/rate/"), 0, "rate account hit during cooldown"); assert.equal(hits(log, "/ok/"), 1);
  await sleep(2300); await stubClear();
  assert.equal((await oai(state.main.secret, msg("hi", { model: `c-fb-${T}` }))).status, 200);
  log = await stubReqs(); assert.equal(hits(log, "/rate/"), 1, "cooldown should follow Retry-After (2s), not the 30s default");
});
await mkCombo(`c-boom-${T}`, [{ accountId: boomId, model: "m" }, { accountId: state.ok, model: "gpt-ok" }]);
await check("routing: [boom, ok] falls through a 500", async () => {
  await stubClear();
  const r = await oai(state.main.secret, msg("hi", { model: `c-boom-${T}` }));
  assert.equal(r.status, 200, r.text);
  const log = await stubReqs(); assert.equal(hits(log, "/boom/"), 1); assert.equal(hits(log, "/ok/"), 1);
});
await mkCombo(`c-bad-${T}`, [{ accountId: badId, model: "m" }, { accountId: state.ok, model: "gpt-ok" }]);
await check("routing: upstream 400 returned as-is, later targets not tried", async () => {
  await stubClear();
  const r = await oai(state.main.secret, msg("hi", { model: `c-bad-${T}` }));
  assert.equal(r.status, 400); assert.deepEqual(r.json, { error: { message: "bad request from stub" } });
  assert.equal(hits(await stubReqs(), "/ok/"), 0);
});
await check("routing: unknown model -> 404 in client's own error style", async () => {
  const a = await oai(state.main.secret, msg("hi", { model: `nope-${T}` }));
  assert.equal(a.status, 404); assert.equal(a.json.error.type, "not_found_error"); assert.equal(a.json.error.message, `unknown model: nope-${T}`);
  const b = await ant(state.main.secret, { model: `nope-${T}`, max_tokens: 5, messages: [{ role: "user", content: "hi" }] });
  assert.equal(b.status, 404); assert.deepEqual(b.json, { type: "error", error: { type: "not_found_error", message: `unknown model: nope-${T}` } });
});
await check("routing: allow-list excluding the account -> 404 (both styles, no model probing), allowed account works", async () => {
  const k = await mkKey("allow", { allowedAccountIds: [state.anth] });
  const a = await oai(k.secret, msg("hi", { model: CO }));
  assert.equal(a.status, 404); assert.equal(a.json.error.type, "not_found_error");
  const b = await ant(k.secret, { model: CO, max_tokens: 5, messages: [{ role: "user", content: "hi" }] });
  assert.equal(b.status, 404); assert.equal(b.json.type, "error");
  assert.equal((await oai(k.secret, msg("hi", { model: CA, max_tokens: 5 }))).status, 200);
});

// ---------------- Limits and ledger ----------------
const PM = `priced-${T}`, UM = `unpriced-${T}`;
await mkCombo(`c-priced-${T}`, [{ accountId: state.ok, model: PM }]);
await mkCombo(`c-unp-${T}`, [{ accountId: state.ok, model: UM }]);
await setPrice(PM, 1000, 3000);
await check("limits: dailyUsd 0 refused (429 key_daily) for priced model, stub not hit", async () => {
  const k = await mkKey("zero", { dailyUsd: 0 });
  await stubClear();
  const r = await oai(k.secret, msg("hi", { model: `c-priced-${T}`, max_tokens: 10 }));
  assert.equal(r.status, 429); assert.equal(r.json.error.message, "limit: key_daily");
  assert.equal((await stubReqs()).length, 0);
});
await check("limits: unpriced model refused for capped key, allowed for uncapped key", async () => {
  const k = await mkKey("capped", { dailyUsd: 100 });
  await stubClear();
  const r = await oai(k.secret, msg("hi", { model: `c-unp-${T}`, max_tokens: 10 }));
  assert.equal(r.status, 400); assert.ok(r.json.error.message.startsWith("limit: unpriced"));
  assert.equal((await stubReqs()).length, 0);
  assert.equal((await oai(state.main.secret, msg("hi", { model: `c-unp-${T}`, max_tokens: 10 }))).status, 200);
});
const pollUsage = async (id, kind, n) => {
  for (let i = 0; i < 25; i++) { const u = await usageFor(id, kind); if (u && u.requests >= n) return u; await sleep(200); }
  return usageFor(id, kind);
};
await check("limits: price override + budget -> usage shows requests, tokens, cost = tokens x price", async () => {
  const k = await mkKey("budget", { dailyUsd: 10 });
  for (let i = 0; i < 2; i++) assert.equal((await oai(k.secret, msg("hi", { model: `c-priced-${T}`, max_tokens: 10 }))).status, 200);
  const u = await pollUsage(k.id, "byKey", 2);
  assert.equal(u.requests, 2); assert.equal(u.inTokens, 22); assert.equal(u.outTokens, 14);
  const want = (22 * 1000 + 14 * 3000) / 1e6;
  assert.ok(u.costUsd > 0 && Math.abs(u.costUsd - want) < 1e-9, `cost ${u.costUsd} want ${want}`);
});
await check("limits: streamed request is recorded with usage from the stream", async () => {
  const k = await mkKey("streamusage", { dailyUsd: 10 });
  const res = await raw("POST", "/v1/chat/completions", { token: k.secret, body: msg("hi", { model: `c-priced-${T}`, max_tokens: 10, stream: true }) });
  await res.text();
  const u = await pollUsage(k.id, "byKey", 1);
  assert.deepEqual([u.requests, u.inTokens, u.outTokens], [1, 11, 7]);
});
await check("limits: account rpm 2 accepts 2 then refuses 3rd with 'rpm' (recovery after window: unit tests)", async () => {
  const id = await mkAccount(`rpm-${T}`, "custom-openai", "/ok/v1", { rpm: 2 });
  await mkCombo(`c-rpm-${T}`, [{ accountId: id, model: "gpt-ok" }]);
  const s = [];
  for (let i = 0; i < 3; i++) s.push(await oai(state.main.secret, msg("hi", { model: `c-rpm-${T}` })));
  assert.deepEqual(s.map((r) => r.status), [200, 200, 429]); assert.equal(s[2].json.error.message, "limit: rpm");
});
await check("limits: account monthlyUsd cap refuses once exceeded", async () => {
  const id = await mkAccount(`mon-${T}`, "custom-openai", "/ok/v1", { monthlyUsd: 0.05 });
  await mkCombo(`c-mon-${T}`, [{ accountId: id, model: PM }]);
  const a = await oai(state.main.secret, msg("hi", { model: `c-mon-${T}`, max_tokens: 10 }));
  assert.equal(a.status, 200, a.text);
  await pollUsage(id, "byAccount", 1);
  const b = await oai(state.main.secret, msg("hi", { model: `c-mon-${T}`, max_tokens: 10 }));
  assert.equal(b.status, 429); assert.equal(b.json.error.message, "limit: account_monthly");
});

// ---------------- Cancel mid-stream ----------------
const slowId = await mkAccount(`slow-${T}`, "custom-openai", "/slow/v1");
const SM = `slow-model-${T}`;
await mkCombo(`c-slow-${T}`, [{ accountId: slowId, model: SM }]);
await setPrice(SM, 1000, 1000);
await check("cancel: aborting mid-stream still records exactly one usage row", async () => {
  const k = await mkKey("cancel", { dailyUsd: 100 });
  const ac = new AbortController();
  const res = await raw("POST", "/v1/chat/completions", { token: k.secret, signal: ac.signal, body: msg("hi", { model: `c-slow-${T}`, max_tokens: 20, stream: true }) });
  assert.equal(res.status, 200);
  const reader = res.body.getReader();
  const first = await reader.read(); assert.ok(first.value?.length > 0);
  const t0 = Date.now();
  await reader.cancel().catch(() => {}); ac.abort();
  const u = await pollUsage(k.id, "byKey", 1);
  state.cancelMs = Date.now() - t0;
  assert.ok(u, "no usage row recorded"); assert.equal(u.requests, 1);
  await sleep(3500); // stub would have finished by now; make sure no second row appears
  assert.equal((await usageFor(k.id, "byKey")).requests, 1, "usage recorded more than once");
});

// ---------------- Concurrency ----------------
const CM = `conc-model-${T}`;
await mkCombo(`c-conc-${T}`, [{ accountId: slowId, model: CM }]);
await setPrice(CM, 1000, 1000);
await check("concurrency: 10 parallel requests vs daily cap ~3 estimates", async () => {
  const k = await mkKey("conc", { dailyUsd: 3.5 });
  const one = async () => {
    const res = await raw("POST", "/v1/chat/completions", { token: k.secret, body: msg("hello", { model: `c-conc-${T}`, max_tokens: 1000, stream: true }) });
    await res.text(); return res.status;
  };
  const st = await Promise.all(Array.from({ length: 10 }, one));
  const ok = st.filter((s) => s === 200).length, lim = st.filter((s) => s === 429).length;
  state.conc = { admitted: ok, refused: lim, statuses: st.join(","), estEach: "~1.009", cap: 3.5, theoretical: 3 };
  console.log(`      observed: admitted=${ok} refused=${lim} (cap 3.5, est ~1.009 each => 3 allowed; bound 4)`);
  assert.equal(ok + lim, 10, st.join(","));
  assert.ok(ok <= 4, `admitted ${ok} > cap + one in-flight estimate`);
  assert.ok(ok >= 1);
});

// ---------------- Summary ----------------
const failed = results.filter((r) => !r[1]);
console.log(`\n==== ${results.length - failed.length}/${results.length} passed, ${failed.length} failed ====`);
for (const f of failed) console.log(`FAILED: ${f[0]}`);
console.log("NOTE: dashboard UI not verified in a browser (served-content checks only).");
process.exit(failed.length ? 1 : 0);
