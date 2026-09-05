// Heuristic bank/credit-card statement parser. Pure and framework-agnostic:
// it takes the already-extracted text layer of a PDF (one transaction row per
// line, produced by the main-process pdfjs extractor) and finds transaction
// rows using deterministic date/amount pattern matching. No AI, no network.
//
// It is deliberately conservative: a line must begin with a date and contain a
// money amount to be treated as a transaction. Section headers ("Payments and
// Other Credits", "Purchases and Adjustments", "Interest Charged", …) set the
// sign, and "TOTAL … FOR THIS PERIOD" / header lines are excluded. Amounts that
// wrapped onto the next line (common for negative credits) are stitched back.
//
// Amounts are returned in STATEMENT convention: a charge/purchase is POSITIVE
// and a payment/credit is NEGATIVE. The import UI's "loan / credit-card
// conventions" toggle (defaulted on for liability accounts) then flips them to
// the internal stored convention, exactly like the CSV path.

import type { ParsedRow } from "../../shared/types";
import { parseCents } from "../money";
import { cleanDescription } from "./normalize";

/** Metadata discovered while parsing (useful for the UI / diagnostics). */
export interface PdfParseResult {
  rows: ParsedRow[];
  /** Inferred statement closing year, if found (used for MM/DD -> full date). */
  closingYear: number | null;
  /** True when the text had no usable content (likely a scanned / image PDF). */
  empty: boolean;
}

// A leading "MM/DD" (transaction date), optionally followed by a second
// "MM/DD" posting date. Captures the first (transaction) date.
const LEADING_DATE = /^(\d{1,2})\/(\d{1,2})(?:\s+\d{1,2}\/\d{1,2})?\s+(.*)$/;

// A trailing signed money amount: optional leading "-" or "(", digits with
// commas, a decimal, and optional trailing "-"/"CR"/"DR". Captures the number.
const TRAILING_AMOUNT = /(-?\$?\s*\(?\s*[\d,]+\.\d{2}\s*\)?-?)\s*(CR|DR)?\.?$/i;

// A line that is *only* a money amount (a wrapped amount continuation line).
const LONE_AMOUNT = /^(-?\$?\s*\(?\s*[\d,]+\.\d{2}\s*\)?-?)\s*(CR|DR)?$/i;

// Full ISO date lines "YYYY-MM-DD DESC … AMOUNT" (some statements print these).
const LEADING_ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})\s+(.*)$/;

// A US full date "MM/DD/YYYY DESC … AMOUNT".
const LEADING_US_DATE = /^(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(.*)$/;

// Statement period like "December 16 - January 15, 2026" or "… , 2026".
const PERIOD_YEAR = /\b(\d{4})\b\s*$/;
const CLOSING_DATE = /closing date[^0-9]*(\d{1,2})\/(\d{1,2})\/(\d{4})/i;

/** Section kinds that flip the sign of following rows. */
type Section = "charge" | "credit" | "unknown";

/** Lines we never treat as transactions (totals, table headers, etc.). */
function isNoiseLine(line: string): boolean {
  const l = line.trim();
  if (l === "") return true;
  if (/^total\b/i.test(l)) return true; // "TOTAL PAYMENTS …", "TOTAL PURCHASES …"
  if (/for this period/i.test(l)) return true;
  if (/year-to-date|totals? year/i.test(l)) return true;
  if (/^transaction\b.*\bdate\b/i.test(l)) return true; // column header row
  if (/^date\b/i.test(l) && /description/i.test(l)) return true;
  if (/statement closing date/i.test(l)) return true;
  if (/payment due date/i.test(l)) return true;
  if (/new balance total/i.test(l)) return true;
  if (/minimum payment/i.test(l)) return true;
  if (/previous balance/i.test(l)) return true;
  return false;
}

/** Detect a section header line, returning the sign context it establishes. */
function sectionOf(line: string): Section | null {
  const l = line.toLowerCase();
  if (/payments?\s+and\s+other\s+credits/.test(l)) return "credit";
  if (/\bcredits?\b/.test(l) && !/\bpurchase/.test(l)) return "credit";
  if (/purchases?\s+and\s+adjustments/.test(l)) return "charge";
  if (/interest\s+charged/.test(l)) return "charge";
  if (/fees?\s+charged/.test(l)) return "charge";
  return null;
}

/** Parse a captured amount token into signed cents (magnitude only; sign added by caller). */
function amountToCents(token: string): number | null {
  let t = token.trim();
  let negative = false;
  // Parenthesized or trailing-minus => negative magnitude as printed.
  if (/^\(.*\)$/.test(t) || /\)$/.test(t)) negative = true;
  if (/-\s*$/.test(t) || /^-/.test(t)) negative = true;
  t = t.replace(/[()$\s-]/g, "");
  const cents = parseCents(t);
  if (cents == null) return null;
  return negative ? -Math.abs(cents) : Math.abs(cents);
}

/** Strip trailing reference/account-number tokens from a captured description. */
function stripTrailingRefs(desc: string): string {
  // Remove trailing runs of standalone 3-6 digit tokens (reference + acct last4),
  // e.g. "… OPENAI.COM CA 7689 9487" -> "… OPENAI.COM CA".
  return desc.replace(/(?:\s+\d{3,6})+\s*$/g, "").trim();
}

