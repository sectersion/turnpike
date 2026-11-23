export type Price = { inPerM: number; outPerM: number };

export function priceFor(model: string, overrides: Record<string, Price>, orTable: Record<string, Price>): Price | null {
  if (overrides[model]) return overrides[model];
  if (orTable[model]) return orTable[model];
  const k = Object.keys(orTable).find((id) => id.endsWith("/" + model));
  return k ? orTable[k] : null;
}

// Anthropic prompt caching: writes cost 1.25x the input price, reads 0.1x.
export const costUsd = (p: Price, inTokens: number, outTokens: number, cacheWrite = 0, cacheRead = 0) =>
  ((inTokens + 1.25 * cacheWrite + 0.1 * cacheRead) / 1e6) * p.inPerM + (outTokens / 1e6) * p.outPerM;

// Never throws: any failure yields {} so the caller keeps its cached table.
export async function refreshOpenRouterPrices(fetchFn: typeof fetch = fetch): Promise<Record<string, Price>> {
  const out: Record<string, Price> = {};
  try {
    const res = await fetchFn("https://openrouter.ai/api/v1/models");
    if (!res.ok) return {};
    const j: any = await res.json();
    for (const d of j.data) {
      const i = parseFloat(d?.pricing?.prompt);
      const o = parseFloat(d?.pricing?.completion);
      if (typeof d.id !== "string" || !(i >= 0) || !(o >= 0)) continue;
      out[d.id] = { inPerM: i * 1e6, outPerM: o * 1e6 };
    }
  } catch {
    return {};
  }
  return out;
}
