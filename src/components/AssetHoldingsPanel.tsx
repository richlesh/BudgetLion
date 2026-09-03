import { useCallback, useEffect, useState } from "react";
import type { Account, AssetHolding, SecurityHolding } from "../shared/types";
import { formatCents } from "../core/money";
import { parseAssetMeta } from "../core/assetRecord";
import { ContextMenu, type ContextMenuItem } from "./ContextMenu";
import { HoldingHistoryPanel } from "./HoldingHistoryPanel";
import { ValuationsEditor } from "./ValuationsEditor";

interface Props {
  account: Account; // an asset account
  /** Bump to force a reload (after buy/sell/lost or valuation edits). */
  reloadKey?: number;
  dark?: boolean;
}

/**
 * Adapt an AssetHolding (asset + latest valuation + value) into the
 * SecurityHolding shape the History/Valuations dialogs accept. A physical asset
 * has quantity 1 (quantityMicro), no lots.
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
 * Holdings view for an ASSET account: one row per owned item (property, vehicle,
 * collectible, …) with Description, Model, Serial, and Market Value (from the
 * item's latest valuation). Right-click a row for price History or to Edit
 * Valuations.
 */
export function AssetHoldingsPanel({ account, reloadKey, dark = false }: Props) {
  const [holdings, setHoldings] = useState<AssetHolding[]>([]);
  const [menu, setMenu] = useState<{ x: number; y: number; items: ContextMenuItem[] } | null>(null);
  const [historyFor, setHistoryFor] = useState<SecurityHolding | null>(null);
  const [valuationsFor, setValuationsFor] = useState<SecurityHolding | null>(null);

  const load = useCallback(async () => {
    setHoldings(await window.ledger.getHoldings(account.id));
  }, [account.id]);

  useEffect(() => {
    void load();
  }, [load, reloadKey]);

  const currency = account.currency;
  const total = holdings.reduce((s, h) => s + h.valueCents, 0);

  return (
    <div className="holdings-panel">
      <div className="holdings-head">
        <h3>Assets</h3>
      </div>

      {holdings.length === 0 ? (
        <div className="empty">No items yet. Use “New Asset Record” to add one.</div>
      ) : (
        <table className="holdings-table">
          <thead>
            <tr>
              <th>Description</th>
              <th>Model</th>
              <th>Serial</th>
              <th className="num">Market Value</th>
            </tr>
          </thead>
          <tbody>
            {holdings.map((h) => {
              const meta = parseAssetMeta(h.asset.metadata);
              const priced = h.latestValuation != null;
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
                  <td>{h.asset.name}</td>
                  <td>{meta.model || "—"}</td>
                  <td>{meta.serial || "—"}</td>
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
