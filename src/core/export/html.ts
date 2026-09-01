// Printable HTML generator for the ledger PDF export. Pure/framework-agnostic.

import type { Account, Category, LedgerRow } from "../../shared/types";
import { formatCents } from "../money";
import { categoryDisplayName } from "../categories";

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/** Build a self-contained printable HTML document for an account's ledger. */
export function ledgerToHtml(
  account: Account,
  rows: LedgerRow[],
  categories: Category[],
  fontOptions?: { font?: string; sizePx?: number }
): string {
  const catName = new Map(categories.map((c) => [c.id, categoryDisplayName(c, categories)]));
  const generated = new Date().toLocaleString();
  // Print/PDF font: chosen family (falls back to system) + base size.
  const bodyFont = fontOptions?.font
    ? `"${fontOptions.font}", -apple-system, Arial, sans-serif`
    : `-apple-system, Arial, sans-serif`;
  const baseSize = fontOptions?.sizePx && fontOptions.sizePx > 0 ? fontOptions.sizePx : 12;

  const bodyRows = rows
    .filter((r) => r.kind === "transaction" && r.transaction)
    .map((r) => {
      const t = r.transaction!;
      const neg = r.signedAmountCents < 0;
      const balNeg = r.runningBalanceCents < 0;
      return `<tr>
        <td>${esc(t.date)}</td>
        <td>${esc(t.payee ?? "")}</td>
        <td>${esc(t.memo ?? "")}</td>
        <td>${esc(t.categoryId ? catName.get(t.categoryId) ?? "" : "")}</td>
        <td class="num ${neg ? "neg" : ""}">${esc(formatCents(r.signedAmountCents, account.currency))}</td>
        <td class="num ${balNeg ? "neg" : ""}">${esc(formatCents(r.runningBalanceCents, account.currency))}</td>
      </tr>`;
    })
    .join("\n");

  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>${esc(account.name)} Ledger</title>
<style>
  body { font-family: ${bodyFont}; color: #111; margin: 24px; font-size: ${baseSize}px; }
  h1 { font-size: ${baseSize + 8}px; margin: 0 0 2px; }
  .sub { color: #666; font-size: ${Math.max(10, baseSize - 2)}px; margin-bottom: 16px; }
  table { width: 100%; border-collapse: collapse; font-size: ${baseSize}px; }
  th, td { text-align: left; padding: 6px 8px; border-bottom: 1px solid #ddd; }
  th { background: #f2f2f2; }
  .num { text-align: right; font-variant-numeric: tabular-nums; }
  .neg { color: #c0392b; }
  tfoot td { font-weight: 600; }
</style></head>
<body>
  <h1>${esc(account.name)}</h1>
  <div class="sub">${esc(account.type.replace("_", " "))} · ${esc(account.currency)} · generated ${esc(generated)}</div>
  <table>
    <thead>
      <tr><th>Date</th><th>Payee</th><th>Memo</th><th>Category</th><th class="num">Amount</th><th class="num">Balance</th></tr>
    </thead>
    <tbody>
      ${bodyRows}
    </tbody>
  </table>
</body></html>`;
}
