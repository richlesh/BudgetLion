// CSV bank-statement parser with configurable column mapping.
// Pure/framework-agnostic (uses papaparse, which runs in browser + node).

import Papa from "papaparse";
import type { CsvColumnMapping, ParsedRow } from "../../shared/types";
import { parseCents } from "../money";
import { normalizeDate } from "./dates";
import { cleanDescription } from "./normalize";

/** Parse raw CSV text into a 2D array of string cells. */
export function parseCsvGrid(text: string): string[][] {
  const result = Papa.parse<string[]>(text.trim(), {
    skipEmptyLines: true,
  });
  return (result.data as string[][]) ?? [];
}

/**
 * Produce a best-guess column mapping from a header row.
 * Falls back to sensible defaults (col 0 = date, col 1 = payee, last = amount).
 */
export function guessMapping(grid: string[][]): CsvColumnMapping {
  const mapping: CsvColumnMapping = {
    date: 0,
    payee: null,
    memo: null,
    amount: null,
    debit: null,
    credit: null,
    transferAccountId: null,
    hasHeaderRow: false,
    dateFormat: "us",
  };
  if (grid.length === 0) return mapping;

  const header = grid[0].map((h) => h.toLowerCase().trim());
  const looksLikeHeader = header.some((h) =>
    /date|amount|description|payee|debit|credit|memo|balance/.test(h)
  );
  mapping.hasHeaderRow = looksLikeHeader;

  if (looksLikeHeader) {
    header.forEach((h, i) => {
      if (/date/.test(h) && mapping.date === 0) mapping.date = i;
      else if (/transfer.*account.*id/.test(h)) mapping.transferAccountId = i;
      else if (/payee|description|name|merchant/.test(h) && mapping.payee === null) mapping.payee = i;
      else if (/memo|note/.test(h)) mapping.memo = i;
      else if (/debit|withdrawal/.test(h)) mapping.debit = i;
      else if (/credit|deposit/.test(h)) mapping.credit = i;
      else if (/amount/.test(h)) mapping.amount = i;
    });
  } else {
    // Positional fallback
    const cols = grid[0].length;
    mapping.payee = cols > 1 ? 1 : null;
    mapping.amount = cols > 1 ? cols - 1 : null;
  }

  // If neither amount nor debit/credit were detected, use the last column as amount.
  if (mapping.amount === null && mapping.debit === null && mapping.credit === null) {
    mapping.amount = grid[0].length - 1;
  }
  return mapping;
}

function cell(row: string[], idx: number | null): string {
  return idx == null || idx < 0 || idx >= row.length ? "" : (row[idx] ?? "").trim();
}

/**
 * Apply a mapping to a parsed CSV grid, returning normalized signed rows.
 * Rows that fail to yield a valid date+amount are skipped.
 */
export function csvToRows(grid: string[][], mapping: CsvColumnMapping): ParsedRow[] {
  const dataRows = mapping.hasHeaderRow ? grid.slice(1) : grid;
  const out: ParsedRow[] = [];

  for (const row of dataRows) {
    const dateStr = cell(row, mapping.date);
    const date = normalizeDate(dateStr, mapping.dateFormat);
    if (!date) continue;

    let amountCents: number | null = null;
    if (mapping.amount !== null) {
      amountCents = parseCents(cell(row, mapping.amount));
    } else {
      const debit = mapping.debit !== null ? parseCents(cell(row, mapping.debit)) : null;
      const credit = mapping.credit !== null ? parseCents(cell(row, mapping.credit)) : null;
      if (debit != null && debit !== 0) amountCents = -Math.abs(debit);
      else if (credit != null && credit !== 0) amountCents = Math.abs(credit);
    }
    if (amountCents == null) continue;

    const payee = cleanDescription(cell(row, mapping.payee) || null);
    const memo = cell(row, mapping.memo) || null;
    const transferAccountRef = parseTransferRef(cell(row, mapping.transferAccountId));

    out.push({
      date,
      payee,
      memo,
      amountCents,
      importId: null, // CSV rarely has a stable ID; dedupe uses a synthesized key later
      transferAccountRef,
    });
  }
  return out;
}

/**
 * Parse a "Transfer Account ID" cell of the form "TO:<code>" or "FROM:<code>"
 * (case-insensitive, whitespace tolerant). Returns null if empty/unrecognized.
 */
export function parseTransferRef(
  value: string
): { dir: "to" | "from"; code: string } | null {
  const s = value.trim();
  if (!s) return null;
  const m = /^(to|from)\s*:\s*(.+)$/i.exec(s);
  if (!m) return null;
  return { dir: m[1].toLowerCase() as "to" | "from", code: m[2].trim() };
}
