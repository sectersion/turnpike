import { SELF, env, runInDurableObject } from "cloudflare:test";
import { it, expect } from "vitest";
import app from "../src/index";
import { hub } from "../src/hub-client";

const A = { authorization: "Bearer test-admin", "content-type": "application/json" };
const mk = async (name = "k") =>
  (await (await SELF.fetch("http://x/admin/keys", { method: "POST", headers: A, body: JSON.stringify({ name }) })).json()) as any;

it("admin returns 503 when ADMIN_TOKEN unset", async () => {
  const res = await app.fetch(new Request("http://x/admin/keys"), { ...env, ADMIN_TOKEN: undefined });
  expect(res.status).toBe(503);
});

it("admin returns 401 with wrong token", async () => {
  const res = await SELF.fetch("http://x/admin/keys", { headers: { authorization: "Bearer nope" } });
  expect(res.status).toBe(401);
  expect((await SELF.fetch("http://x/admin/keys")).status).toBe(401);
});

it("POST /admin/keys returns secret once, GET never does", async () => {
  const created = await mk();
  expect(created.secret).toMatch(/^tpk/);
  const list = await (await SELF.fetch("http://x/admin/keys", { headers: A })).text();
  expect(list).toContain(created.key.id);
  expect(list).not.toContain(created.secret);
  expect(list).not.toContain("secret");
});

it("/v1/models returns 401 without a key and 200 with a valid one", async () => {
  const { secret } = await mk();
  expect((await SELF.fetch("http://x/v1/models")).status).toBe(401);
  expect((await SELF.fetch("http://x/v1/models", { headers: { authorization: `Bearer ${secret}` } })).status).toBe(200);
  expect((await SELF.fetch("http://x/v1/models", { headers: { "x-api-key": secret } })).status).toBe(200);
});

it("revoked key returns 401", async () => {
  const { key, secret } = await mk();
  const del = await SELF.fetch(`http://x/admin/keys/${key.id}`, { method: "DELETE", headers: A });
  expect(del.status).toBe(200);
  expect((await SELF.fetch("http://x/v1/models", { headers: { authorization: `Bearer ${secret}` } })).status).toBe(401);
});

it("accounts are redacted and combos round-trip", async () => {
  const r = await SELF.fetch("http://x/admin/accounts", {
    method: "POST",
    headers: A,
    body: JSON.stringify({ kind: "openrouter", name: "or", authType: "apikey", secret: "sk-real" }),
  });
  const acc = (await r.json()) as any;
  expect(acc.secret).toBe("***");
  const list = await (await SELF.fetch("http://x/admin/accounts", { headers: A })).text();
  expect(list).not.toContain("sk-real");
  await SELF.fetch("http://x/admin/combos", { method: "PUT", headers: A, body: JSON.stringify({ name: "c", targets: [{ accountId: "a", model: "m" }] }) });
  const combos = (await (await SELF.fetch("http://x/admin/combos", { headers: A })).json()) as any[];
  expect(combos.some((c) => c.name === "c")).toBe(true);
  expect((await SELF.fetch(`http://x/admin/accounts/${acc.id}`, { method: "DELETE", headers: A })).status).toBe(200);
});

const call = (path: string, method: string, body?: unknown, headers: Record<string, string> = A) =>
  SELF.fetch(`http://x${path}`, { method, headers, body: typeof body === "string" ? body : body === undefined ? undefined : JSON.stringify(body) });
const mkAcc = async (extra: object = {}) =>
  (await (await call("/admin/accounts", "POST", { kind: "openrouter", name: "or", authType: "apikey", secret: "sk-keep", ...extra })).json()) as any;

it("new admin routes require the admin token", async () => {
  const bad = { "content-type": "application/json" };
  expect((await call("/admin/usage", "GET", undefined, bad)).status).toBe(401);
  expect((await call("/admin/prices", "PUT", { model: "m", inPerM: 1, outPerM: 1 }, bad)).status).toBe(401);
  expect((await call("/admin/accounts/x", "PATCH", {}, bad)).status).toBe(401);
});

it("GET /admin/usage returns byKey and byAccount", async () => {
  const r = await call("/admin/usage?since=0", "GET");
  expect(r.status).toBe(200);
  const b = (await r.json()) as any;
  expect(Array.isArray(b.byKey)).toBe(true);
  expect(Array.isArray(b.byAccount)).toBe(true);
  expect((await call("/admin/usage", "GET")).status).toBe(200);
  expect((await call("/admin/usage?since=abc", "GET")).status).toBe(400);
});

