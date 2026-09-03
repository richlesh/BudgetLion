import { useCallback, useEffect, useState } from "react";
import type { Account, AssetHolding, SecurityHolding } from "../shared/types";
import { MICRO } from "../shared/types";
import { formatCents, parsePriceCents } from "../core/money";
import { parseAssetMeta, mergeAssetMeta } from "../core/assetRecord";
import { ContextMenu, type ContextMenuItem } from "./ContextMenu";
import { HoldingHistoryPanel } from "./HoldingHistoryPanel";
import { ValuationsEditor } from "./ValuationsEditor";

interface Props {
  account: Account; // an asset account
  /** Bump to force a reload (after buy/sell/lost or valuation edits). */
  reloadKey?: number;
  dark?: boolean;
}

/** Which field of a row is being inline-edited. */
type EditField = "name" | "model" | "serial" | "price" | "date";

/**
 * Adapt an AssetHolding into the SecurityHolding shape the History/Valuations
 * dialogs accept. A physical asset has quantity 1 (quantityMicro), no lots.
 */
function asSecurityHolding(h: AssetHolding): SecurityHolding {
  return {
    asset: h.asset,
    sharesMicro: h.asset.quantityMicro,
    latestValuation: h.latestValuation,
    marketValueCents: h.valueCents,
  };
}

/**
 * Holdings view for an ASSET account: one row per owned item with Description,
 * Model, Serial, Purchase Price, and Market Value. Double-click Description/
 * Model/Serial to edit; right-click a row for price History or Edit Valuations.
 */
