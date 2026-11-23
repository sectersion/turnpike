import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { Account } from "../src/types";

const hub = () => env.HUB.get(env.HUB.idFromName("test-" + crypto.randomUUID()));

const acct = (name: string) => ({
  kind: "openrouter" as const,
  name,
  authType: "apikey" as const,
  secret: { apiKey: "sk-real" },
});

describe("hub keys", () => {
  it("createKey returns a secret that resolveKey accepts", async () => {
    const h = hub();
    const { key, secret } = await h.createKey({ name: "k" });
    expect(secret).toMatch(/^tpk_/);
    expect(await h.resolveKey(secret)).toEqual(key);
  });

  it("resolveKey returns null after revokeKey", async () => {
    const h = hub();
    const { key, secret } = await h.createKey({ name: "k" });
    await h.revokeKey(key.id);
    expect(await h.resolveKey(secret)).toBeNull();
  });

  it("listKeys never exposes the secret or its hash", async () => {
    const h = hub();
    const { secret } = await h.createKey({ name: "k" });
    const json = JSON.stringify(await h.listKeys());
    expect(json).not.toContain(secret);
    expect(json.toLowerCase()).not.toContain("hash");
    expect(json).not.toMatch(/[0-9a-f]{64}/);
  });

  it('listAccounts(true) redacts secret to "***"', async () => {
    const h = hub();
    // RPC typing maps `secret: unknown` to never, so cast the results
    const a = (await h.upsertAccount(acct("a"))) as unknown as Account;
    expect(a.enabled).toBe(true);
    expect(((await h.listAccounts(true)) as unknown as Account[])[0].secret).toBe("***");
    expect(((await h.listAccounts(false)) as unknown as Account[])[0].secret).toEqual({ apiKey: "sk-real" });
    expect(((await h.getAccount(a.id)) as unknown as Account | null)?.name).toBe("a");
    await h.deleteAccount(a.id);
    expect(await h.getAccount(a.id)).toBeNull();
  });

  it("allowedAccountIds null means all", async () => {
    const h = hub();
    const { key } = await h.createKey({ name: "k" });
    expect(key.allowedAccountIds).toBeNull();
    const r = await h.createKey({ name: "r", allowedAccountIds: ["x"] });
    expect(r.key.allowedAccountIds).toEqual(["x"]);
  });

  it("combos round trip", async () => {
    const h = hub();
    await h.upsertCombo({ name: "c", targets: [{ accountId: "a", model: "m" }] });
    await h.upsertCombo({ name: "c", targets: [] });
    expect(await h.listCombos()).toEqual([{ name: "c", targets: [] }]);
  });
});
