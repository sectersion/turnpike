import { SELF } from "cloudflare:test";
import { it, expect } from "vitest";

it("GET /health", async () => {
  const res = await SELF.fetch("http://x/health");
  expect(res.status).toBe(200);
  expect(await res.text()).toBe('{"ok":true}');
});
