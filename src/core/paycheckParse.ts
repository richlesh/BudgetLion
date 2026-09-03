// Deterministic paycheck-stub text parser. Pure, dependency-free (no PDF library,
// no AI). Given the plain text extracted from a pay-stub PDF, it recognizes common
// labels and their (current-period) dollar amounts and produces a partial draft to
// prefill the Paycheck dialog. The user reviews and assigns category/account
// targets before saving — this only fills in labels and amounts it is confident of.
//
// Amount handling: many stubs show two columns per line (Current and YTD). We take
// the FIRST money amount on a label's line as the current-period value. Amounts may
// use commas, a leading $, or parentheses for negatives.

/** A parsed deduction line: a label and a positive magnitude in cents. */
export interface ParsedDeduction {
  label: string;
  amountCents: number;
}

/** The subset of paycheck fields we can extract from stub text. */
export interface ParsedPaycheck {
  /** Employer / company name, or null if not confidently found. */
  employer: string | null;
  /** Pay date as ISO (YYYY-MM-DD), or null if not found. */
  date: string | null;
  grossCents: number | null;
  netCents: number | null;
  deductions: ParsedDeduction[];
  /** Labels recognized but with no parseable amount (for diagnostics/UX). */
  unresolvedLabels: string[];
}

/** Parse the first money value on a string into positive cents, or null. */
function firstAmountCents(s: string): number | null {
  // Match $1,234.56 / 1234.56 / (1,234.56) / 1,234 forms.
  const m = s.match(/\(?\$?\s*-?\d{1,3}(?:,\d{3})*(?:\.\d{1,2})?\)?/);
  if (!m) return null;
  let raw = m[0];
  const negative = /^\(.*\)$/.test(raw.trim()) || raw.includes("-");
  raw = raw.replace(/[()$,\s-]/g, "");
  if (raw === "" || raw === ".") return null;
  const value = Number(raw);
  if (!Number.isFinite(value)) return null;
  const cents = Math.round(value * 100);
  return negative ? -cents : cents;
}

/** True when a line begins with a money value (a value column, not a label row),
 *  e.g. "5,000.00 90,000.00" or "$5,000.00". Used to attach an amount from the
 *  line following a label that had no amount of its own. A leading letter (a
 *  label) makes it false. */
function startsWithMoney(s: string): boolean {
  return /^\s*\(?\$?\s*-?\d/.test(s);
}

/** Every money-looking token on a line, as {cents, isPercent, raw}. */
interface MoneyToken {
  cents: number; // positive magnitude in cents
  isPercent: boolean; // immediately followed by '%'
  hasThousands: boolean; // contained a thousands separator (looks like a real amount)
}
function allMoneyTokens(s: string): MoneyToken[] {
  const re = /(\$?\s*\d{1,3}(?:,\d{3})+(?:\.\d{1,2})?|\$?\s*\d+(?:\.\d{1,2})?)(\s*%)?/g;
  const out: MoneyToken[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(s)) != null) {
    const rawNum = m[1].replace(/[$,\s]/g, "");
    if (rawNum === "" || rawNum === ".") continue;
    const value = Number(rawNum);
    if (!Number.isFinite(value)) continue;
    out.push({
      cents: Math.round(value * 100),
      isPercent: !!m[2],
      hasThousands: /,/.test(m[1]),
    });
  }
  return out;
}

/**
 * Pick the withholding amount from the tokens that follow a deduction label.
 * Pay stubs frequently put a RATE column before the amount, e.g.
 *   "Social Security  6.20  310.00  5,580.00"  (rate, current, YTD)
 * so we skip a leading rate-looking token (an explicit percent, or a small
 * value < $10.00 that is followed by a larger amount) and take the first real
 * money amount. Returns positive cents, or null.
 */
function pickDeductionAmount(afterLabel: string): number | null {
  const toks = allMoneyTokens(afterLabel);
  if (toks.length === 0) return null;
  // Drop explicit percentages outright (they're rates, never the amount).
  const nonPct = toks.filter((t) => !t.isPercent);
  if (nonPct.length === 0) return null;
  // If the first token looks like a rate (small, no thousands sep) AND there's a
  // larger following amount, skip it. A lone value is taken as-is.
  if (
    nonPct.length >= 2 &&
    nonPct[0].cents < 1000 && // < $10.00
    !nonPct[0].hasThousands &&
    nonPct[1].cents > nonPct[0].cents
  ) {
    return nonPct[1].cents;
  }
  return nonPct[0].cents;
}

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12,
};

