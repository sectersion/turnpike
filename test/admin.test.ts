import { SELF, env } from "cloudflare:test";
import { it, expect } from "vitest";
import app from "../src/index";

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
  await SELF.fetch("http://x/admin/combos", { method: "PUT", headers: A, body: JSON.stringify({ name: "c", targets: [] }) });
  const combos = (await (await SELF.fetch("http://x/admin/combos", { headers: A })).json()) as any[];
  expect(combos.some((c) => c.name === "c")).toBe(true);
  expect((await SELF.fetch(`http://x/admin/accounts/${acc.id}`, { method: "DELETE", headers: A })).status).toBe(200);
});
