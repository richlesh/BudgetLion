import { useState } from "react";
import type { Account, InvestmentImportRow } from "../shared/types";
import { formatCents } from "../core/money";
import { parseInvestmentCsv } from "../core/import/investment";

interface Props {
  account: Account; // an investment account
  onCancel: () => void;
  onDone: (importedCount: number) => void;
}

type Stage = "pick" | "preview";

/**
 * Import an investment-history CSV (e.g. a 401k transaction download) into an
 * investment account. Rows become buy/sell trades via recordTrade; "Change in
 * Market Value" and other zero-share rows are skipped. Securities are matched or
 * created by name.
 */
export function InvestmentImportDialog({ account, onCancel, onDone }: Props) {
  const [stage, setStage] = useState<Stage>("pick");
  const [fileName, setFileName] = useState("");
  const [rows, setRows] = useState<InvestmentImportRow[]>([]);
  const [skippedMv, setSkippedMv] = useState(0);
  const [skippedUnknown, setSkippedUnknown] = useState<Array<{ date: string; type: string }>>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function pickFile() {
    setError(null);
    const opened = await window.ledger.openImportFile();
    if (!opened) return;
    setFileName(opened.fileName);
    const parsed = parseInvestmentCsv(opened.text, "us");
    if (!parsed.headerFound) {
      setError(
        "Couldn't find an investment header row (Date, Investment, Transaction Type, Amount, Shares/Unit)."
      );
      return;
    }
    if (parsed.rows.length === 0) {
      setError("No importable buy/sell rows were found in this file.");
      return;
    }
    setRows(parsed.rows);
    setSkippedMv(parsed.skippedMarketValue);
    setSkippedUnknown(parsed.skippedUnknown);
    setStage("preview");
  }

  async function commit() {
    setBusy(true);
    setError(null);
    try {
      const count = await window.ledger.commitInvestmentImport(account.id, rows);
      onDone(count);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  }

  return (
    <div className="dialog-backdrop" onClick={onCancel}>
      <div
        className="dialog"
        style={{ width: stage === "preview" ? 680 : 420 }}
        onClick={(e) => e.stopPropagation()}
      >
        <h3>Import investments into “{account.name}”</h3>
        <div className="account-type">
          {account.type} · {account.currency}
        </div>

        {stage === "pick" && (
          <>
            <p style={{ fontSize: 13, color: "var(--muted)" }}>
              Choose a CSV export of your investment transaction history (e.g. a 401k
              download with Date, Investment, Transaction Type, Amount, and Shares/Unit
              columns). Contributions and loan repayments become buys; withdrawals become
              sells. “Change in Market Value” rows are skipped.
            </p>
            <button onClick={pickFile}>Choose File…</button>
          </>
        )}

        {stage === "preview" && (
          <>
            <div className="account-type">
              {fileName} · {rows.length} trade(s)
              {skippedMv > 0 ? ` · ${skippedMv} market-value row(s) skipped` : ""}
              {skippedUnknown.length > 0
                ? ` · ${skippedUnknown.length} unrecognized type(s) skipped`
                : ""}
            </div>
            <div
              style={{
                maxHeight: 320,
                overflow: "auto",
                border: "1px solid var(--border)",
                borderRadius: 6,
              }}
            >
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
                <thead>
                  <tr>
                    <th style={thStyle}>Date</th>
                    <th style={thStyle}>Security</th>
                    <th style={thStyle}>Action</th>
                    <th style={{ ...thStyle, textAlign: "right" }}>Shares</th>
                    <th style={{ ...thStyle, textAlign: "right" }}>Price</th>
                    <th style={{ ...thStyle, textAlign: "right" }}>Amount</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.slice(0, 1000).map((r, i) => (
                    <tr key={i}>
                      <td style={tdStyle}>{r.date}</td>
                      <td style={tdStyle}>{r.securityName}</td>
                      <td style={tdStyle}>{r.action === "buy" ? "Buy" : "Sell"}</td>
                      <td style={{ ...tdStyle, textAlign: "right" }}>
                        {Number(r.units.toFixed(6)).toString()}
                      </td>
                      <td style={{ ...tdStyle, textAlign: "right" }}>
                        {formatCents(Math.round(r.pricePerUnitCents), account.currency)}
                      </td>
                      <td style={{ ...tdStyle, textAlign: "right" }}>
                        {formatCents(r.amountCents, account.currency)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {skippedUnknown.length > 0 && (
              <div style={{ fontSize: 12, color: "var(--muted)", marginTop: 6 }}>
                Skipped unrecognized types:{" "}
                {Array.from(new Set(skippedUnknown.map((s) => s.type))).join(", ")}
              </div>
            )}
          </>
        )}

        {error && <div className="error">{error}</div>}

        <div className="dialog-actions">
          <button className="secondary" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
          {stage === "preview" && (
            <button onClick={commit} disabled={busy}>
              {busy ? "Importing…" : `Import ${rows.length} trade(s)`}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

const thStyle: React.CSSProperties = {
  textAlign: "left",
  padding: "6px 8px",
  position: "sticky",
  top: 0,
  background: "var(--panel)",
  borderBottom: "1px solid var(--border)",
};
const tdStyle: React.CSSProperties = {
  padding: "4px 8px",
  borderBottom: "1px solid var(--border)",
};