it("PUT /admin/prices validates numbers", async () => {
  expect((await call("/admin/prices", "PUT", { model: "m1", inPerM: 1, outPerM: 2 })).status).toBe(200);
  for (const bad of [{ model: "", inPerM: 1, outPerM: 1 }, { model: "m", inPerM: -1, outPerM: 1 }, { model: "m", inPerM: "1", outPerM: 1 }, { model: "m", inPerM: 1 }])
    expect((await call("/admin/prices", "PUT", bad)).status).toBe(400);
});

it("PATCH /admin/accounts/:id merges, clears with null, never touches the secret", async () => {
  const a = await mkAcc();
  const r = await call(`/admin/accounts/${a.id}`, "PATCH", { rpm: 5, monthlyUsd: 10, enabled: false, name: "new", secret: "evil" });
  expect(r.status).toBe(200);
  const b = (await r.json()) as any;
  expect(b).toMatchObject({ id: a.id, rpm: 5, monthlyUsd: 10, enabled: false, name: "new", secret: "***" });
  const c = (await (await call(`/admin/accounts/${a.id}`, "PATCH", { rpm: null })).json()) as any;
  expect(c.rpm).toBeUndefined();
  expect(c.monthlyUsd).toBe(10);
  expect((await hub(env).getAccount(a.id))?.secret).toBe("sk-keep");
  expect((await call(`/admin/accounts/${a.id}`, "PATCH", { rpm: -1 })).status).toBe(400);
  expect((await call("/admin/accounts/nope", "PATCH", { rpm: 1 })).status).toBe(404);
  expect((await call(`/admin/accounts/${a.id}`, "PATCH", "{bad")).status).toBe(400);
});

it("POST /admin/accounts validates input", async () => {
  const post = (b: object) => call("/admin/accounts", "POST", b);
  const ok = { kind: "openrouter", name: "n", authType: "apikey", secret: "k" };
  expect((await post({ ...ok, kind: "bogus" })).status).toBe(400);
  expect((await post({ ...ok, name: " " })).status).toBe(400);
  expect((await post({ ...ok, secret: "" })).status).toBe(400);
  expect((await post({ ...ok, secret: undefined })).status).toBe(400);
  expect((await post({ ...ok, secret: { apiKey: "k" } })).status).toBe(201);
  expect((await post({ ...ok, kind: "custom-openai" })).status).toBe(400); // no baseUrl
  expect((await post({ ...ok, kind: "custom-openai", baseUrl: "http://evil.com" })).status).toBe(400);
  expect((await post({ ...ok, kind: "custom-openai", baseUrl: "https://x.com/v1", secret: "" })).status).toBe(201);
  expect((await post({ ...ok, kind: "custom-anthropic", baseUrl: "http://localhost:8080" })).status).toBe(201);
  expect((await post({ ...ok, baseUrl: "ftp://x" })).status).toBe(400);
});

it("malformed JSON on admin POST/PUT returns 400", async () => {
  for (const [p, m] of [["/admin/keys", "POST"], ["/admin/accounts", "POST"], ["/admin/combos", "PUT"], ["/admin/prices", "PUT"]])
    expect((await call(p, m, "{nope")).status).toBe(400);
});

// ---- fix round 1 ----
const oauthSecret = { accessToken: "at-1", refreshToken: "rt-1", expiresAt: 4102444800000 };
const seedOauth = () => hub(env).upsertAccount({ kind: "copilot-oauth", name: "cp", authType: "oauth", secret: oauthSecret });

it("PATCH preserves an OAuth secret byte-for-byte and survives a token rotation just before it", async () => {
  const a = await seedOauth();
  // rotate exactly as getFreshToken does: write new tokens directly into the stored record
  const rotated = { accessToken: "at-2", refreshToken: "rt-2", expiresAt: 4102444900000 };
  await runInDurableObject(env.HUB.get(env.HUB.idFromName("main")), async (_i, state) => {
    const cur = JSON.parse(state.storage.sql.exec("SELECT data FROM accounts WHERE id = ?", a.id).one().data as string);
    state.storage.sql.exec("UPDATE accounts SET data = ? WHERE id = ?", JSON.stringify({ ...cur, secret: rotated }), a.id);
  });
  const r = await call(`/admin/accounts/${a.id}`, "PATCH", { rpm: 7, secret: "evil", id: "other", kind: "openrouter", authType: "apikey" });
  expect(r.status).toBe(200);
  const b = (await r.json()) as any;
  expect(b).toMatchObject({ id: a.id, kind: "copilot-oauth", authType: "oauth", rpm: 7, secret: "***" });
  expect((await hub(env).getAccount(a.id))?.secret).toEqual(rotated);
  expect(await hub(env).getAccount("other")).toBeNull();
});

