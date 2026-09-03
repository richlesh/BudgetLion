import { useCallback, useEffect, useState } from "react";
import type { Account, SecurityHolding } from "../shared/types";
import { MICRO } from "../shared/types";
import { formatCents, parsePriceCents } from "../core/money";
import { ContextMenu, type ContextMenuItem } from "./ContextMenu";
import { HoldingHistoryPanel } from "./HoldingHistoryPanel";
import { ValuationsEditor } from "./ValuationsEditor";

interface Props {
  account: Account; // an investment account
  /** Bump this to force a reload (e.g. after a trade). */
  reloadKey?: number;
  /** Theme, for the history chart. */
  dark?: boolean;
}

/** Format micro-unit share counts as a trimmed decimal, e.g. 12_500_000 -> "12.5". */
function formatShares(sharesMicro: number): string {
  const shares = sharesMicro / MICRO;
  return Number(shares.toFixed(6)).toString();
}

/**
 * Holdings/positions panel for an investment account: one row per security with
 * shares, per-share price, and market value. Includes a
 * "Refresh prices" button that fetches quotes for symbols (opt-in via Settings)
 * and surfaces per-symbol results.
 */
export function HoldingsPanel({ account, reloadKey, dark = false }: Props) {
  const [holdings, setHoldings] = useState<SecurityHolding[]>([]);
  const [refreshing, setRefreshing] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  // Right-click context menu + the holding whose price history is being viewed.
  const [menu, setMenu] = useState<{ x: number; y: number; items: ContextMenuItem[] } | null>(null);
  const [historyFor, setHistoryFor] = useState<SecurityHolding | null>(null);
  const [valuationsFor, setValuationsFor] = useState<SecurityHolding | null>(null);
  // Inline edit state: which holding's field (symbol/name) is being edited, and
  // the current draft text.
  const [editing, setEditing] = useState<{ assetId: string; field: "symbol" | "name" } | null>(null);
  const [draft, setDraft] = useState("");
  // Price-entry state: which holding's per-share price is being set, plus the
  // as-of (closing) date and price drafts.
  const [pricing, setPricing] = useState<string | null>(null); // assetId
  const [priceDate, setPriceDate] = useState("");
  const [priceText, setPriceText] = useState("");
  // Symbol lookup (name → ticker) state, shown while editing a symbol.
  const [lookupResults, setLookupResults] = useState<{ symbol: string; name: string; exchange: string; type: string }[] | null>(null);
  const [lookingUp, setLookingUp] = useState(false);

  const load = useCallback(async () => {
    setHoldings(await window.ledger.getSecurityHoldings(account.id));
  }, [account.id]);

  useEffect(() => {
    void load();
  }, [load, reloadKey]);

  // Begin editing a holding's symbol or name (double-click).
  const beginEdit = useCallback(
    (assetId: string, field: "symbol" | "name", current: string | null) => {
      setEditing({ assetId, field });
      setDraft(current ?? "");
      setLookupResults(null);
    },
    []
  );

  // Search Yahoo for a ticker by name (the draft, or the holding's name if blank).
  const runLookup = useCallback(
    async (fallbackName: string) => {
      const q = (draft.trim() || fallbackName).trim();
      if (!q) return;
      setLookingUp(true);
      setLookupResults(null);
      try {
        const res = await window.ledger.lookupSecuritySymbol(q);
        if (!res.resolved) {
          setStatus(res.error ?? "Symbol lookup failed.");
          setLookupResults([]);
        } else {
          setLookupResults(res.results);
          if (res.results.length === 0) setStatus(`No matches for “${q}”.`);
        }
      } finally {
        setLookingUp(false);
      }
    },
    [draft]
  );

  // Apply a looked-up symbol to the asset being edited.
  const applySymbol = useCallback(
    async (assetId: string, symbol: string) => {
      setEditing(null);
      setLookupResults(null);
      try {
        await window.ledger.updateAsset({ id: assetId, symbol: symbol.toUpperCase() });
        await load();
      } catch (e) {
        setStatus(e instanceof Error ? e.message : "Could not set the symbol.");
      }
    },
    [load]
  );

  // Commit the inline edit: update the asset and reload. Symbol is uppercased and
  // stored null when blank; name is trimmed and left unchanged if blank.
  const commitEdit = useCallback(async () => {
    if (!editing) return;
    const { assetId, field } = editing;
    const text = draft.trim();
    setEditing(null);
    try {
      if (field === "symbol") {
        await window.ledger.updateAsset({ id: assetId, symbol: text ? text.toUpperCase() : null });
      } else {
        if (!text) return; // don't blank out a name
        await window.ledger.updateAsset({ id: assetId, name: text });
      }
      await load();
    } catch (e) {
      setStatus(e instanceof Error ? e.message : "Could not update the holding.");
    }
  }, [editing, draft, load]);

  // Begin entering a per-share price (double-click the Price cell): seed the date
  // with the last valuation's date (or today) and the price with the current one.
  const beginPrice = useCallback((h: SecurityHolding) => {
    setPricing(h.asset.id);
    const iso = new Date().toISOString().slice(0, 10);
    setPriceDate(h.latestValuation?.asOfDate ?? iso);
    setPriceText(
      h.latestValuation ? (h.latestValuation.valueMicros / MICRO / 100).toString() : ""
    );
  }, []);

  // Commit a manual per-share price for the chosen closing date. Stored as a
  // micro-cent per-unit valuation (source 'manual'); sub-cent precision preserved.
  const commitPrice = useCallback(async () => {
    if (!pricing) return;
    const assetId = pricing;
    const cents = parsePriceCents(priceText); // fractional cents, sub-cent preserved
    const date = priceDate;
    if (cents == null || cents < 0 || !date) {
      setPricing(null);
      return;
    }
    setPricing(null);
    try {
      await window.ledger.recordValuation({
        assetId,
        asOfDate: date,
        valueMicros: Math.round(cents * MICRO),
        source: "manual",
      });
      await load();
    } catch (e) {
      setStatus(e instanceof Error ? e.message : "Could not save the price.");
    }
  }, [pricing, priceText, priceDate, load]);

  const refresh = useCallback(async () => {
    setRefreshing(true);
    setStatus(null);
    try {
      const results = await window.ledger.refreshPrices(account.id);
      const resolved = results.filter((r) => r.resolved).length;
      const failed = results.length - resolved;
      if (results.length === 0) {
        setStatus("No securities with ticker symbols to price.");
      } else if (resolved === 0) {
        // Surface the first error (commonly the disabled-in-Settings message).
        const firstErr = results.find((r) => r.error)?.error;
        setStatus(firstErr ?? "No prices could be fetched.");
      } else {
        setStatus(
          `Updated ${resolved} price${resolved === 1 ? "" : "s"}` +
            (failed > 0 ? `; ${failed} could not be resolved (enter manually).` : ".")
        );
      }
      await load();
    } finally {
      setRefreshing(false);
    }
  }, [account.id, load]);

  const currency = account.currency;
  const totalMarket = holdings.reduce((s, h) => s + h.marketValueCents, 0);

  return (
    <div className="holdings-panel">
      <div className="holdings-head">
        <h3>Holdings</h3>
        <button className="secondary" onClick={refresh} disabled={refreshing}>
          {refreshing ? "Refreshing…" : "Refresh prices"}
        </button>
      </div>

      {holdings.length === 0 ? (
        <div className="empty">No holdings yet. Use New Transaction to buy a security.</div>
      ) : (
        <table className="holdings-table">
          <thead>
            <tr>
              <th>Symbol</th>
              <th>Security</th>
              <th className="num">Shares</th>
              <th className="num">Price</th>
              <th className="num">Market Value</th>
            </tr>
          </thead>
          <tbody>
            {holdings.map((h) => {
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
                        { label: "History…", onClick: () => setHistoryFor(h) },
                        { label: "Edit Valuations…", onClick: () => setValuationsFor(h) },
                      ],
                    });
                  }}
                >
                  {/* Symbol (ticker) — double-click to edit; blank to remove. */}
                  <td className="holdings-symbol">
                    {editing && editing.assetId === h.asset.id && editing.field === "symbol" ? (
                      <span className="holdings-symbol-edit">
                        <input
                          className="holdings-edit"
                          autoFocus
                          value={draft}
                          placeholder="Ticker (optional)"
                          onChange={(e) => setDraft(e.target.value)}
                          onBlur={() => void commitEdit()}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") { e.preventDefault(); void commitEdit(); }
                            else if (e.key === "Escape") { e.preventDefault(); setEditing(null); }
                          }}
                        />
                        <button
                          className="secondary"
                          title="Look up the ticker by the security's name"
                          // Prevent the input's blur (which would close the editor) before the click.
                          onMouseDown={(e) => e.preventDefault()}
                          onClick={() => void runLookup(h.asset.name)}
                        >
                          {lookingUp ? "…" : "Look up"}
                        </button>
                        {lookupResults && lookupResults.length > 0 && (
                          <ul className="holdings-lookup-list" onMouseDown={(e) => e.preventDefault()}>
                            {lookupResults.map((m) => (
                              <li key={m.symbol}>
                                <button
                                  className="holdings-lookup-item"
                                  onClick={() => void applySymbol(h.asset.id, m.symbol)}
                                  title={`${m.name} (${m.exchange})`}
                                >
                                  <strong>{m.symbol}</strong> {m.name}
                                  {m.type ? <span className="holdings-lookup-type"> {m.type}</span> : null}
                                </button>
                              </li>
                            ))}
                          </ul>
                        )}
                      </span>
                    ) : h.asset.symbol ? (
                      <strong
                        title="Double-click to edit the ticker symbol"
                        onDoubleClick={() => beginEdit(h.asset.id, "symbol", h.asset.symbol)}
                      >
                        {h.asset.symbol}
                      </strong>
                    ) : (
                      <strong
                        className="holdings-add-ticker"
                        title="Double-click to add a ticker symbol"
                        onDoubleClick={() => beginEdit(h.asset.id, "symbol", null)}
                      >
                        + ticker
                      </strong>
                    )}
                  </td>
                  {/* Security (description) — double-click to edit. */}
                  <td>
                    {editing && editing.assetId === h.asset.id && editing.field === "name" ? (
                      <input
                        className="holdings-edit"
                        autoFocus
                        value={draft}
                        placeholder="Description"
                        onChange={(e) => setDraft(e.target.value)}
                        onBlur={() => void commitEdit()}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") { e.preventDefault(); void commitEdit(); }
                          else if (e.key === "Escape") { e.preventDefault(); setEditing(null); }
                        }}
                      />
                    ) : (
                      <span
                        title="Double-click to edit the description"
                        onDoubleClick={() => beginEdit(h.asset.id, "name", h.asset.name)}
                      >
                        {h.asset.name}
                      </span>
                    )}
                  </td>
                  <td className="num">{formatShares(h.sharesMicro)}</td>
                  {/* Price (per share) — double-click to enter a closing date + price. */}
                  <td className="num holdings-price">
                    {pricing === h.asset.id ? (
                      <span className="holdings-price-edit">
                        <input
                          type="date"
                          value={priceDate}
                          onChange={(e) => setPriceDate(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") { e.preventDefault(); void commitPrice(); }
                            else if (e.key === "Escape") { e.preventDefault(); setPricing(null); }
                          }}
                        />
                        <input
                          className="holdings-edit"
                          autoFocus
                          value={priceText}
                          placeholder="0.00"
                          style={{ width: 80, textAlign: "right" }}
                          onChange={(e) => setPriceText(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") { e.preventDefault(); void commitPrice(); }
                            else if (e.key === "Escape") { e.preventDefault(); setPricing(null); }
                          }}
                        />
                        <button className="secondary icon-btn" title="Save price" onClick={() => void commitPrice()}>✓</button>
                      </span>
                    ) : (
                      <span
                        title={
                          h.latestValuation
                            ? `Priced ${h.latestValuation.asOfDate} — double-click to update`
                            : "Double-click to enter a closing date and price"
                        }
                        onDoubleClick={() => beginPrice(h)}
                      >
                        {priced ? formatCents(Math.round(h.latestValuation!.valueMicros / MICRO), currency) : "—"}
                      </span>
                    )}
                  </td>
                  <td className="num">
                    {priced ? formatCents(h.marketValueCents, currency) : "—"}
                  </td>
                </tr>
              );
            })}
          </tbody>
          <tfoot>
            <tr>
              <td>Total</td>
              <td></td>
              <td className="num"></td>
              <td className="num"></td>
              <td className="num">{formatCents(totalMarket, currency)}</td>
            </tr>
          </tfoot>
        </table>
      )}

      {status && <div className="holdings-status">{status}</div>}

      {menu && (
        <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />
      )}
      {historyFor && (
        <HoldingHistoryPanel
          holding={historyFor}
          currency={currency}
          dark={dark}
          onClose={() => setHistoryFor(null)}
        />
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
