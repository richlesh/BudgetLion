// Date normalization for bank imports. Pure, framework-agnostic.

export type DateFormat = "iso" | "us" | "eu";

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

/**
 * Normalize a variety of bank date strings to ISO YYYY-MM-DD.
 * Supported inputs:
 *   - ISO: 2026-02-15 (or with time/zone suffix)
 *   - US: 02/15/2026 or 2/15/26
 *   - EU: 15/02/2026 or 15.02.2026
 *   - OFX compact: 20260215 or 20260215120000[-5:EST]
 * Returns null if it cannot be parsed.
 */
export function normalizeDate(input: string, format: DateFormat = "iso"): string | null {
  if (!input) return null;
  const s = input.trim();

  // OFX compact YYYYMMDD (optionally followed by time / timezone like [-5:EST]).
  // Detect by a leading 8-digit run that is NOT part of a delimited date.
  const ofx = s.match(/^(\d{4})(\d{2})(\d{2})(?:\d|\[|$)/);
  if (ofx && !/^\d{4}[/.\-]/.test(s)) {
    return `${ofx[1]}-${ofx[2]}-${ofx[3]}`;
  }

  // Already ISO
  const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;

  // Delimited numeric (/, -, .)
  const parts = s.split(/[/.\-]/).map((p) => p.trim());
  if (parts.length === 3) {
    let y: number, m: number, d: number;
    if (parts[0].length === 4) {
      // YYYY?DD?MM ambiguous — treat as ISO-like Y M D
      [y, m, d] = [Number(parts[0]), Number(parts[1]), Number(parts[2])];
    } else if (format === "eu") {
      [d, m, y] = [Number(parts[0]), Number(parts[1]), Number(parts[2])];
    } else {
      // default US
      [m, d, y] = [Number(parts[0]), Number(parts[1]), Number(parts[2])];
    }
    if (y < 100) y += 2000; // two-digit year
    if (!y || !m || !d || m > 12 || d > 31) return null;
    return `${y}-${pad(m)}-${pad(d)}`;
  }

  // Last resort: Date parsing
  const parsed = new Date(s);
  if (!isNaN(parsed.getTime())) {
    return `${parsed.getFullYear()}-${pad(parsed.getMonth() + 1)}-${pad(parsed.getDate())}`;
  }
  return null;
}
