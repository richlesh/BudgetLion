import { useEffect, useMemo, useState } from "react";
import type { AggregateData, Account, Category, TransactionSplit } from "../shared/types";
import { categoryOptions, categoryDisplayName } from "../core/categories";
import { formatCents } from "../core/money";

interface Props {
  /** Prefill the account scope (e.g. the currently-selected account), or null for All. */
  initialAccountId?: string | null;
  onClose: () => void;
}

/** One matching row shown in the report (a transaction, or a split leg of one). */
interface ReportRow {
  id: string; // unique per rendered row (tx id, or tx id + split id)
  date: string;
  payee: string;
  memo: string;
  accountName: string; // the account the amount is drawn from/deposited to
  amountCents: number; // signed: income (+) / expense (-)
}

/**
 * Collect the report rows for a single category over an (optional) inclusive
 * date range, optionally scoped to a single account. A transaction contributes a
 * row when its own categoryId matches; a split transaction contributes one row
 * per matching category leg. Amounts are signed by direction: income is positive
 * (money in via toAccount), expense is negative (money out via fromAccount).
 * When `accountId` is set, only rows drawn from/deposited to that account are kept.
 */
function collectRows(
  data: AggregateData,
  categoryId: string,
  startDate: string,
  endDate: string,
  accountId: string
): ReportRow[] {
  if (!categoryId) return [];
  const acctName = new Map(data.accounts.map((a) => [a.id, a.name]));
  const splitsByTx = new Map<string, TransactionSplit[]>();
  for (const s of data.splits) {
    if (s.deletedAt != null) continue;
    const arr = splitsByTx.get(s.transactionId) ?? [];
    arr.push(s);
    splitsByTx.set(s.transactionId, arr);
  }

  const inRange = (d: string) =>
    (!startDate || d >= startDate) && (!endDate || d <= endDate);

  const rows: ReportRow[] = [];
  for (const tx of data.transactions) {
    if (tx.deletedAt != null) continue;
    if (!inRange(tx.date)) continue;

    const legs = splitsByTx.get(tx.id) ?? [];
    const matchingLegs = legs.filter((l) => l.categoryId === categoryId);

    // A plain (non-split) transaction categorized directly to this category.
    if (matchingLegs.length === 0 && tx.categoryId === categoryId) {
      // Direction: income when it lands in an account (toAccountId), else expense.
      const isIncome = tx.toAccountId != null && tx.fromAccountId == null;
      const acctId = isIncome ? tx.toAccountId : tx.fromAccountId;
      if (accountId && acctId !== accountId) continue; // scope to one account
      rows.push({
        id: tx.id,
        date: tx.date,
        payee: tx.payee ?? "",
        memo: tx.memo ?? "",
        accountName: (acctId && acctName.get(acctId)) || "",
        amountCents: isIncome ? tx.amountCents : -tx.amountCents,
      });
      continue;
    }

    // Split legs assigned to this category. Split amounts are signed from the
    // owning account's perspective: negative = outflow (expense), positive =
    // inflow (income). We report that sign directly.
    const ownerAcctId = tx.fromAccountId ?? tx.toAccountId;
    if (accountId && ownerAcctId !== accountId) continue; // scope to one account
    const ownerName = (ownerAcctId && acctName.get(ownerAcctId)) || "";
    for (const leg of matchingLegs) {
      rows.push({
        id: `${tx.id}:${leg.id}`,
        date: tx.date,
        payee: tx.payee ?? "",
        memo: leg.memo ?? tx.memo ?? "",
        accountName: ownerName,
        amountCents: leg.amountCents,
      });
    }
  }

  rows.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.id.localeCompare(b.id)));
  return rows;
}

/**
 * Category Report: pick an income/expense category and an optional date range,
 * then list every matching transaction (including split legs) with a total.
 * Printable.
 */
