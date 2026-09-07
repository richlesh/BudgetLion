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
// The leading minus may be separated from the "$" by spaces (e.g. "- $92.64",
// as printed by some Capital One statements), so that sign isn't lost.
const TRAILING_AMOUNT = /(-?\s*\$?\s*\(?\s*[\d,]+\.\d{2}\s*\)?-?)\s*(CR|DR)?\.?$/i;

// A line that is *only* a money amount (a wrapped amount continuation line).
const LONE_AMOUNT = /^(-?\s*\$?\s*\(?\s*[\d,]+\.\d{2}\s*\)?-?)\s*(CR|DR)?$/i;

// Full ISO date lines "YYYY-MM-DD DESC … AMOUNT" (some statements print these).
const LEADING_ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})\s+(.*)$/;

// A US full date "MM/DD/YYYY DESC … AMOUNT" or "MM/DD/YY …", optionally followed
// by a second (posting) date in the same format. Captures the FIRST date's
// month/day/year and the rest; the optional second date is consumed but ignored.
const LEADING_US_DATE =
  /^(\d{1,2})\/(\d{1,2})\/(\d{2,4})(?:\s+\d{1,2}\/\d{1,2}\/\d{2,4})?\s+(.*)$/;

// A month-name date "Mon D [Mon D] DESC … AMOUNT" (e.g. Capital One / Kohl's:
// "Jul 30 Jul 30 ELECTRONIC PAYMENT - $92.64"). The optional second date is the
// posting date; we capture the first (transaction) month/day and the rest.
const LEADING_MONTHNAME_DATE =
  /^([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:\s+[A-Za-z]{3,9}\.?\s+\d{1,2})?\s+(.*)$/;

// Month name/abbreviation -> 1-based month number.
const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12,
};

/** Parse a (possibly full) month name to its 1-based number, or null. */
function monthNumber(name: string): number | null {
  return MONTHS[name.slice(0, 3).toLowerCase()] ?? null;
}

// A closing / period date printed with a month name and year, e.g.
// "Aug 11, 2026" or "Jul 12, 2026 - Aug 11, 2026 | 31 days in Billing Cycle".
// Captures the LAST such date on the line (the period END = closing date).
const CLOSING_DATE_NAME = /([A-Za-z]{3,9})\.?\s+(\d{1,2}),\s*(\d{4})/g;

// Statement period like "December 16 - January 15, 2026" or "… , 2026".
const PERIOD_YEAR = /\b(\d{4})\b\s*$/;
const CLOSING_DATE = /closing date[^0-9]*(\d{1,2})\/(\d{1,2})\/(\d{2,4})/i;

// Citi-style "Billing Period: 07/24/26-08/25/26" (2-digit year). Captures the
// period END (the second date) = the statement closing date.
const BILLING_PERIOD_MDY =
  /billing period[^0-9]*\d{1,2}\/\d{1,2}\/\d{2,4}\s*[-–]\s*(\d{1,2})\/(\d{1,2})\/(\d{2,4})/i;

// "New balance as of MM/DD/YYYY" — the statement closing date (some cards, e.g.
// PayPal Cashback Mastercard). Captured month/day/year.
const BALANCE_AS_OF_MDY =
  /new balance as of\s+(\d{1,2})\/(\d{1,2})\/(\d{2,4})/i;

// "… billing cycle from MM/DD/YYYY to MM/DD/YYYY" — take the END (closing) date.
const BILLING_CYCLE_TO_MDY =
  /billing cycle[^0-9]*\d{1,2}\/\d{1,2}\/\d{2,4}\s*(?:to|-|–)\s*(\d{1,2})\/(\d{1,2})\/(\d{2,4})/i;

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

/** Detect a section header line, returning the sign context it establishes.
 *
 * A section header is a SHORT, standalone line whose text is essentially just
 * the header phrase (e.g. "Standard Purchases", "Payments, Credits and
 * Adjustments"). Prose that merely mentions "credit", "purchases", or
 * "interest" (statement legalese is full of it) must NOT be treated as a
 * header — otherwise it would silently flip the sign of every following row.
 * Statements without section headers rely on per-amount signs (a trailing "-"
 * marks a credit) and default unsigned amounts to charges. */
