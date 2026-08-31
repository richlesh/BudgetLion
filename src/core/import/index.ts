// Import orchestration: format detection, dedupe-key synthesis, and conversion
// of signed ParsedRows into account-scoped NewTransactionInput values.
// Pure/framework-agnostic.

import type {
  ImportFormat,
  NewTransactionInput,
  ParsedRow,
  Transaction,
} from "../../shared/types";
import { looksLikeOfx } from "./ofx";
import { looksLikeQif } from "./qif";

// Re-export description normalization so consumers can import from "../core/import".
export { cleanDescription } from "./normalize";

/** Guess the import format from a filename and/or file contents. */
export function detectFormat(fileName: string, text: string): ImportFormat {
  const lower = fileName.toLowerCase();
  if (lower.endsWith(".ofx") || lower.endsWith(".qfx")) return "ofx";
  if (lower.endsWith(".qif")) return "qif";
  if (lower.endsWith(".csv")) return "csv";
  if (looksLikeOfx(text)) return "ofx";
  if (looksLikeQif(text)) return "qif";
  return "csv";
}

/**
 * Deterministic dedupe key for a parsed row. Prefers the bank's FITID; otherwise
 * synthesizes a stable key from date + signed amount + payee. Same statement
 * re-imported => same keys => detected as duplicates.
 */
export function dedupeKey(row: ParsedRow): string {
  if (row.importId) return row.importId;
  const payee = (row.payee ?? "").toLowerCase().replace(/\s+/g, " ").trim();
  return `syn:${row.date}:${row.amountCents}:${payee}`;
}

/**
 * Given the account's existing transactions, return the set of importIds
 * already present (so re-imports can be detected as duplicates).
 */
export function existingImportIds(transactions: Transaction[]): Set<string> {
  const ids = new Set<string>();
  for (const t of transactions) {
    if (t.deletedAt == null && t.importId) ids.add(t.importId);
  }
  return ids;
}

/**
 * Heuristic: does this row look like a transfer based on its description?
 * True when the payee or memo contains the word "transfer" (case-insensitive)
 * as a whole word. Used to prompt the user for the counterparty account when no
 * Account ID reference is available to match automatically.
 */
export function looksLikeTransferByDescription(row: ParsedRow): boolean {
  const text = `${row.payee ?? ""} ${row.memo ?? ""}`;
  return /\btransfer\b/i.test(text);
}

/**
 * Convert a signed ParsedRow into a NewTransactionInput for a target account.
 *  - negative amount => money leaves the account (fromAccountId = account)
 *  - positive amount => money enters the account (toAccountId = account)
 * The synthesized/real dedupe key is stored in importId.
 */
export function rowToTransaction(
  row: ParsedRow,
  accountId: string
): NewTransactionInput {
  const magnitude = Math.abs(row.amountCents);
  const outflow = row.amountCents < 0;
  // If the row resolved to a counterparty account, wire the opposite side so the
  // single-entry import becomes a proper transfer between two tracked accounts.
  const counterparty = row.resolvedTransferAccountId ?? null;
  return {
    date: row.date,
    // Transfers auto-generate their payee ("To/From <account>") on display.
    payee: counterparty ? null : row.payee,
    memo: row.memo,
    amountCents: magnitude,
    fromAccountId: outflow ? accountId : counterparty,
    toAccountId: outflow ? counterparty : accountId,
    categoryId: null,
    importId: dedupeKey(row),
  };
}
