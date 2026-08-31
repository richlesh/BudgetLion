// Pure money helpers. All amounts are integer cents.

import type { AccountType } from "../shared/types";

/**
 * Display-only sign multiplier for an account type.
 *
 * Liability accounts (credit cards, loans) are stored with the same convention
 * as asset accounts internally (inflow positive, outflow negative, a debt is a
 * negative balance). But on a statement a charge/debit shows as a positive and a
 * payment/credit as a negative, so for these account types we flip the sign when
 * displaying amounts and balances. This does NOT change stored data.
 */
export function displaySign(type: AccountType): 1 | -1 {
  return type === "credit_card" || type === "loan" ? -1 : 1;
}

/** True for liability account types (credit card / loan), which carry interest. */
export function isLiability(type: AccountType): boolean {
  return type === "credit_card" || type === "loan";
}

/** Parse a percent string (e.g. "4.25") to basis points (425). Null if blank/invalid. */
export function percentToBps(input: string): number | null {
  const s = input.trim().replace(/%/g, "");
  if (s === "") return null;
  const value = Number(s);
  if (!Number.isFinite(value)) return null;
  return Math.round(value * 100);
}

/** Format basis points (425) as a percent string ("4.25"). Empty string for null. */
export function bpsToPercent(bps: number | null | undefined): string {
  if (bps == null) return "";
  return String(bps / 100);
}

/** Format integer cents as a currency string, e.g. 123456 -> "$1,234.56". */
export function formatCents(cents: number, currency = "USD", locale = "en-US"): string {
  return new Intl.NumberFormat(locale, {
    style: "currency",
    currency,
  }).format(cents / 100);
}

/**
 * Parse a user-entered money string into integer cents.
 * Accepts things like "1,234.56", "$1234.5", "-42", "(42)" (parentheses = negative).
 * Returns null if it cannot be parsed.
 */
export function parseCents(input: string): number | null {
  if (input == null) return null;
  let s = String(input).trim();
  if (s === "") return null;

  let negative = false;
  // Accounting-style negatives: (1,234.56)
  if (/^\(.*\)$/.test(s)) {
    negative = true;
    s = s.slice(1, -1);
  }
  if (s.startsWith("-")) {
    negative = true;
    s = s.slice(1);
  }

  // Strip currency symbols, spaces, and thousands separators.
  s = s.replace(/[^0-9.]/g, "");
  if (s === "" || s === ".") return null;

  const value = Number(s);
  if (!Number.isFinite(value)) return null;

  // Round to nearest cent to avoid float artifacts.
  const cents = Math.round(value * 100);
  return negative ? -cents : cents;
}
