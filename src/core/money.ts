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

/**
 * Parse a percent string (e.g. "4.25" or "4.125") to basis points. Supports up to
 * three decimal places of percent, which is a tenth of a basis point, so the
 * stored value may be fractional (e.g. 4.125% -> 412.5 bps). Null if blank/invalid.
 */
export function percentToBps(input: string): number | null {
  const s = input.trim().replace(/%/g, "");
  if (s === "") return null;
  const value = Number(s);
  if (!Number.isFinite(value)) return null;
  // Round to a tenth of a basis point (= 3 decimal places of percent).
  return Math.round(value * 1000) / 10;
}

/** Format basis points (may be fractional) as a percent string ("4.125"). Empty for null. */
export function bpsToPercent(bps: number | null | undefined): string {
  if (bps == null) return "";
  // Trim trailing zeros from the (up to 3) decimal places.
  return String(Number((bps / 100).toFixed(3)));
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
 * Accepts plain amounts ("1,234.56", "$1234.5", "-42", "(42)" = negative) AND
 * simple algebraic expressions using + - * / and parentheses, e.g.
 * "12.50 + 3*2" or "(100-25)/2". Returns null if it cannot be parsed.
 */
export function parseCents(input: string): number | null {
  const value = evalMoneyExpression(input);
  if (value == null) return null;
  // Round to nearest cent to avoid float artifacts.
  return Math.round(value * 100);
}

/**
 * Evaluate a currency input as a number of DOLLARS, supporting simple arithmetic
 * (+ - * / and parentheses) with no `eval`/`Function`. Handles currency symbols,
 * whitespace, and thousands separators; a whole string wrapped in parentheses
 * around a plain number is treated as an accounting-style negative (e.g. banks
 * export "(1,234.56)" = -1234.56). Returns the numeric value, or null.
 */
export function evalMoneyExpression(input: string): number | null {
  if (input == null) return null;
  let s = String(input).trim();
  if (s === "") return null;

  // Accounting-style negative: the ENTIRE string is "(<plain number>)" with no
  // inner operators. Preserves bank-import semantics; a grouped sub-expression
  // (which contains operators) is handled by the evaluator instead.
  const acct = s.match(/^\(\s*([0-9,]*\.?[0-9]+)\s*\)$/);
  if (acct) {
    const n = Number(acct[1].replace(/,/g, ""));
    return Number.isFinite(n) ? -n : null;
  }

  // Strip currency symbols, spaces, and thousands separators; keep digits, a
  // decimal point, the operators, and parentheses.
  s = s.replace(/[,$\s]/g, "");
  s = s.replace(/[^0-9.+\-*/()]/g, "");
  if (s === "") return null;

  try {
    const value = new ExprParser(s).parse();
    return value != null && Number.isFinite(value) ? value : null;
  } catch {
    return null;
  }
}

/**
 * A tiny recursive-descent parser for + - * / and parentheses over decimal
 * numbers. No eval/Function; throws on malformed input. Grammar:
 *   expr   = term (('+' | '-') term)*
 *   term   = factor (('*' | '/') factor)*
 *   factor = ('+' | '-') factor | '(' expr ')' | number
 */
class ExprParser {
  private pos = 0;
  constructor(private readonly s: string) {}

  parse(): number {
    const v = this.expr();
    if (this.pos !== this.s.length) throw new Error("Unexpected trailing input");
    return v;
  }

  private expr(): number {
    let v = this.term();
    for (;;) {
      const c = this.s[this.pos];
      if (c === "+") { this.pos++; v += this.term(); }
      else if (c === "-") { this.pos++; v -= this.term(); }
      else break;
    }
    return v;
  }

  private term(): number {
    let v = this.factor();
    for (;;) {
      const c = this.s[this.pos];
      if (c === "*") { this.pos++; v *= this.factor(); }
      else if (c === "/") { this.pos++; v /= this.factor(); }
      else break;
    }
    return v;
  }

  private factor(): number {
    const c = this.s[this.pos];
    if (c === "+") { this.pos++; return this.factor(); }
    if (c === "-") { this.pos++; return -this.factor(); }
    if (c === "(") {
      this.pos++;
      const v = this.expr();
      if (this.s[this.pos] !== ")") throw new Error("Missing )");
      this.pos++;
      return v;
    }
    return this.number();
  }

  private number(): number {
    const start = this.pos;
    while (this.pos < this.s.length && /[0-9.]/.test(this.s[this.pos])) this.pos++;
    const tok = this.s.slice(start, this.pos);
    if (tok === "" || tok === ".") throw new Error("Expected number");
    const n = Number(tok);
    if (!Number.isFinite(n)) throw new Error("Bad number");
    return n;
  }
}

/**
 * Parse a per-unit PRICE string into cents, WITHOUT rounding to whole cents, so
 * sub-cent precision (e.g. a share price of $88.123456) is preserved. Returns a
 * possibly-fractional number of cents (here 8812.3456), or null if unparseable.
 *
 * Downstream storage keeps prices in micro-cents (price × 1e6, then rounded), so
 * this supports up to 6 decimal places of a dollar price. Use this for security
 * prices; use parseCents for ordinary money amounts (whole cents).
 */
export function parsePriceCents(input: string): number | null {
  const value = evalMoneyExpression(input);
  if (value == null) return null;
  // Cents WITHOUT whole-cent rounding (keeps up to sub-cent precision).
  return value * 100;
}
