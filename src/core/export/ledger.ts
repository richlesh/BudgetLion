// Ledger export generators (CSV, QIF). Pure/framework-agnostic.
// PDF/PNG are produced via Electron printToPDF and canvas capture respectively,
// so they are not handled here.

import type { Account, Category, LedgerRow } from "../../shared/types";
import { categoryDisplayName } from "../categories";

function csvEscape(value: string): string {
  if (/[",\r\n]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

function dollars(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
}

/**
 * For a transfer row, describe the counterparty account by its user Account ID,
 * with direction relative to the exported account:
 *   money leaving this account  -> "TO:<code>"
 *   money entering this account -> "FROM:<code>"
 * Returns "" for non-transfers or when the counterparty/code is unknown.
 */
function transferAccountId(
  account: Account,
  row: LedgerRow,
  codeById: Map<string, string>
): string {
  const t = row.transaction;
  if (!t || !t.fromAccountId || !t.toAccountId) return "";
  const outflow = t.fromAccountId === account.id;
  const otherId = outflow ? t.toAccountId : t.fromAccountId;
  const code = codeById.get(otherId);
  if (!code) return "";
  return `${outflow ? "TO" : "FROM"}:${code}`;
}

/**
 * Export an account's ledger as CSV.
 * Columns: Date, Payee, Memo, Category, Amount, Balance.
 * Amount is the account-signed value (inflow positive, outflow negative).
 */
export function ledgerToCsv(
  account: Account,
  rows: LedgerRow[],
  categories: Category[],
  accounts: Account[] = []
): string {
  const catName = new Map(categories.map((c) => [c.id, categoryDisplayName(c, categories)]));
  const codeById = new Map(
    accounts.filter((a) => a.accountCode).map((a) => [a.id, a.accountCode as string])
  );
  const ownCode = account.accountCode ?? "";
  const header = [
    "Date",
    "Payee",
    "Memo",
    "Category",
    "Amount",
    "Balance",
    "Account ID",
    "Transfer Account ID",
  ];
  const lines = [header.join(",")];

  for (const r of rows) {
    if (r.kind !== "transaction" || !r.transaction) continue;
    const t = r.transaction;
    const cols = [
      t.date,
      t.payee ?? "",
      t.memo ?? "",
      t.categoryId ? catName.get(t.categoryId) ?? "" : "",
      dollars(r.signedAmountCents),
      dollars(r.runningBalanceCents),
      ownCode,
      transferAccountId(account, r, codeById),
    ].map((c) => csvEscape(String(c)));
    lines.push(cols.join(","));
  }
  return lines.join("\r\n") + "\r\n";
}

/**
 * Export an account's ledger as QIF (Type:Bank).
 * Uses the account-signed amount so the sign round-trips on re-import.
 */
export function ledgerToQif(
  account: Account,
  rows: LedgerRow[],
  categories: Category[],
  accounts: Account[] = []
): string {
  const catName = new Map(categories.map((c) => [c.id, categoryDisplayName(c, categories)]));
  const codeById = new Map(
    accounts.filter((a) => a.accountCode).map((a) => [a.id, a.accountCode as string])
  );
  const out: string[] = ["!Type:Bank"];

  for (const r of rows) {
    if (r.kind !== "transaction" || !r.transaction) continue;
    const t = r.transaction;
    // QIF conventional date is MM/DD/YYYY.
    const [y, m, d] = t.date.split("-");
    out.push(`D${m}/${d}/${y}`);
    out.push(`T${dollars(r.signedAmountCents)}`);
    if (t.payee) out.push(`P${t.payee}`);
    if (t.memo) out.push(`M${t.memo}`);
    if (t.categoryId && catName.has(t.categoryId)) out.push(`L${catName.get(t.categoryId)}`);
    // Encode the transfer counterparty Account ID in an address line so it can
    // round-trip on import: "TRANSFER TO/FROM ACCOUNT ID:<code>".
    const xfer = transferAccountId(account, r, codeById);
    if (xfer) {
      const [dir, code] = xfer.split(":");
      out.push(`ATRANSFER ${dir} ACCOUNT ID:${code}`);
    }
    out.push("^");
  }
  return out.join("\r\n") + "\r\n";
}