function sectionOf(line: string): Section | null {
  const trimmed = line.trim();
  // Some issuers prefix a per-cardholder header with a name, e.g.
  // "SANDRA J LESH #4447: Payments, Credits and Adjustments". Test the text
  // AFTER the last colon as the candidate header in that case.
  const afterColon = trimmed.includes(":") ? trimmed.slice(trimmed.lastIndexOf(":") + 1).trim() : "";
  // The header candidate is the post-colon suffix (if any) or the whole line.
  const candidate = afterColon || trimmed;
  // Real section headers are short. Anything long is prose, not a header. (The
  // candidate excludes any name prefix, so per-cardholder headers still pass.)
  if (candidate.length > 40) return null;
  const l = candidate.toLowerCase();
  const nospace = l.replace(/\s+/g, "");
  // Strip trailing punctuation/colon so "Transactions:" and "Purchases" compare cleanly.
  const core = l.replace(/[:.]+$/, "").trim();

  // ---- Credit sections (payments / credits) ----
  if (/payments?\s+and\s+other\s+credits/.test(core)) return "credit";
  if (/payments?,?\s+credits\s+and\s+adjustments/.test(core)) return "credit";
  if (nospace.includes("paymentscreditsandadjustments")) return "credit";
  // A header that is essentially just "Credits" / "Payments and Credits".
  if (/^(payments?\s+(and\s+)?)?credits?$/.test(core)) return "credit";

  // ---- Charge sections (purchases / fees / interest) ----
  // Capital One / Kohl's per-cardholder "… : Transactions".
  if (/^transactions$/.test(core)) return "charge";
  if (/purchases?\s+and\s+adjustments/.test(core)) return "charge";
  // A header that is essentially just "(Standard) Purchases" (also handles the
  // pdf.js glyph split "Standard P urchases").
  if (/^(standard\s+)?purchases?$/.test(core)) return "charge";
  if (nospace === "standardpurchases" || nospace === "purchases") return "charge";
  if (/^interest\s+charged$/.test(core) || nospace === "interestcharged") return "charge";
  if (/^fees?\s+charged$/.test(core) || nospace === "feescharged") return "charge";

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
 * Strip a LEADING reference/confirmation code from a description — a single long
 * (>=10 char) all-caps alphanumeric token that contains a digit, followed by more
 * text (e.g. PayPal/Synchrony "P928300KP00Y2V35K Payment - Thank You" ->
 * "Payment - Thank You"). Conservative: only fires when the token has a digit and
 * real description text follows, so ordinary payees aren't clipped.
 */
function stripLeadingRef(desc: string): string {
  const m = desc.match(/^([A-Z0-9]{10,})\s+(\S.*)$/);
  if (m && /[0-9]/.test(m[1]) && /[A-Z]/.test(m[1])) return m[2].trim();
  return desc;
}

/**
 * Tidy a captured description for the preview: drop a trailing UNBALANCED
 * parenthesis fragment left behind when a "(…)" note wrapped across lines and
 * only its opening part survived (e.g. "Investment: VIGIX (Card Transaction" or
 * "Investment: VIGIX ("). Balanced parentheses are preserved. Also trims stray
 * trailing separators/brackets.
 */
function tidyDescription(desc: string): string {
  let s = desc.trim();
  // Remove a trailing UNBALANCED "(" fragment: scan left-to-right tracking paren
  // depth and, if we end with unmatched opens, cut from the FIRST open paren that
  // was never closed. This turns "VIGIX ( Card Transaction (" -> "VIGIX" while
  // leaving balanced notes like "(Tax year: 2026)" untouched.
  let depth = 0;
  let firstUnmatchedOpen = -1;
  for (let k = 0; k < s.length; k++) {
    const ch = s[k];
    if (ch === "(") {
      if (depth === 0) firstUnmatchedOpen = k;
      depth++;
    } else if (ch === ")") {
      if (depth > 0) depth--;
      if (depth === 0) firstUnmatchedOpen = -1;
    }
  }
  if (depth > 0 && firstUnmatchedOpen >= 0) {
    s = s.slice(0, firstUnmatchedOpen).trim();
  }
  // Trim leftover trailing separators and a dangling OPEN paren/bracket, but
  // keep a balanced closing ")" so "(Tax year: 2026)" stays intact.
  s = s.replace(/[\s({\[,;:.-]+$/g, "").trim();
  return s;
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
    if (m) {
      const yr = Number(m[3]);
      return { month: Number(m[1]), year: yr < 100 ? 2000 + yr : yr };
    }
  }
  // Citi-style "Billing Period: 07/24/26-08/25/26" -> closing month/year from
  // the period END. A 2-digit year is normalized to 20YY.
  for (const line of lines) {
    const m = BILLING_PERIOD_MDY.exec(line);
    if (m) {
      const yr = Number(m[3]);
      return { month: Number(m[1]), year: yr < 100 ? 2000 + yr : yr };
    }
  }
  // "New balance as of MM/DD/YYYY" (e.g. PayPal Cashback Mastercard).
  for (const line of lines) {
    const m = BALANCE_AS_OF_MDY.exec(line);
    if (m) {
      const yr = Number(m[3]);
      return { month: Number(m[1]), year: yr < 100 ? 2000 + yr : yr };
    }
  }
  // "… billing cycle from MM/DD/YYYY to MM/DD/YYYY" -> the END date.
  for (const line of lines) {
    const m = BILLING_CYCLE_TO_MDY.exec(line);
    if (m) {
      const yr = Number(m[3]);
      return { month: Number(m[1]), year: yr < 100 ? 2000 + yr : yr };
    }
  }
  // Month-name billing-cycle line, e.g. "Jul 12, 2026 - Aug 11, 2026 | 31 days
  // in Billing Cycle". The period END (last date on the line) is the closing
  // date, which anchors year inference for the transaction rows.
  for (const line of lines) {
    if (!/billing cycle/i.test(line)) continue;
    const matches = [...line.matchAll(CLOSING_DATE_NAME)];
    const last = matches[matches.length - 1];
    if (last) {
      const mon = monthNumber(last[1]);
      if (mon) return { month: mon, year: Number(last[3]) };
    }
  }
  // Otherwise, any month-name date with a year (first seen), e.g. a closing-date
  // header printed as "Aug 11, 2026".
  for (const line of lines) {
    const m = CLOSING_DATE_NAME.exec(line);
    CLOSING_DATE_NAME.lastIndex = 0; // reset the /g regex between lines
    if (m) {
      const mon = monthNumber(m[1]);
      if (mon) return { month: mon, year: Number(m[3]) };
    }
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
 * Detect a transaction table that has BOTH an "Amount" and a running "Balance"
 * column (e.g. an HSA "Transaction History": "Date Transaction Amount HSA Cash
 * Balance"). When present, a transaction row ends with TWO money values — the
 * amount followed by the balance — and we must take the FIRST, not the trailing
 * balance. Detected from a short, non-transaction header line that names both a
 * balance and an amount column.
 */
function hasBalanceColumn(lines: string[]): boolean {
  for (const line of lines) {
    const l = line.toLowerCase();
    if (l.length > 60) continue; // headers are short; skip prose
    if (/\bbalance\b/.test(l) && /\bamount\b/.test(l)) return true;
  }
  return false;
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
  const balanceColumn = hasBalanceColumn(lines);
  const rows: ParsedRow[] = [];
  let section: Section = "unknown";

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // A transaction line always starts with a date. Only *non-date* lines can be
    // section headers — this prevents a description containing the word "credit"
    // (e.g. "API CREDIT …") from being mistaken for a "Payments and Other
    // Credits" section header and flipping the sign of the rows that follow.
    // A month-name prefix only counts as a date when the word is a real month
    // (so headers like "SANDRA … : Transactions" aren't mistaken for dates).
    const monMatch = LEADING_MONTHNAME_DATE.exec(line);
    const startsWithMonthName = !!monMatch && monthNumber(monMatch[1]) != null;
    const startsWithDate =
      LEADING_ISO_DATE.test(line) ||
      LEADING_US_DATE.test(line) ||
      LEADING_DATE.test(line) ||
      startsWithMonthName;

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
      let yy = Number(us[3]);
      if (yy < 100) yy += 2000; // 2-digit year -> 20YY
      if (mm >= 1 && mm <= 12 && dd >= 1 && dd <= 31) {
        date = `${yy}-${String(mm).padStart(2, "0")}-${String(dd).padStart(2, "0")}`;
        rest = us[4];
      }
    } else if (md) {
      date = isoFromMonthDay(Number(md[1]), Number(md[2]), closingYear, closingMonth);
      rest = md[3];
    } else if (startsWithMonthName && monMatch) {
      const mon = monthNumber(monMatch[1]);
      if (mon != null) {
        date = isoFromMonthDay(mon, Number(monMatch[2]), closingYear, closingMonth);
        rest = monMatch[3];
      }
    }
    if (!date || rest == null) continue;

    // Find the amount on this line, or on the next line if it wrapped.
    let amountToken: string | null = null;
    // When the table has a trailing running-balance column, the row ends with
    // two money values: "<amount> <balance>". Strip the balance first so the
    // amount (the value we want) becomes the trailing token.
    if (balanceColumn) {
      const balMatch = TRAILING_AMOUNT.exec(rest);
      if (balMatch) {
        const withoutBalance = rest.slice(0, balMatch.index).trim();
        // Only treat it as a balance if an amount token remains before it;
        // otherwise this single value IS the amount (fall through below).
        if (TRAILING_AMOUNT.test(withoutBalance)) {
          rest = withoutBalance;
        }
      }
    }
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

    // Description recovery for wrapped rows: some layouts print the description
    // on the line ABOVE the date/amount line (e.g. HSA card transactions:
    //   "Amazon Mktpl*…, WA (Card Transaction"
    //   "7/24/2026 ($42.00) $2,837.93").
    // If what's left on the date line is empty or just punctuation, borrow the
    // previous line as the description when it isn't itself a transaction/header.
    let descSource = rest;
    if (/^[\s(){}\[\].,;:-]*$/.test(rest)) {
      const prev = lines[i - 1] ?? "";
      const prevIsDate =
        LEADING_ISO_DATE.test(prev) ||
        LEADING_US_DATE.test(prev) ||
        LEADING_DATE.test(prev) ||
        (() => {
          const m = LEADING_MONTHNAME_DATE.exec(prev);
          return !!m && monthNumber(m[1]) != null;
        })();
      if (prev && !prevIsDate && !sectionOf(prev) && !isNoiseLine(prev) && !LONE_AMOUNT.test(prev)) {
        // Combine the wrapped prefix with any punctuation remnant.
        descSource = `${prev} ${rest}`.trim();
      }
    }

    let desc = cleanDescription(
      tidyDescription(stripLeadingRef(stripTrailingRefs(descSource))) || null
    );

    // PayPal Cashback Mastercard: the description line is a generic
    // "PAYPAL PURCHASE SAN JOSE CA" and the ACTUAL merchant is printed on the
    // FOLLOWING line (e.g. "FASTSPRING", "OLIVE GARDEN 0021841"). When we see the
    // generic text and the next line is a plain merchant (no date/amount, not a
    // section header or noise), use that merchant as the payee and consume it.
    if (desc && /paypal\s+purchase/i.test(desc)) {
      const nextLine = lines[i + 1] ?? "";
      const nextIsDate =
        LEADING_ISO_DATE.test(nextLine) ||
        LEADING_US_DATE.test(nextLine) ||
        LEADING_DATE.test(nextLine) ||
        (() => {
          const m = LEADING_MONTHNAME_DATE.exec(nextLine);
          return !!m && monthNumber(m[1]) != null;
        })();
      const merchant = stripTrailingRefs(nextLine.trim());
      if (
        merchant &&
        !nextIsDate &&
        !LONE_AMOUNT.test(nextLine) &&
        !TRAILING_AMOUNT.test(nextLine) &&
        !sectionOf(nextLine) &&
        !isNoiseLine(nextLine)
      ) {
        desc = cleanDescription(tidyDescription(merchant) || null);
        i += 1; // consume the merchant line
      }
    }

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