export function CategoryReport({ initialAccountId = null, onClose }: Props) {
  const [data, setData] = useState<AggregateData | null>(null);
  const [categoryId, setCategoryId] = useState("");
  const [accountId, setAccountId] = useState<string>(initialAccountId ?? "");
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");

  useEffect(() => {
    void window.ledger.getAggregateData().then(setData);
  }, []);

  const categories: Category[] = data?.categories ?? [];
  const catChoices = useMemo(() => categoryOptions(categories), [categories]);
  const accounts: Account[] = useMemo(
    () =>
      (data?.accounts ?? [])
        .slice()
        .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" })),
    [data]
  );

  const rows = useMemo(
    () => (data ? collectRows(data, categoryId, startDate, endDate, accountId) : []),
    [data, categoryId, startDate, endDate, accountId]
  );
  const total = useMemo(() => rows.reduce((s, r) => s + r.amountCents, 0), [rows]);

  const currency = data?.accounts[0]?.currency ?? "USD";
  const categoryLabel = useMemo(() => {
    const c = categories.find((x) => x.id === categoryId);
    return c ? categoryDisplayName(c, categories) : "";
  }, [categoryId, categories]);
  const accountLabel = useMemo(() => {
    if (!accountId) return "All Accounts";
    return accounts.find((a) => a.id === accountId)?.name ?? "All Accounts";
  }, [accountId, accounts]);

  function printReport() {
    if (!categoryId) return;
    const rangeText =
      startDate || endDate
        ? `${startDate || "…"} to ${endDate || "…"}`
        : "All dates";
    const body = rows
      .map(
        (r) =>
          `<tr><td>${escapeHtml(r.date)}</td><td>${escapeHtml(r.payee)}</td>` +
          `<td>${escapeHtml(r.memo)}</td><td>${escapeHtml(r.accountName)}</td>` +
          `<td class="n">${formatCents(r.amountCents, currency)}</td></tr>`
      )
      .join("");
    const html = `<!doctype html><html><head><meta charset="utf-8"><title>Category Report</title>
      <style>
        body{font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;margin:32px;color:#111}
        h1{font-size:20px;margin:0 0 2px} .sub{color:#666;margin:0 0 18px}
        table{width:100%;border-collapse:collapse;margin:0 0 18px}
        th,td{padding:6px 8px;border-bottom:1px solid #ddd;text-align:left}
        td.n,th.n{text-align:right;font-variant-numeric:tabular-nums}
        .total td{font-weight:700;border-top:2px solid #999}
      </style></head><body>
      <h1>Category Report — ${escapeHtml(categoryLabel)}</h1>
      <p class="sub">${escapeHtml(accountLabel)} · ${escapeHtml(rangeText)}</p>
      <table>
        <thead><tr><th>Date</th><th>Payee</th><th>Memo</th><th>Account</th><th class="n">Amount</th></tr></thead>
        <tbody>${body || '<tr><td colspan="5">No matching transactions</td></tr>'}
          <tr class="total"><td>Total</td><td></td><td></td><td></td><td class="n">${formatCents(total, currency)}</td></tr>
        </tbody>
      </table>
      </body></html>`;
    void window.ledger.printLedger(html);
  }

  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <div className="dialog" style={{ width: "min(820px, 96vw)" }} onClick={(e) => e.stopPropagation()}>
        <div style={{ display: "flex", alignItems: "flex-start", gap: 12, flexWrap: "wrap" }}>
          <h3 style={{ margin: 0, alignSelf: "flex-start" }}>Category Report</h3>

          <div style={{ display: "flex", flexDirection: "column", gap: 8, minWidth: 200 }}>
            <div className="field" style={{ margin: 0 }}>
              <label>Category</label>
              <select value={categoryId} onChange={(e) => setCategoryId(e.target.value)}>
                <option value="">Select a category…</option>
                {catChoices.map((o) => (
                  <option key={o.category.id} value={o.category.id}>
                    {o.display}
                  </option>
                ))}
              </select>
            </div>

            <div className="field" style={{ margin: 0 }}>
              <label>Account</label>
              <select value={accountId} onChange={(e) => setAccountId(e.target.value)}>
                <option value="">All Accounts</option>
                {accounts.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <div className="field" style={{ margin: 0 }}>
              <label>From date</label>
              <input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} />
            </div>
            <div className="field" style={{ margin: 0 }}>
              <label>To date</label>
              <input type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} />
            </div>
          </div>

          <span style={{ flex: 1 }} />
          <div style={{ display: "flex", flexWrap: "nowrap", gap: 8, alignItems: "center" }}>
            <button
              className="secondary"
              onClick={printReport}
              disabled={!categoryId}
              title="Print…"
              aria-label="Print"
            >
              <svg
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                style={{ display: "block" }}
              >
                <polyline points="6 9 6 2 18 2 18 9" />
                <path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2" />
                <rect x="6" y="14" width="12" height="8" />
              </svg>
            </button>
            <button
              className="secondary"
              onClick={onClose}
              title="Close"
              aria-label="Close"
            >
              <svg
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                style={{ display: "block" }}
              >
                <line x1="18" y1="6" x2="6" y2="18" />
                <line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>
          </div>
        </div>

        <div style={{ maxHeight: "70vh", overflow: "auto", marginTop: 12 }}>
          <table className="holdings-table">
            <thead>
              <tr>
                <th>Date</th>
                <th>Payee</th>
                <th>Memo</th>
                <th>Account</th>
                <th className="num">Amount</th>
              </tr>
            </thead>
            <tbody>
              {!categoryId ? (
                <tr>
                  <td colSpan={5} className="account-type">
                    Select a category to view its transactions.
                  </td>
                </tr>
              ) : rows.length === 0 ? (
                <tr>
                  <td colSpan={5} className="account-type">
                    No matching transactions.
                  </td>
                </tr>
              ) : (
                rows.map((r) => (
                  <tr key={r.id}>
                    <td>{r.date}</td>
                    <td>{r.payee}</td>
                    <td>{r.memo}</td>
                    <td>{r.accountName}</td>
                    <td className="num">{formatCents(r.amountCents, currency)}</td>
                  </tr>
                ))
              )}
            </tbody>
            {categoryId && rows.length > 0 && (
              <tfoot>
                <tr>
                  <td>Total</td>
                  <td></td>
                  <td></td>
                  <td></td>
                  <td className="num">{formatCents(total, currency)}</td>
                </tr>
              </tfoot>
            )}
          </table>
        </div>
      </div>
    </div>
  );
}

/** Minimal HTML escape for the printable report. */
function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    c === "&" ? "&amp;" : c === "<" ? "&lt;" : c === ">" ? "&gt;" : c === '"' ? "&quot;" : "&#39;"
  );
}
