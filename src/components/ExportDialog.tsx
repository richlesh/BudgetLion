import { useMemo, useState } from "react";
import type { Account, Category, ExportFormat, LedgerRow } from "../shared/types";
import { ledgerToCsv, ledgerToQif } from "../core/export/ledger";
import { ledgerToHtml } from "../core/export/html";

interface Props {
  account: Account;
  rows: LedgerRow[];
  categories: Category[];
  accounts: Account[];
  printFont?: { font?: string; sizePx?: number };
  onCancel: () => void;
  onDone: (message: string) => void;
}

const FORMATS: { value: ExportFormat; label: string; note: string }[] = [
  { value: "csv", label: "CSV", note: "Comma-separated, opens in Excel/Numbers" },
  { value: "qif", label: "QIF", note: "Quicken Interchange Format" },
  { value: "pdf", label: "PDF", note: "Printable ledger document" },
];

function safeName(account: Account): string {
  return account.name.replace(/[^a-z0-9\-_ ]/gi, "_") + "-ledger";
}

export function ExportDialog({ account, rows, categories, accounts, printFont, onCancel, onDone }: Props) {
  const [format, setFormat] = useState<ExportFormat>("csv");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Date bounds of the account's transactions, used to default the range so the
  // whole ledger exports unless the user narrows it.
  const txDates = useMemo(
    () =>
      rows
        .filter((r) => r.kind === "transaction" && r.transaction)
        .map((r) => r.transaction!.date)
        .sort(),
    [rows]
  );
  const [fromDate, setFromDate] = useState(txDates[0] ?? "");
  const [toDate, setToDate] = useState(txDates[txDates.length - 1] ?? "");

  // Rows within the selected date range (inclusive). Empty bound = unbounded.
  // Running balances are left as computed over the full history, so the Balance
  // column stays accurate for a date-range statement.
  const filteredRows = useMemo(
    () =>
      rows.filter((r) => {
        if (r.kind !== "transaction" || !r.transaction) return false;
        const d = r.transaction.date;
        if (fromDate && d < fromDate) return false;
        if (toDate && d > toDate) return false;
        return true;
      }),
    [rows, fromDate, toDate]
  );

  const txCount = filteredRows.length;
  const rangeInvalid = !!fromDate && !!toDate && fromDate > toDate;

  async function doExport() {
    setBusy(true);
    setError(null);
    try {
      let ok = false;
      const name = safeName(account);
      if (format === "csv") {
        ok = await window.ledger.saveTextFile(
          name,
          ledgerToCsv(account, filteredRows, categories, accounts),
          "csv"
        );
      } else if (format === "qif") {
        ok = await window.ledger.saveTextFile(
          name,
          ledgerToQif(account, filteredRows, categories, accounts),
          "qif"
        );
      } else if (format === "pdf") {
        ok = await window.ledger.exportPdf(
          name,
          ledgerToHtml(account, filteredRows, categories, printFont)
        );
      }
      if (ok) onDone(`Exported ${account.name} as ${format.toUpperCase()}.`);
      else setBusy(false); // user cancelled the save dialog
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  }

  return (
    <div className="dialog-backdrop" onClick={onCancel}>
      <div className="dialog" onClick={(e) => e.stopPropagation()}>
        <h3>Export “{account.name}”</h3>
        <div className="account-type">
          {account.type.replace("_", " ")} · {account.currency} · {txCount} transaction(s)
        </div>

        <div style={{ display: "flex", gap: 8 }}>
          <div className="field" style={{ flex: 1 }}>
            <label>From date</label>
            <input type="date" value={fromDate} onChange={(e) => setFromDate(e.target.value)} />
          </div>
          <div className="field" style={{ flex: 1 }}>
            <label>To date</label>
            <input type="date" value={toDate} onChange={(e) => setToDate(e.target.value)} />
          </div>
        </div>
        {rangeInvalid && <div className="error">From date must be on or before To date.</div>}

        <div className="field">
          <label>Format</label>
          {FORMATS.map((f) => (
            <label
              key={f.value}
              style={{ display: "flex", gap: 8, alignItems: "center", padding: "4px 0", fontSize: 14 }}
            >
              <input
                type="radio"
                name="fmt"
                checked={format === f.value}
                onChange={() => setFormat(f.value)}
                style={{ width: "auto" }}
              />
              <span>
                <strong>{f.label}</strong>
                <span style={{ color: "var(--muted)", marginLeft: 8, fontSize: 12 }}>{f.note}</span>
              </span>
            </label>
          ))}
        </div>

        {error && <div className="error">{error}</div>}

        <div className="dialog-actions">
          <button className="secondary" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
          <button onClick={doExport} disabled={busy || txCount === 0 || rangeInvalid}>
            {busy ? "Exporting…" : "Export…"}
          </button>
        </div>
      </div>
    </div>
  );
}