/** Zero-pad a number to 2 digits. */
function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/** Expand a 2-digit year to 4 digits (00–68 => 2000s, 69–99 => 1900s). */
function expandYear(y: number): number {
  if (y >= 100) return y;
  return y <= 68 ? 2000 + y : 1900 + y;
}

/**
 * Parse the first date found in a string into ISO (YYYY-MM-DD), or null.
 * Handles YYYY-MM-DD, MM/DD/YYYY, M/D/YY (dashes or slashes), and month-name
 * forms like "Sep 15, 2026" / "September 15 2026".
 */
function firstDateIso(s: string): string | null {
  // ISO first: YYYY-MM-DD (or YYYY/MM/DD).
  let m = s.match(/\b(\d{4})[-/](\d{1,2})[-/](\d{1,2})\b/);
  if (m) {
    const y = Number(m[1]), mo = Number(m[2]), d = Number(m[3]);
    if (mo >= 1 && mo <= 12 && d >= 1 && d <= 31) return `${y}-${pad2(mo)}-${pad2(d)}`;
  }
  // Numeric US: MM/DD/YYYY or M/D/YY (also with dashes).
  m = s.match(/\b(\d{1,2})[-/](\d{1,2})[-/](\d{2,4})\b/);
  if (m) {
    const mo = Number(m[1]), d = Number(m[2]), y = expandYear(Number(m[3]));
    if (mo >= 1 && mo <= 12 && d >= 1 && d <= 31) return `${y}-${pad2(mo)}-${pad2(d)}`;
  }
  // Month name: "Sep 15, 2026" / "September 15 2026".
  m = s.match(/\b([A-Za-z]{3,9})\.?\s+(\d{1,2}),?\s+(\d{4})\b/);
  if (m) {
    // Normalize to the 3-letter key ("september" -> "sep"); "sept" also maps.
    const name = m[1].toLowerCase();
    const mo = MONTHS[name] ?? MONTHS[name.slice(0, 3)];
    const d = Number(m[2]), y = Number(m[3]);
    if (mo && d >= 1 && d <= 31) return `${y}-${pad2(mo)}-${pad2(d)}`;
  }
  return null;
}

/**
 * Date labels that indicate the pay date, in priority order (lower = preferred).
 * "Pay/Advice/Check/Deposit Date" are the actual disbursement date; "Pay Period
 * End" and similar are a fallback when no explicit pay/advice date is present.
 */
const DATE_LABELS: Array<{ re: RegExp; priority: number }> = [
  { re: /\b(pay\s*date|advice\s*date|check\s*date|deposit\s*date)\b/i, priority: 1 },
  { re: /\b(pay\s*period\s*end(ing)?|period\s*end(ing)?|pay\s*period\s*to)\b/i, priority: 2 },
];

/** Lines we never treat as an employer name (labels, totals, boilerplate). */
const EMPLOYER_SKIP = /\b(pay|earnings|gross|net|tax|deduction|employee|ssn|social|medicare|federal|state|hours|rate|period|advice|check|deposit|statement|date|ytd|current|address|direct|routing|account\s*number)\b/i;

/** Looks like a phone number (so we never treat it as a company name). */
function looksLikePhone(s: string): boolean {
  const digits = s.replace(/\D/g, "");
  return digits.length >= 7 && /[\d().\-\s]/.test(s) && /\d[\d().\-\s]{6,}\d/.test(s);
}

/**
 * Extract the employer/company name.
 *
 * 1) An explicit "Employer:" / "Company:" / "Employer Name:" field. The label
 *    must be followed directly by a separator, so "Employer Phone Number: ..."
 *    (a different field that merely starts with "Employer") does NOT match.
 * 2) Otherwise the first header line that reads like a company name — top-left of
 *    the stub — skipping known labels, addresses, phone numbers, and number-heavy
 *    lines (dates/amounts/ids).
 */
