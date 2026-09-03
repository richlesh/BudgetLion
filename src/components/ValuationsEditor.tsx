import { useCallback, useEffect, useState } from "react";
import type { AssetValuation, SecurityHolding } from "../shared/types";
import { MICRO } from "../shared/types";
import { formatCents, parsePriceCents } from "../core/money";

interface Props {
  holding: SecurityHolding;
  currency: string;
  onClose: () => void;
  /** Called after any change so the caller can refresh holdings/history. */
  onChanged?: () => void;
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}
/** Per-share price (dollars string) from a valuation's micro-cents. */
function priceStr(valueMicros: number): string {
  return (valueMicros / 100 / MICRO).toString();
}

/**
 * Full CRUD editor for a single asset's stored valuations. Rows show the as-of
 * date, per-share price, and source. Double-click the date or price to edit;
 * the trash button deletes a row; the bottom row adds a new valuation.
 *
 * Valuations are keyed by (asset, date), so editing a row's DATE is done by
 * recording at the new date and deleting the old row.
 */
export function ValuationsEditor({ holding, currency, onClose, onChanged }: Props) {
  const assetId = holding.asset.id;
  const [rows, setRows] = useState<AssetValuation[]>([]);
  const [editing, setEditing] = useState<{ id: string; field: "date" | "price" } | null>(null);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  // New-row drafts.
  const [newDate, setNewDate] = useState(today());
  const [newPrice, setNewPrice] = useState("");

  const load = useCallback(async () => {
    const vs = await window.ledger.listValuations(assetId);
    vs.sort((a, b) => (a.asOfDate < b.asOfDate ? 1 : a.asOfDate > b.asOfDate ? -1 : 0)); // newest first
    setRows(vs);
  }, [assetId]);

  useEffect(() => {
    void load();
  }, [load]);

  const notify = useCallback(async () => {
    await load();
    onChanged?.();
  }, [load, onChanged]);

  function beginEdit(v: AssetValuation, field: "date" | "price") {
    setError(null);
    setEditing({ id: v.id, field });
    setDraft(field === "date" ? v.asOfDate : priceStr(v.valueMicros));
  }

  const commitEdit = useCallback(async () => {
    if (!editing) return;
    const row = rows.find((r) => r.id === editing.id);
    setEditing(null);
    if (!row) return;
    try {
      if (editing.field === "price") {
        const cents = parsePriceCents(draft);
        if (cents == null || cents < 0) return;
        await window.ledger.recordValuation({
          assetId,
          asOfDate: row.asOfDate,
          valueMicros: Math.round(cents * MICRO),
          source: row.source ?? "manual",
        });
      } else {
        const date = draft.trim();
        if (!date || date === row.asOfDate) return;
        // Move the value to the new date, then remove the old row.
        await window.ledger.recordValuation({
          assetId,
          asOfDate: date,
          valueMicros: row.valueMicros,
          source: row.source ?? "manual",
        });
        await window.ledger.deleteValuation(row.id);
      }
      await notify();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save the valuation.");
    }
  }, [editing, draft, rows, assetId, notify]);

  const remove = useCallback(
    async (id: string) => {
      try {
        await window.ledger.deleteValuation(id);
        await notify();
      } catch (e) {
        setError(e instanceof Error ? e.message : "Could not delete the valuation.");
      }
    },
    [notify]
  );

  const addRow = useCallback(async () => {
    setError(null);
    const cents = parsePriceCents(newPrice);
    if (!newDate) { setError("Choose a date."); return; }
    if (cents == null || cents < 0) { setError("Enter a valid price per share."); return; }
    try {
      await window.ledger.recordValuation({
        assetId,
        asOfDate: newDate,
        valueMicros: Math.round(cents * MICRO),
        source: "manual",
      });
      setNewPrice("");
      await notify();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not add the valuation.");
    }
  }, [newDate, newPrice, assetId, notify]);

  const title = holding.asset.symbol
    ? `${holding.asset.symbol} — ${holding.asset.name}`
    : holding.asset.name;

  return (
    <div className="dialog-backdrop dialog-backdrop-top" onClick={onClose}>
      <div className="dialog" style={{ width: "min(620px, 92vw)" }} onClick={(e) => e.stopPropagation()}>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <h3 style={{ margin: 0 }}>Valuations — {title}</h3>
          <span style={{ flex: 1 }} />
          <button className="secondary" onClick={onClose}>Close</button>
        </div>

        <div style={{ maxHeight: "60vh", overflow: "auto" }}>
          <table className="holdings-table">
            <thead>
              <tr>
                <th>Date</th>
                <th className="num">Price / Share</th>
                <th>Source</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 && (
                <tr><td colSpan={4} className="empty">No valuations yet.</td></tr>
              )}
              {rows.map((v) => (
                <tr key={v.id}>
                  <td>
                    {editing && editing.id === v.id && editing.field === "date" ? (
                      <input
                        type="date"
                        autoFocus
                        value={draft}
                        onChange={(e) => setDraft(e.target.value)}
                        onBlur={() => void commitEdit()}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") { e.preventDefault(); void commitEdit(); }
                          else if (e.key === "Escape") { e.preventDefault(); setEditing(null); }
                        }}
                      />
                    ) : (
                      <span title="Double-click to edit the date" onDoubleClick={() => beginEdit(v, "date")}>
                        {v.asOfDate}
                      </span>
                    )}
                  </td>
                  <td className="num">
                    {editing && editing.id === v.id && editing.field === "price" ? (
                      <input
                        className="holdings-edit"
                        autoFocus
                        value={draft}
                        placeholder="0.00"
                        style={{ width: 100, textAlign: "right" }}
                        onChange={(e) => setDraft(e.target.value)}
                        onBlur={() => void commitEdit()}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") { e.preventDefault(); void commitEdit(); }
                          else if (e.key === "Escape") { e.preventDefault(); setEditing(null); }
                        }}
                      />
                    ) : (
                      <span
                        title="Double-click to edit the price"
                        onDoubleClick={() => beginEdit(v, "price")}
                      >
                        {formatCents(Math.round(v.valueMicros / MICRO), currency)}
                      </span>
                    )}
                  </td>
                  <td className="account-type">{v.source ?? "manual"}</td>
                  <td className="num">
                    <button
                      className="secondary icon-btn"
                      title="Delete valuation"
                      aria-label="Delete valuation"
                      onClick={() => void remove(v.id)}
                    >
                      🗑
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <td>
                  <input type="date" value={newDate} onChange={(e) => setNewDate(e.target.value)} />
                </td>
                <td className="num">
                  <input
                    className="holdings-edit"
                    value={newPrice}
                    placeholder="0.00"
                    style={{ width: 100, textAlign: "right" }}
                    onChange={(e) => setNewPrice(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); void addRow(); } }}
                  />
                </td>
                <td className="account-type">manual</td>
                <td className="num">
                  <button className="secondary" onClick={() => void addRow()}>Add</button>
                </td>
              </tr>
            </tfoot>
          </table>
        </div>

        {error && <div className="error">{error}</div>}
      </div>
    </div>
  );
}