/**
 * Build an ISO date from a MM/DD pair using an inferred year. When a closing
 * year is known, months near/after the closing month keep the closing year and
 * earlier months (a statement that spans a year boundary) get the prior year.
 */
function isoFromMonthDay(
  month: number,
  day: number,
  closingYear: number | null,
  closingMonth: number | null
): string | null {
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  let year: number;
  if (closingYear == null) {
    year = new Date().getFullYear();
  } else if (closingMonth != null && month > closingMonth) {
    // A month later than the closing month must belong to the prior year
    // (e.g. closing 01/15/2026, a 12/16 row is Dec 2025).
    year = closingYear - 1;
  } else {
    year = closingYear;
  }
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/** Find the statement closing year/month from header text, if present. */
function findClosing(lines: string[]): { year: number | null; month: number | null } {
  for (const line of lines) {
    const m = CLOSING_DATE.exec(line);
    if (m) return { month: Number(m[1]), year: Number(m[3]) };
  }
  // Fall back to a trailing 4-digit year on a period line ("… , 2026").
  for (const line of lines) {
    const m = PERIOD_YEAR.exec(line.trim());
    if (m && /january|february|march|april|may|june|july|august|september|october|november|december|\d{1,2}\/\d{1,2}/i.test(line)) {
      return { year: Number(m[1]), month: null };
    }
  }
  return { year: null, month: null };
}

/**
 * Parse extracted statement text into signed ParsedRows (statement convention:
 * charges positive, credits negative). Heuristic and best-effort — always meant
 * to feed an editable preview, never a silent import.
 */
export function parseStatementText(text: string): PdfParseResult {
  const rawLines = text.split(/\r?\n/);
  const lines = rawLines.map((l) => l.replace(/\s+/g, " ").trim());
  if (lines.every((l) => l === "")) {
    return { rows: [], closingYear: null, empty: true };
  }

  const { year: closingYear, month: closingMonth } = findClosing(lines);
  const rows: ParsedRow[] = [];
  let section: Section = "unknown";

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // A transaction line always starts with a date. Only *non-date* lines can be
    // section headers — this prevents a description containing the word "credit"
    // (e.g. "API CREDIT …") from being mistaken for a "Payments and Other
    // Credits" section header and flipping the sign of the rows that follow.
    const startsWithDate =
      LEADING_ISO_DATE.test(line) || LEADING_US_DATE.test(line) || LEADING_DATE.test(line);

    if (!startsWithDate) {
      // Track section context (affects sign for MM/DD rows without a printed sign).
      // Ignore summary lines that carry their own trailing amount (those live in
      // the Account Summary block, not the transaction table).
      const sec = sectionOf(line);
      if (sec && !TRAILING_AMOUNT.test(line)) {
        section = sec;
        continue;
      }
      if (isNoiseLine(line)) continue;
    }

    // Try ISO date row first, then US full-date, then MM/DD (with inferred year).
    let date: string | null = null;
    let rest: string | null = null;

    const iso = LEADING_ISO_DATE.exec(line);
    const us = LEADING_US_DATE.exec(line);
    const md = LEADING_DATE.exec(line);
    if (iso) {
      date = `${iso[1]}-${iso[2]}-${iso[3]}`;
      rest = iso[4];
    } else if (us) {
      const mm = Number(us[1]);
      const dd = Number(us[2]);
      if (mm >= 1 && mm <= 12 && dd >= 1 && dd <= 31) {
        date = `${us[3]}-${String(mm).padStart(2, "0")}-${String(dd).padStart(2, "0")}`;
        rest = us[4];
      }
    } else if (md) {
      date = isoFromMonthDay(Number(md[1]), Number(md[2]), closingYear, closingMonth);
      rest = md[3];
    }
    if (!date || rest == null) continue;

    // Find the amount on this line, or on the next line if it wrapped.
    let amountToken: string | null = null;
    const am = TRAILING_AMOUNT.exec(rest);
    if (am) {
      amountToken = am[1] + (am[2] ?? "");
      rest = rest.slice(0, am.index).trim();
    } else {
      // Amount may have wrapped to the following (non-date) line.
      const next = lines[i + 1] ?? "";
      const lone = LONE_AMOUNT.exec(next);
      if (lone && !LEADING_DATE.test(next) && !sectionOf(next)) {
        amountToken = lone[1] + (lone[2] ?? "");
        i += 1; // consume the continuation line
      }
    }
    if (!amountToken) continue;

    const magnitude = amountToCents(amountToken);
    if (magnitude == null) continue;
    if (magnitude === 0) continue; // drop $0.00 rows (e.g. "INTEREST CHARGED … 0.00")

    // Sign: an explicitly-negative token wins; otherwise the section decides.
    // Statement convention -> charges positive, credits negative.
    let signed: number;
    if (magnitude < 0) {
      signed = magnitude; // printed as negative (a credit)
    } else if (section === "credit") {
      signed = -Math.abs(magnitude);
    } else {
      signed = Math.abs(magnitude); // charge / purchase / interest / fee
    }

    const desc = cleanDescription(stripTrailingRefs(rest) || null);
    rows.push({
      date,
      payee: desc,
      memo: null,
      amountCents: signed,
      importId: null,
    });
  }

  return { rows, closingYear, empty: rows.length === 0 };
}
