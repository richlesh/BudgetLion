// Investment-history CSV parser (e.g. 401k transaction downloads). Pure /
// framework-agnostic. Maps rows like:
//
//   Date,Investment,Transaction Type,Amount,Shares/Unit
//   08/27/2026,S&amp;P 500 INDEX FUND,Contributions,"1,345.80","3.258"
//
// into normalized trade rows for recordTrade. Preamble lines before the header
// (plan name, date range, blanks) are skipped; HTML-escaped names are decoded;
// "Change in Market Value" rows are dropped (they are valuation noise, not trades).

import Papa from "papaparse";
import type { InvestmentAction, InvestmentImportRow } from "../../shared/types";
import { normalizeDate } from "./dates";

export type { InvestmentImportRow };

export interface InvestmentImportParse {
  rows: InvestmentImportRow[];
  /** Count of "Change in Market Value" rows skipped. */
  skippedMarketValue: number;
  /** Rows skipped because their type didn't map to buy/sell (with the raw type). */
  skippedUnknown: Array<{ date: string; type: string }>;
  /** True if a recognizable header row was found. */
  headerFound: boolean;
}

/** Decode common HTML entities found in exported names (e.g. S&amp;P -> S&P). */
export function decodeHtmlEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .trim();
}

/** Map a 401k transaction-type string to a trade action, or null if not a trade. */
export function mapActionType(type: string): InvestmentAction | null {
  const t = type.toLowerCase().trim();
  if (t === "change in market value") return null; // valuation noise, not a trade
  // Money going IN and buying shares.
  if (/contribution|loan repayment|purchase|buy|dividend reinvest|reinvest/.test(t)) return "buy";
  // Money coming OUT / shares sold.
  if (/withdrawal|redemption|sell|distribution/.test(t)) return "sell";
  return null;
}

/** Header column keys we look for (normalized lowercase). */
interface HeaderIndex {
  date: number;
  investment: number;
  type: number;
  amount: number;
  shares: number;
}

/** Locate the header row and its column indices; null if not found. */
function findHeader(grid: string[][]): { index: number; cols: HeaderIndex } | null {
  for (let i = 0; i < grid.length; i++) {
    const cells = grid[i].map((c) => c.toLowerCase().trim());
    const date = cells.findIndex((c) => c === "date");
    const investment = cells.findIndex((c) => /investment|fund|security/.test(c));
    const type = cells.findIndex((c) => /transaction type|type|activity/.test(c));
    const amount = cells.findIndex((c) => /amount/.test(c));
    const shares = cells.findIndex((c) => /shares?\/?unit|shares|units/.test(c));
    if (date >= 0 && investment >= 0 && type >= 0 && amount >= 0 && shares >= 0) {
      return { index: i, cols: { date, investment, type, amount, shares } };
    }
  }
  return null;
}

/** Parse a possibly-quoted, comma-grouped number (e.g. "1,345.80" or "-1,021.732"). */
function parseNumber(s: string): number | null {
  const cleaned = s.replace(/[",\s]/g, "");
  if (cleaned === "" || cleaned === "-") return null;
  const v = Number(cleaned);
  return Number.isFinite(v) ? v : null;
}

/**
 * Parse investment-history CSV text into normalized trade rows. `dateFormat`
 * matches the file (401k exports use US MM/DD/YYYY).
 */
export function parseInvestmentCsv(
  text: string,
  dateFormat: "us" | "eu" | "iso" = "us"
): InvestmentImportParse {
  const grid = (Papa.parse<string[]>(text.trim(), { skipEmptyLines: true }).data as string[][]) ?? [];
  const header = findHeader(grid);
  if (!header) {
    return { rows: [], skippedMarketValue: 0, skippedUnknown: [], headerFound: false };
  }

  const { cols } = header;
  const rows: InvestmentImportRow[] = [];
  const skippedUnknown: Array<{ date: string; type: string }> = [];
  let skippedMarketValue = 0;

  const cell = (row: string[], idx: number) => (idx < row.length ? (row[idx] ?? "").trim() : "");

  for (let i = header.index + 1; i < grid.length; i++) {
    const row = grid[i];
    const rawType = cell(row, cols.type);
    if (!rawType) continue;

    const action = mapActionType(rawType);
    if (rawType.toLowerCase().trim() === "change in market value") {
      skippedMarketValue++;
      continue;
    }

    const date = normalizeDate(cell(row, cols.date), dateFormat);
    if (!date) continue;

    const amountNum = parseNumber(cell(row, cols.amount));
    const sharesNum = parseNumber(cell(row, cols.shares));
    if (amountNum == null || sharesNum == null) continue;

    // A trade needs shares; zero-share rows (other valuation adjustments) are noise.
    if (sharesNum === 0) {
      skippedMarketValue++;
      continue;
    }
    if (action == null) {
      skippedUnknown.push({ date, type: rawType });
      continue;
    }

    const amountCents = Math.abs(Math.round(amountNum * 100));
    const units = Math.abs(sharesNum);
    // Per-share price in cents (fractional): |amount| / |shares|, in cents.
    const pricePerUnitCents = units > 0 ? amountCents / units : 0;

    rows.push({
      date,
      securityName: decodeHtmlEntities(cell(row, cols.investment)),
      action,
      units,
      pricePerUnitCents,
      amountCents,
      rawType,
    });
  }

  return { rows, skippedMarketValue, skippedUnknown, headerFound: true };
}