function extractEmployer(lines: string[]): string | null {
  // 1) Explicit label: "Employer" / "Company" optionally "Name", then a separator.
  for (const line of lines) {
    const m = line.match(/^\s*(employer|company)(\s+name)?\s*[:#-]\s*(.+)$/i);
    if (!m) continue;
    const name = m[3].trim();
    if (!name) continue;
    if (EMPLOYER_SKIP.test(name)) continue; // e.g. an "Employer Address:" value
    if (looksLikePhone(name)) continue; // e.g. "Employer Phone Number: 555-..."
    if (!/[A-Za-z]/.test(name)) continue;
    return name.replace(/\s{2,}/g, " ");
  }
  // 2) Heuristic: first few lines, pick the first that looks like a company name.
  for (const line of lines.slice(0, 6)) {
    const l = line.trim();
    if (l.length < 2 || l.length > 60) continue;
    if (EMPLOYER_SKIP.test(l)) continue;
    if (looksLikePhone(l)) continue;
    if (!/[A-Za-z]/.test(l)) continue; // must have letters
    if (/\d{2,}/.test(l)) continue; // skip lines dominated by numbers (dates/amounts/ids)
    // Skip lines that are clearly a street address (start with a house number).
    if (/^\d+\s+\S/.test(l)) continue;
    return l.replace(/\s{2,}/g, " ");
  }
  return null;
}

/** Known label patterns → a normalized display label. Order matters (specific first). */
const LABEL_PATTERNS: Array<{ re: RegExp; label: string; kind: "gross" | "net" | "deduction" }> = [
  { re: /\b(gross\s*(pay|earnings|wages|income)?|total\s*(gross|earnings|pay|wages)|current\s*(gross|earnings)|taxable\s*gross|gross\s*amount)\b/i, label: "Gross Pay", kind: "gross" },
  { re: /\b(net\s*(pay|check|deposit|amount|earnings)?|take[-\s]*home(\s*pay)?|net\s*direct\s*deposit)\b/i, label: "Net Pay", kind: "net" },
  { re: /\bfed(eral)?\s*(income)?\s*(tax|w\/?h|withhold\w*)\b/i, label: "Federal Income Tax", kind: "deduction" },
  { re: /\b(social\s*security|oasdi|fica[-\s/]*ss|fica[-\s/]*oasdi|ss[-\s/]*ee|oasdi[-\s/]*ee)\b/i, label: "Social Security", kind: "deduction" },
  { re: /\b(medicare|fica[-\s/]*med|med[-\s/]*ee|hi[-\s/]*ee)\b/i, label: "Medicare", kind: "deduction" },
  { re: /\bstate\s*(income)?\s*(tax|w\/?h|withhold\w*)\b/i, label: "State Income Tax", kind: "deduction" },
  { re: /\b(local|city)\s*(income)?\s*tax\b/i, label: "Local Tax", kind: "deduction" },
  { re: /\b401\s*\(?k\)?\b/i, label: "401(k)", kind: "deduction" },
  { re: /\b(roth)\b/i, label: "Roth 401(k)", kind: "deduction" },
  { re: /\bh\.?s\.?a\.?\b/i, label: "HSA", kind: "deduction" },
  { re: /\bf\.?s\.?a\.?\b/i, label: "FSA", kind: "deduction" },
  { re: /\b(health|medical)\s*(ins\w*|premium)?\b/i, label: "Health Insurance", kind: "deduction" },
  { re: /\bdental\b/i, label: "Dental Insurance", kind: "deduction" },
  { re: /\bvision\b/i, label: "Vision Insurance", kind: "deduction" },
  { re: /\b(life\s*ins\w*|group\s*life|std|ltd|disability)\b/i, label: "Life/Disability Insurance", kind: "deduction" },
];

/**
 * Parse pay-stub text into a partial paycheck. Deterministic; no network/AI.
 * Best-effort: fields it can't find are null / omitted so the user fills them in.
 */
export function parsePaycheckText(text: string): ParsedPaycheck {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  let grossCents: number | null = null;
  let netCents: number | null = null;
  const deductions: ParsedDeduction[] = [];
  const unresolvedLabels: string[] = [];
  // Avoid double-counting the same label from multiple matching lines.
  const seen = new Set<string>();

  // Best pay date found so far, tracked with its label priority (lower wins).
  let date: string | null = null;
  let datePriority = Infinity;
  for (const line of lines) {
    for (const dl of DATE_LABELS) {
      if (dl.priority >= datePriority) continue; // already have an equal/better one
      const m = dl.re.exec(line);
      if (!m) continue;
      // Look for the date AFTER the label on the same line.
      const iso = firstDateIso(line.slice((m.index ?? 0) + m[0].length));
      if (iso) {
        date = iso;
        datePriority = dl.priority;
      }
    }
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    for (const p of LABEL_PATTERNS) {
      const m = p.re.exec(line);
      if (!m) continue;
      if (seen.has(p.label)) continue;
      // Extract the amount from the text AFTER the matched label, so digits that
      // are part of the label itself (e.g. the "401" in "401(k)") aren't mistaken
      // for the amount.
      const afterLabel = line.slice((m.index ?? 0) + m[0].length);
      // Gross/net take the first amount; deductions use a rate-aware picker so a
      // leading rate column (e.g. Social Security 6.20 310.00) isn't mistaken for
      // the withholding amount.
      const pick = (s: string) => (p.kind === "deduction" ? pickDeductionAmount(s) : firstAmountCents(s));
      let amt = pick(afterLabel);
      // Column layout fallback: if the label line carries no amount, look at the
      // next line(s) — but only when that line STARTS with a money value (a value
      // column), so we don't steal a different labeled row's amount.
      if (amt == null) {
        for (let j = i + 1; j < lines.length && j <= i + 2; j++) {
          const next = lines[j];
          if (!startsWithMoney(next)) break; // a labeled line — stop looking
          const nextAmt = pick(next);
          if (nextAmt != null) {
            amt = nextAmt;
            break;
          }
        }
      }
      if (amt == null) {
        // Label present but amount not on this or the next line — note it once.
        if (!unresolvedLabels.includes(p.label)) unresolvedLabels.push(p.label);
        continue;
      }
      seen.add(p.label);
      const magnitude = Math.abs(amt);
      if (p.kind === "gross") grossCents = magnitude;
      else if (p.kind === "net") netCents = magnitude;
      else deductions.push({ label: p.label, amountCents: magnitude });
      break; // one label per line
    }
  }

  // Drop any label from unresolved that later resolved on another line.
  const resolved = new Set<string>([...seen]);
  return {
    employer: extractEmployer(lines),
    date,
    grossCents,
    netCents,
    deductions,
    unresolvedLabels: unresolvedLabels.filter((l) => !resolved.has(l)),
  };
}

/** Build a tolerant regex that matches a specific label's words in order,
 *  allowing arbitrary separators between words (spaces, punctuation). */
function labelRegex(label: string): RegExp | null {
  const words = label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter((w) => w.length > 0)
    .map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  if (words.length === 0) return null;
  return new RegExp("\\b" + words.join("[^A-Za-z0-9]{0,3}") + "\\b", "i");
}

/**
 * Find the (current-period) amount for a SPECIFIC label in the stub text, in
 * positive cents, or null. Uses the same rate-aware picker and next-line
 * fallback as the main parser, so it works for column layouts too. Used to look
 * up amounts for line items templated from a prior paycheck.
 */
export function amountForLabel(text: string, label: string): number | null {
  const re = labelRegex(label);
  if (!re) return null;
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0);
  for (let i = 0; i < lines.length; i++) {
    const m = re.exec(lines[i]);
    if (!m) continue;
    const after = lines[i].slice((m.index ?? 0) + m[0].length);
    let amt = pickDeductionAmount(after);
    if (amt == null) {
      for (let j = i + 1; j < lines.length && j <= i + 2; j++) {
        if (!startsWithMoney(lines[j])) break;
        const a = pickDeductionAmount(lines[j]);
        if (a != null) { amt = a; break; }
      }
    }
    if (amt != null) return Math.abs(amt);
  }
  return null;
}
