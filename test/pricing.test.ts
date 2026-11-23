import { describe, expect, it } from "vitest";
import { priceFor, refreshOpenRouterPrices } from "../src/pricing";

const p = (n: number) => ({ inPerM: n, outPerM: n });

describe("priceFor", () => {
  const table = { "openai/gpt-x": p(2), "gpt-x": p(3), "anthropic/claude-y": p(4) };
  it("precedence: override > exact > suffix > null", () => {
    expect(priceFor("gpt-x", { "gpt-x": p(1) }, table)).toEqual(p(1));
    expect(priceFor("gpt-x", {}, table)).toEqual(p(3));
    expect(priceFor("claude-y", {}, table)).toEqual(p(4));
    expect(priceFor("nope", {}, table)).toBeNull();
  });
});

describe("refreshOpenRouterPrices", () => {
  const fake = (r: Response | Error) => (async () => {
    if (r instanceof Error) throw r;
    return r;
  }) as unknown as typeof fetch;

  it("parses per-token strings into per-million, skipping bad entries", async () => {
    const t = await refreshOpenRouterPrices(
      fake(
        Response.json({
          data: [
            { id: "a/ok", pricing: { prompt: "0.000003", completion: "0.000015" } },
            { id: "a/neg", pricing: { prompt: "-1", completion: "-1" } },
            { id: "a/junk", pricing: { prompt: "abc", completion: "1" } },
            { id: "a/none" },
          ],
        }),
      ),
    );
    expect(Object.keys(t)).toEqual(["a/ok"]);
    expect(t["a/ok"].inPerM).toBeCloseTo(3);
    expect(t["a/ok"].outPerM).toBeCloseTo(15);
  });

  it("returns {} on fetch failure, non-2xx or bad json", async () => {
    expect(await refreshOpenRouterPrices(fake(new Error("down")))).toEqual({});
    expect(await refreshOpenRouterPrices(fake(new Response("x", { status: 500 })))).toEqual({});
    expect(await refreshOpenRouterPrices(fake(new Response("{nope")))).toEqual({});
    expect(await refreshOpenRouterPrices(fake(Response.json({ data: "x" })))).toEqual({});
  });
});
