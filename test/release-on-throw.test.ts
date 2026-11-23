import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import app from "../src/index";
import { hub } from "../src/hub-client";

// The router reserves through the gate and then throws.
vi.mock("../src/router", async (orig) => {
  const m = await orig<typeof import("../src/router")>();
  return {
    ...m,
    routeWithFallback: async (targets: any[], _f: unknown, _b: unknown, _fetch: unknown, _on: unknown, gate: (t: unknown) => Promise<unknown>) => {
      await gate(targets[0]);
      throw new Error("router bug");
    },
  };
});

describe("I8: reservations are released when the router throws", () => {
  it("a throw after reserving releases the reservation", async () => {
    const h = hub(env);
    const a = await h.upsertAccount({ kind: "custom-openai", name: "i8acc", authType: "apikey", secret: "s", baseUrl: "https://i8.example/v1" });
    const { secret, key } = await h.createKey({ name: "i8", maxInFlight: 1 });
    const ctx = createExecutionContext();
    const res = await app.fetch(
      new Request("http://x/v1/chat/completions", {
        method: "POST",
        headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" },
        body: JSON.stringify({ model: "i8acc/m", messages: [] }),
      }),
      env,
      ctx,
    );
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(502);
    expect(await res.text()).not.toContain("router bug");
    // released (a zero ledger row), so the single in-flight slot is free again
    expect((await h.usageSummary(0)).byKey.find((r) => r.id === key.id)).toMatchObject({ requests: 1, costUsd: 0 });
    expect((await h.reserve({ keyId: key.id, accountId: a.id, model: "m", estTokens: 1 })).ok).toBe(true);
  });
});
