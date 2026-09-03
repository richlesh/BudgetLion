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

/** Normalize an ISO date/timestamp to the first of its month (YYYY-MM-01). */
function toMonthStart(iso: string): string {
  return `${iso.slice(0, 7)}-01`;
}

/** One monthly historical price point. */
export interface MonthlyPrice {
  /** First of the month (YYYY-MM-01). */
  date: string;
  /** Per-share price in cents. */
  priceCents: number;
}

/**
 * Fetch monthly historical closing prices for a symbol from `startISO` to now,
 * one point per month, via Yahoo's chart endpoint (interval=1mo). Returns points
 * keyed to the FIRST of each month. Null when the symbol can't be resolved;
 * throws on transport/HTTP errors.
 */
async function fetchYahooMonthly(symbol: string, startISO: string): Promise<MonthlyPrice[] | null> {
  const sym = symbol.trim().toUpperCase();
  const period1 = Math.floor(new Date(`${startISO}T00:00:00Z`).getTime() / 1000);
  const period2 = Math.floor(Date.now() / 1000);
  const url =
    `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}` +
    `?interval=1mo&period1=${period1}&period2=${period2}`;
  const res = await fetch(url, {
    redirect: "follow",
    headers: { "User-Agent": "Mozilla/5.0", Accept: "application/json" },
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = (await res.json()) as {
    chart?: {
      result?: Array<{
        timestamp?: number[];
        indicators?: { quote?: Array<{ close?: Array<number | null> }>; adjclose?: Array<{ adjclose?: Array<number | null> }> };
      }> | null;
      error?: unknown;
    };
  };
  if (data.chart?.error) return null;
  const r = data.chart?.result?.[0];
  const ts = r?.timestamp;
  const closes = r?.indicators?.adjclose?.[0]?.adjclose ?? r?.indicators?.quote?.[0]?.close;
  if (!ts || !closes) return [];
  const out: MonthlyPrice[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < ts.length; i++) {
    const price = closes[i];
    if (price == null || !Number.isFinite(price)) continue;
    const isoTs = new Date(ts[i] * 1000).toISOString().slice(0, 10);
    const monthStart = toMonthStart(isoTs);
    if (seen.has(monthStart)) continue; // one point per month
    seen.add(monthStart);
    out.push({ date: monthStart, priceCents: Math.round(price * 100) });
  }
  return out;
}

/** Result of a monthly-history backfill for one asset. */
export interface BackfillResult {
  resolved: boolean;
  /** Number of month rows added (existing dates are left untouched). */
  added: number;
  error?: string;
}

/**
 * Backfill monthly historical valuations (source 'yahoo') for a tickered asset,
 * one per month from `startDate` to now, WITHOUT overwriting dates that already
 * have a valuation (so manual entries and prior fills are preserved). Gated on
 * the opt-in price-fetch setting.
 */
export async function backfillMonthlyHistory(input: {
  assetId: string;
  symbol: string;
  startDate: string;
  existingDates: string[];
}): Promise<BackfillResult> {
  const settings = loadSettings();
  if (!settings.priceFetchEnabled) {
    return { resolved: false, added: 0, error: "Price fetching is disabled in Settings." };
  }
  if (!input.symbol.trim()) {
    return { resolved: false, added: 0, error: "This holding has no ticker symbol." };
  }
  let monthly: MonthlyPrice[] | null;
  try {
    monthly = await fetchYahooMonthly(input.symbol, toMonthStart(input.startDate));
  } catch (err) {
    return { resolved: false, added: 0, error: err instanceof Error ? err.message : String(err) };
  }
  if (monthly == null) {
    return { resolved: false, added: 0, error: "No historical data available for this symbol." };
  }
  const have = new Set(input.existingDates);
  let added = 0;
  for (const p of monthly) {
    if (have.has(p.date)) continue; // don't overwrite manual/existing months
    recordValuation({
      assetId: input.assetId,
      asOfDate: p.date,
      valueMicros: p.priceCents * MICRO,
      source: "yahoo",
    });
    added++;
  }
  return { resolved: true, added };
}

/** One symbol-search match (name -> ticker). */
export interface SymbolMatch {
  symbol: string;
  name: string;
  exchange: string;
  /** Yahoo quoteType, e.g. EQUITY, ETF, MUTUALFUND, INDEX. */
  type: string;
}

/** Result of a name→symbol lookup. */
export interface SymbolLookupResult {
  resolved: boolean;
  results: SymbolMatch[];
  error?: string;
}

/**
 * Look up ticker symbols by security/fund NAME via Yahoo's search endpoint. Used
 * to help the user find the symbol for a holding (stocks, ETFs, mutual funds).
 * Gated on the opt-in price-fetch setting, since it sends the query to Yahoo.
 */
export async function lookupSymbols(query: string): Promise<SymbolLookupResult> {
  const settings = loadSettings();
  if (!settings.priceFetchEnabled) {
    return { resolved: false, results: [], error: "Price fetching is disabled in Settings." };
  }
  const q = query.trim();
  if (!q) return { resolved: false, results: [], error: "Enter a name to search." };
  const url =
    `https://query1.finance.yahoo.com/v1/finance/search` +
    `?q=${encodeURIComponent(q)}&quotesCount=10&newsCount=0`;
  try {
    const res = await fetch(url, {
      redirect: "follow",
      headers: { "User-Agent": "Mozilla/5.0", Accept: "application/json" },
    });
    if (!res.ok) return { resolved: false, results: [], error: `HTTP ${res.status}` };
    const data = (await res.json()) as {
      quotes?: Array<{
        symbol?: string;
        shortname?: string;
        longname?: string;
        exchange?: string;
        quoteType?: string;
      }>;
    };
    const results: SymbolMatch[] = (data.quotes ?? [])
      .filter((qt) => !!qt.symbol)
      .map((qt) => ({
        symbol: qt.symbol as string,
        name: qt.shortname ?? qt.longname ?? "",
        exchange: qt.exchange ?? "",
        type: qt.quoteType ?? "",
      }));
    return { resolved: true, results };
  } catch (err) {
    return { resolved: false, results: [], error: err instanceof Error ? err.message : String(err) };
  }
}
