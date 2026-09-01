// Phase 2: automated price fetching for security assets. Main-process only.
//
// Opt-in and best-effort: only runs when settings.priceFetchEnabled is true. The
// default source is Stooq (https://stooq.com), which exposes a no-key CSV quote
// endpoint. Unresolved symbols (e.g. many mutual funds) fall back to manual entry
// — the caller simply gets a `resolved: false` result and the UI keeps the last
// known / manually entered valuation. Symbols are only sent to the provider when
// the user has enabled fetching, since that transmits holdings to a third party.

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

/**
 * Fetch a single quote from Stooq's CSV endpoint. Stooq wants lowercase symbols,
 * and US tickers are suffixed with ".us" (e.g. AAPL -> aapl.us). Returns the last
 * price in cents, or null when the symbol can't be resolved (Stooq returns "N/D").
 */
async function fetchStooqCents(symbol: string): Promise<number | null> {
  const s = symbol.trim().toLowerCase();
  // Add the .us suffix for bare tickers (no exchange suffix present).
  const stooqSym = s.includes(".") ? s : `${s}.us`;
  const url = `https://stooq.com/q/l/?s=${encodeURIComponent(stooqSym)}&f=sd2t2ohlcv&h&e=csv`;
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const text = await res.text();
  // CSV: header line then a data line. Close is column index 6 (0-based).
  const lines = text.trim().split(/\r?\n/);
  if (lines.length < 2) return null;
  const cols = lines[1].split(",");
  const close = cols[6];
  if (!close || close === "N/D") return null;
  const dollars = Number(close);
  if (!Number.isFinite(dollars)) return null;
  return Math.round(dollars * 100); // cents
}

/**
 * Refresh prices for the given security symbols. Gated on settings; when disabled
 * every asset comes back `resolved: false` with an explanatory error and no
 * network call is made. On success, upserts a valuation (source 'stooq') for today.
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

  const source = settings.priceSource ?? "stooq";
  const asOfDate = today();
  const results: PriceFetchResult[] = [];

  for (const a of assets) {
    try {
      let priceCents: number | null = null;
      if (source === "stooq") {
        priceCents = await fetchStooqCents(a.symbol);
      } else {
        throw new Error(`Unknown price source: ${source}`);
      }

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
        source: "stooq",
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
