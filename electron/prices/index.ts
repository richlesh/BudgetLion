// Phase 2: automated price fetching for security assets. Main-process only.
//
// Opt-in and best-effort: only runs when settings.priceFetchEnabled is true. The
// source is Yahoo Finance's public chart endpoint (query1.finance.yahoo.com),
// which returns JSON quotes without an API key and covers stocks, ETFs, and many
// mutual funds. Unresolved symbols fall back to manual entry — the caller gets a
// `resolved: false` result and the UI keeps the last known / manual valuation.
// Symbols are only sent to the provider when the user has enabled fetching, since
// that transmits holdings to a third party.

import { recordValuation } from "../db/repository.js";
import { loadSettings } from "../settings.js";
import { MICRO } from "../../src/shared/types.js";

/** Result of attempting to price one asset's symbol. */
export interface PriceFetchResult {
  assetId: string;
  symbol: string;
  resolved: boolean;
  /** Per-share price in cents when resolved. */
  priceCents?: number;
  asOfDate?: string; // ISO date
  error?: string;
}

/** Today's date as ISO (YYYY-MM-DD), local time. */
function today(): string {
  return new Date().toISOString().slice(0, 10);
}

interface YahooChartMeta {
  symbol?: string;
  regularMarketPrice?: number;
  previousClose?: number;
  chartPreviousClose?: number;
  currency?: string;
}

/**
 * Fetch the latest price (in cents) for a symbol from Yahoo Finance's chart
 * endpoint. Returns null when the symbol can't be resolved (Yahoo returns a
 * chart.error, e.g. "Not Found"). Throws on transport/HTTP errors so the caller
 * records a per-symbol failure.
 */
async function fetchYahooCents(symbol: string): Promise<number | null> {
  const sym = symbol.trim().toUpperCase();
  const url =
    `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}` +
    `?interval=1d&range=1d`;
  // A browser-like UA avoids occasional bot rejections.
  const res = await fetch(url, {
    redirect: "follow",
    headers: { "User-Agent": "Mozilla/5.0", Accept: "application/json" },
  });
  // Yahoo returns 404 for unknown symbols — treat that as "unresolved" (manual
  // fallback), not a transport error, so the user sees a helpful message.
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = (await res.json()) as {
    chart?: { result?: Array<{ meta?: YahooChartMeta }> | null; error?: unknown };
  };
  if (data.chart?.error) return null; // unresolved symbol
  const meta = data.chart?.result?.[0]?.meta;
  const price =
    meta?.regularMarketPrice ?? meta?.previousClose ?? meta?.chartPreviousClose;
  if (price == null || !Number.isFinite(price)) return null;
  return Math.round(price * 100); // cents
}

/**
 * Refresh prices for the given security symbols. Gated on settings; when disabled
 * every asset comes back `resolved: false` with an explanatory error and no
 * network call is made. On success, upserts a valuation (source 'yahoo') for today.
 */
export async function refreshPrices(
  assets: Array<{ assetId: string; symbol: string }>
): Promise<PriceFetchResult[]> {
  const settings = loadSettings();
  if (!settings.priceFetchEnabled) {
    return assets.map((a) => ({
      assetId: a.assetId,
      symbol: a.symbol,
      resolved: false,
      error: "Price fetching is disabled in Settings.",
    }));
  }

  const asOfDate = today();
  const results: PriceFetchResult[] = [];

  for (const a of assets) {
    try {
      const priceCents = await fetchYahooCents(a.symbol);
      if (priceCents == null) {
        results.push({
          assetId: a.assetId,
          symbol: a.symbol,
          resolved: false,
          error: "No quote available (enter a price manually).",
        });
        continue;
      }
      // Store as per-unit micro-cents (cents * 1e6), matching asset_valuations.
      recordValuation({
        assetId: a.assetId,
        asOfDate,
        valueMicros: priceCents * MICRO,
        source: "yahoo",
      });
      results.push({
        assetId: a.assetId,
        symbol: a.symbol,
        resolved: true,
        priceCents,
        asOfDate,
      });
    } catch (err) {
      results.push({
        assetId: a.assetId,
        symbol: a.symbol,
        resolved: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return results;
}
