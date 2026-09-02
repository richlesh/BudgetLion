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

/** Known label patterns → a normalized display label. Order matters (specific first). */
const LABEL_PATTERNS: Array<{ re: RegExp; label: string; kind: "gross" | "net" | "deduction" }> = [
  { re: /\bgross\s*(pay|earnings|wages)?\b/i, label: "Gross Pay", kind: "gross" },
  { re: /\bnet\s*(pay|check|deposit)\b/i, label: "Net Pay", kind: "net" },
  { re: /\bfed(eral)?\s*(income)?\s*(tax|w\/?h|withhold\w*)\b/i, label: "Federal Income Tax", kind: "deduction" },
  { re: /\b(social\s*security|oasdi|fica(?!.*med))\b/i, label: "Social Security", kind: "deduction" },
  { re: /\bmedicare\b/i, label: "Medicare", kind: "deduction" },
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

  for (const line of lines) {
    for (const p of LABEL_PATTERNS) {
      const m = p.re.exec(line);
      if (!m) continue;
      if (seen.has(p.label)) continue;
      // Extract the amount from the text AFTER the matched label, so digits that
      // are part of the label itself (e.g. the "401" in "401(k)") aren't mistaken
      // for the amount.
      const afterLabel = line.slice((m.index ?? 0) + m[0].length);
      const amt = firstAmountCents(afterLabel);
      if (amt == null) {
        // Label present but amount not on this line — note it once.
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
    grossCents,
    netCents,
    deductions,
    unresolvedLabels: unresolvedLabels.filter((l) => !resolved.has(l)),
  };
}