it("PATCH enforces name and custom baseUrl rules", async () => {
  const c1 = (await (await call("/admin/accounts", "POST", { kind: "custom-openai", name: "cu", baseUrl: "https://x.com/v1" })).json()) as any;
  expect((await call(`/admin/accounts/${c1.id}`, "PATCH", { baseUrl: null })).status).toBe(400);
  expect((await call(`/admin/accounts/${c1.id}`, "PATCH", { baseUrl: "" })).status).toBe(400);
  expect((await call(`/admin/accounts/${c1.id}`, "PATCH", { name: "  " })).status).toBe(400);
  expect((await call(`/admin/accounts/${c1.id}`, "PATCH", { baseUrl: "http://localhost:80@evil.com" })).status).toBe(400);
  expect((await call(`/admin/accounts/${c1.id}`, "PATCH", { baseUrl: "https://y.com" })).status).toBe(200);
  const o = await mkAcc({ baseUrl: "https://z.com" });
  const r = (await (await call(`/admin/accounts/${o.id}`, "PATCH", { baseUrl: null })).json()) as any;
  expect(r.baseUrl).toBeUndefined();
});

it("baseUrl parsing rejects bypasses and accepts good URLs", async () => {
  const post = (baseUrl: string) => call("/admin/accounts", "POST", { kind: "custom-openai", name: "u", baseUrl });
  for (const u of ["http://localhost:80@evil.com", "http://127.0.0.1.evil.com", "https://", "javascript:alert(1)", "//host", "https://u:p@x.com", "http://localhost.evil.com"])
    expect((await post(u)).status).toBe(400);
  for (const u of ["https://api.example.com/v1", "http://localhost:8787/v1", "http://127.0.0.1:9000"])
    expect((await post(u)).status).toBe(201);
});

it("POST accounts whitelists fields and validates numbers", async () => {
  const a = await mkAcc({ name: "orig" });
  const r = await call("/admin/accounts", "POST", { kind: "openrouter", name: "dup", secret: "k2", id: a.id, authType: "oauth" });
  expect(r.status).toBe(201);
  const b = (await r.json()) as any;
  expect(b.id).not.toBe(a.id);
  expect(b.authType).toBe("apikey");
  expect((await hub(env).getAccount(a.id))?.secret).toBe("sk-keep");
  const ok = { kind: "openrouter", name: "n", secret: "k" };
  expect((await call("/admin/accounts", "POST", { ...ok, kind: "copilot-oauth" })).status).toBe(400);
  for (const x of [{ rpm: 1.5 }, { rpm: -1 }, { tpm: "5" }, { monthlyUsd: -1 }, { monthlyUsd: "x" }, { enabled: "yes" }])
    expect((await call("/admin/accounts", "POST", { ...ok, ...x })).status).toBe(400);
  const g = (await (await call("/admin/accounts", "POST", { ...ok, rpm: 3, tpm: 0, monthlyUsd: 12.5, enabled: false })).json()) as any;
  expect(g).toMatchObject({ rpm: 3, tpm: 0, monthlyUsd: 12.5, enabled: false });
});

it("POST /admin/keys validates caps and allow-list", async () => {
  const post = (b: object) => call("/admin/keys", "POST", b);
  for (const x of [{ dailyUsd: "abc" }, { dailyUsd: -5 }, { monthlyUsd: "NaN" }, { allowedAccountIds: "x" }, { allowedAccountIds: [1] }, { allowedAccountIds: Array(201).fill("a") }, { name: " " }])
    expect((await post({ name: "k", ...x })).status).toBe(400);
  expect((await post({ name: "k", dailyUsd: null, monthlyUsd: 0 })).status).toBe(201);
  const r = (await (await post({ name: " k2 ", dailyUsd: 12.5, allowedAccountIds: ["a"] })).json()) as any;
  expect(r.key).toMatchObject({ name: "k2", dailyUsd: 12.5, allowedAccountIds: ["a"] });
});

it("PUT /admin/combos validates shape", async () => {
  const put = (b: object) => call("/admin/combos", "PUT", b);
  const t = { accountId: "a", model: "m" };
  for (const x of [{ targets: "x" }, { targets: [] }, { targets: [{ accountId: "a" }] }, { targets: [{ accountId: "", model: "m" }] }, { targets: Array(51).fill(t) }, { name: "", targets: [t] }])
    expect((await put({ name: "cc", ...x })).status).toBe(400);
  expect((await put({ name: "cc", targets: [{ ...t, extra: 1 }] })).status).toBe(200);
  expect(((await (await call("/admin/combos", "GET")).json()) as any[]).find((c) => c.name === "cc").targets).toEqual([t]);
});