export function AssetHoldingsPanel({ account, reloadKey, dark = false }: Props) {
  const [holdings, setHoldings] = useState<AssetHolding[]>([]);
  const [menu, setMenu] = useState<{ x: number; y: number; items: ContextMenuItem[] } | null>(null);
  const [historyFor, setHistoryFor] = useState<SecurityHolding | null>(null);
  const [valuationsFor, setValuationsFor] = useState<SecurityHolding | null>(null);
  const [editing, setEditing] = useState<{ assetId: string; field: EditField } | null>(null);
  const [draft, setDraft] = useState("");

  const load = useCallback(async () => {
    setHoldings(await window.ledger.getHoldings(account.id));
  }, [account.id]);

  useEffect(() => {
    void load();
  }, [load, reloadKey]);

  const beginEdit = useCallback((assetId: string, field: EditField, current: string) => {
    setEditing({ assetId, field });
    setDraft(current);
  }, []);

  // Commit an inline edit: Description -> asset.name; Model/Serial -> metadata;
  // Purchase Price -> metadata.purchasePriceCents AND the valuation on the
  // purchase date (so market value tracks the corrected purchase price).
  const commitEdit = useCallback(async () => {
    if (!editing) return;
    const { assetId, field } = editing;
    const text = draft.trim();
    setEditing(null);
    const h = holdings.find((x) => x.asset.id === assetId);
    if (!h) return;
    try {
      if (field === "name") {
        if (!text) return; // don't blank a description
        await window.ledger.updateAsset({ id: assetId, name: text });
      } else if (field === "price") {
        const cents = parsePriceCents(text);
        if (cents == null || cents < 0) return;
        const rounded = Math.round(cents);
        const meta = parseAssetMeta(h.asset.metadata);
        const asOfDate = meta.purchaseDate ?? new Date().toISOString().slice(0, 10);
        await window.ledger.updateAsset({
          id: assetId,
          metadata: mergeAssetMeta(h.asset.metadata, { purchasePriceCents: rounded, purchaseDate: asOfDate }),
        });
        await window.ledger.recordValuation({
          assetId,
          asOfDate,
          valueMicros: Math.round(cents * MICRO),
          source: "purchase",
        });
      } else if (field === "date") {
        const newDate = text;
        if (!newDate) return;
        const meta = parseAssetMeta(h.asset.metadata);
        const oldDate = meta.purchaseDate ?? null;
        await window.ledger.updateAsset({
          id: assetId,
          metadata: mergeAssetMeta(h.asset.metadata, { purchaseDate: newDate }),
        });
        // Move the purchase valuation to the new date (record new, remove old).
        if (meta.purchasePriceCents != null && newDate !== oldDate) {
          await window.ledger.recordValuation({
            assetId,
            asOfDate: newDate,
            valueMicros: meta.purchasePriceCents * MICRO,
            source: "purchase",
          });
          if (oldDate) {
            const olds = (await window.ledger.listValuations(assetId)).filter(
              (v) => v.deletedAt == null && v.asOfDate === oldDate && v.source === "purchase"
            );
            for (const v of olds) await window.ledger.deleteValuation(v.id);
          }
        }
      } else {
        const metadata = mergeAssetMeta(h.asset.metadata, { [field]: text || null });
        await window.ledger.updateAsset({ id: assetId, metadata });
      }
      await load();
    } catch {
      // ignore; a reload keeps the view consistent
      await load();
    }
  }, [editing, draft, holdings, load]);

  const currency = account.currency;
  const total = holdings.reduce((s, h) => s + h.valueCents, 0);

  // A double-clickable text cell (Description/Model/Serial) with inline edit.
  function editableCell(h: AssetHolding, field: EditField, value: string, placeholder: string) {
    const isEditing = editing?.assetId === h.asset.id && editing.field === field;
    if (isEditing) {
      return (
        <input
          className="holdings-edit"
          autoFocus
          value={draft}
          placeholder={placeholder}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => void commitEdit()}
          onKeyDown={(e) => {
            if (e.key === "Enter") { e.preventDefault(); void commitEdit(); }
            else if (e.key === "Escape") { e.preventDefault(); setEditing(null); }
          }}
        />
      );
    }
    return (
      <span title={`Double-click to edit the ${placeholder.toLowerCase()}`} onDoubleClick={() => beginEdit(h.asset.id, field, value)}>
        {value || "—"}
      </span>
    );
  }

  return (
    <div className="holdings-panel">
      <div className="holdings-head">
        <h3>Assets</h3>
      </div>

      {holdings.length === 0 ? (
        <div className="empty">No items yet. Use “New Asset” to add one.</div>
      ) : (
        <table className="holdings-table">
          <thead>
            <tr>
              <th>Description</th>
              <th>Model</th>
              <th>Serial</th>
              <th>Purchased</th>
              <th className="num">Purchase Price</th>
              <th className="num">Market Value</th>
            </tr>
          </thead>
          <tbody>
            {holdings.map((h) => {
              const meta = parseAssetMeta(h.asset.metadata);
              const priced = h.latestValuation != null;
              const purchase = meta.purchasePriceCents;
              return (
                <tr
                  key={h.asset.id}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    setMenu({
                      x: e.clientX,
                      y: e.clientY,
                      items: [
                        { label: "History…", onClick: () => setHistoryFor(asSecurityHolding(h)) },
                        { label: "Edit Valuations…", onClick: () => setValuationsFor(asSecurityHolding(h)) },
                      ],
                    });
                  }}
                >
                  <td>{editableCell(h, "name", h.asset.name, "Description")}</td>
                  <td>{editableCell(h, "model", meta.model || "", "Model")}</td>
                  <td>{editableCell(h, "serial", meta.serial || "", "Serial")}</td>
                  <td>
                    {editing?.assetId === h.asset.id && editing.field === "date" ? (
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
                      <span
                        title="Double-click to edit the purchase date"
                        onDoubleClick={() => beginEdit(h.asset.id, "date", meta.purchaseDate || "")}
                      >
                        {meta.purchaseDate || "—"}
                      </span>
                    )}
                  </td>
                  <td className="num">
                    {editing?.assetId === h.asset.id && editing.field === "price" ? (
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
                        title="Double-click to edit the purchase price"
                        onDoubleClick={() =>
                          beginEdit(h.asset.id, "price", purchase != null ? (purchase / 100).toString() : "")
                        }
                      >
                        {purchase != null ? formatCents(purchase, currency) : "—"}
                      </span>
                    )}
                  </td>
                  <td className="num">{priced ? formatCents(h.valueCents, currency) : "—"}</td>
                </tr>
              );
            })}
          </tbody>
          <tfoot>
            <tr>
              <td>Total</td>
              <td></td>
              <td></td>
              <td></td>
              <td className="num"></td>
              <td className="num">{formatCents(total, currency)}</td>
            </tr>
          </tfoot>
        </table>
      )}

      {menu && <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />}
      {historyFor && (
        <HoldingHistoryPanel holding={historyFor} currency={currency} dark={dark} valueOnly onClose={() => setHistoryFor(null)} />
      )}
      {valuationsFor && (
        <ValuationsEditor
          holding={valuationsFor}
          currency={currency}
          onClose={() => setValuationsFor(null)}
          onChanged={() => void load()}
        />
      )}
    </div>
  );
}
