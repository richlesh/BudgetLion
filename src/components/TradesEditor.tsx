import { useCallback, useEffect, useState } from "react";
import type { InvestmentTransaction, SecurityHolding } from "../shared/types";
import { MICRO } from "../shared/types";

interface Props {
  holding: SecurityHolding;
  onClose: () => void;
  /** Called after any change so the caller can refresh holdings/history. */
  onChanged?: () => void;
}

/** Human-readable label for a lot's action. */
const ACTION_LABELS: Record<InvestmentTransaction["action"], string> = {
  buy: "Buy",
  sell: "Sell",
  div: "Dividend",
  reinvest: "Reinvest",
  grant: "Grant",
  add: "Add shares",
};

/** Format micro-unit share counts as a trimmed decimal, e.g. 12_500_000 -> "12.5". */
function formatShares(quantityMicro: number): string {
  const shares = quantityMicro / MICRO;
  return Number(shares.toFixed(6)).toString();
}

/**
 * Editor for a single security's share-moving transactions (buy/sell/reinvest/
 * grant/add). Rows show the date, action, per-transaction shares, and the
 * running total shares held after each transaction (chronological). Double-click
 * the Shares cell to edit the share count; committing recomputes the linked cash
 * (and income) legs so shares and cash stay consistent. Cash dividends carry no
 * shares, so they are not shown.
 */
export function TradesEditor({ holding, onClose, onChanged }: Props) {
  const assetId = holding.asset.id;
  const [rows, setRows] = useState<InvestmentTransaction[]>([]);
  const [editing, setEditing] = useState<string | null>(null); // lot id
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const txns = await window.ledger.investmentTxnsForAsset(assetId);
    // Only share-moving lots have shares to edit; a cash 'div' does not.
    setRows(txns.filter((t) => t.action !== "div"));
  }, [assetId]);

  useEffect(() => {
    void load();
  }, [load]);

  const notify = useCallback(async () => {
    await load();
    onChanged?.();
  }, [load, onChanged]);

  function beginEdit(t: InvestmentTransaction) {
    setError(null);
    setEditing(t.id);
    setDraft(formatShares(Math.abs(t.quantityMicro)));
  }

  const commitEdit = useCallback(async () => {
    if (!editing) return;
    const row = rows.find((r) => r.id === editing);
    setEditing(null);
    if (!row) return;
    const units = Number(draft.trim());
    if (!Number.isFinite(units) || units <= 0) {
      setError("Enter a positive number of shares.");
      return;
    }
    // No change — nothing to do.
    if (Math.round(Math.abs(units) * MICRO) === Math.abs(row.quantityMicro)) return;
    try {
      await window.ledger.updateTradeShares(row.id, units);
      await notify();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not update the shares.");
    }
  }, [editing, draft, rows, notify]);

  const title = holding.asset.symbol
    ? `${holding.asset.symbol} — ${holding.asset.name}`
    : holding.asset.name;

  // Running total shares held after each transaction (rows are chronological).
  // Uses the signed quantity so a Sell reduces the total.
  let runningMicro = 0;

  return (
    <div className="dialog-backdrop dialog-backdrop-top" onClick={onClose}>
      <div className="dialog" style={{ width: "min(680px, 92vw)" }} onClick={(e) => e.stopPropagation()}>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <h3 style={{ margin: 0 }}>Transactions — {title}</h3>
          <span style={{ flex: 1 }} />
          <button className="secondary" onClick={onClose}>Close</button>
        </div>

        <div style={{ maxHeight: "60vh", overflow: "auto" }}>
          <table className="holdings-table">
            <thead>
              <tr>
                <th>Date</th>
                <th>Action</th>
                <th className="num">Shares</th>
                <th className="num">Total Shares</th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 && (
                <tr><td colSpan={4} className="empty">No share transactions yet.</td></tr>
              )}
              {rows.map((t) => {
                runningMicro += t.quantityMicro;
                const totalMicro = runningMicro;
                return (
                <tr key={t.id}>
                  <td>{t.date}</td>
                  <td>{ACTION_LABELS[t.action]}</td>
                  {/* Shares — double-click to edit the share count. */}
                  <td className="num">
                    {editing === t.id ? (
                      <input
                        className="holdings-edit"
                        autoFocus
                        value={draft}
                        placeholder="0"
                        style={{ width: 90, textAlign: "right" }}
                        onChange={(e) => setDraft(e.target.value)}
                        onBlur={() => void commitEdit()}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") { e.preventDefault(); void commitEdit(); }
                          else if (e.key === "Escape") { e.preventDefault(); setEditing(null); }
                        }}
                      />
                    ) : (
                      <span
                        title="Double-click to edit the number of shares"
                        onDoubleClick={() => beginEdit(t)}
                      >
                        {formatShares(Math.abs(t.quantityMicro))}
                      </span>
                    )}
                  </td>
                  <td className="num">{formatShares(totalMicro)}</td>
                </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        {error && <div className="error">{error}</div>}
      </div>
    </div>
  );
}
