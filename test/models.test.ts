import { SELF } from "cloudflare:test";
import { afterEach, expect, it, vi } from "vitest";
import { hub } from "../src/hub-client";

afterEach(() => vi.restoreAllMocks());

it("refreshModels stores the upstream list and /v1/models exposes <account>/<model> next to combos", async () => {
  const h = hub(env_());
  const tag = crypto.randomUUID().slice(0, 8);
  const a = await h.upsertAccount({ kind: "custom-openai", name: `mm${tag}`, authType: "apikey", secret: "s", baseUrl: `https://mm${tag}.example/v1` });
  const b = await h.upsertAccount({ kind: "custom-openai", name: `other${tag}`, authType: "apikey", secret: "s", baseUrl: `https://other${tag}.example/v1` });
  vi.spyOn(globalThis, "fetch").mockImplementation(async (u, init) => {
    expect(new Headers((init as RequestInit).headers).get("authorization")).toBe("Bearer s");
    return String(u).startsWith(`https://mm${tag}`) ? Response.json({ data: [{ id: "m1" }, { id: "m2" }, { id: "m1" }] }) : new Response("no", { status: 500 });
  });
  expect(await h.refreshModels(a.id)).toEqual({ count: 2 });
  expect(await h.refreshModels(b.id)).toMatchObject({ error: expect.stringContaining("500") });
  const { secret } = await h.createKey({ name: "mm", allowedAccountIds: [a.id] });
  const ids = ((await (await SELF.fetch("http://x/v1/models", { headers: { authorization: `Bearer ${secret}` } })).json()) as any).data.map((d: any) => d.id);
  expect(ids).toEqual([`mm${tag}/m1`, `mm${tag}/m2`]);
});

import { env } from "cloudflare:test";
function env_() { return env; }
