import { useCallback, useEffect, useState } from "react";
import type { Account, SecurityHolding } from "../shared/types";
import { MICRO } from "../shared/types";
import { formatCents } from "../core/money";

interface Props {
  account: Account; // an investment account
  /** Bump this to force a reload (e.g. after a trade). */
  reloadKey?: number;
}

/** Format micro-unit share counts as a trimmed decimal, e.g. 12_500_000 -> "12.5". */
function formatShares(sharesMicro: number): string {
  const shares = sharesMicro / MICRO;
  return Number(shares.toFixed(6)).toString();
}

/**
 * Holdings/positions panel for an investment account: one row per security with
 * shares, cost basis, market value, and unrealized gain/loss. Includes a
 * "Refresh prices" button that fetches quotes for symbols (opt-in via Settings)
 * and surfaces per-symbol results.
 */
export function HoldingsPanel({ account, reloadKey }: Props) {
  const [holdings, setHoldings] = useState<SecurityHolding[]>([]);
  const [refreshing, setRefreshing] = useState(false);
  const [status, setStatus] = useState<string | null>(null);

  const load = useCallback(async () => {
    setHoldings(await window.ledger.getSecurityHoldings(account.id));
  }, [account.id]);

  useEffect(() => {
    void load();
  }, [load, reloadKey]);

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
  const totalCost = holdings.reduce((s, h) => s + h.costBasisCents, 0);
  const totalGain = totalMarket - totalCost;

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
              <th>Security</th>
              <th className="num">Shares</th>
              <th className="num">Cost Basis</th>
              <th className="num">Market Value</th>
              <th className="num">Gain / Loss</th>
            </tr>
          </thead>
          <tbody>
            {holdings.map((h) => {
              const gain = h.marketValueCents - h.costBasisCents;
              const priced = h.latestValuation != null;
              return (
                <tr key={h.asset.id}>
                  <td>
                    {h.asset.symbol ? (
                      <span>
                        <strong>{h.asset.symbol}</strong> {h.asset.name}
                      </span>
                    ) : (
                      h.asset.name
                    )}
                  </td>
                  <td className="num">{formatShares(h.sharesMicro)}</td>
                  <td className="num">{formatCents(h.costBasisCents, currency)}</td>
                  <td className="num">
                    {priced ? formatCents(h.marketValueCents, currency) : "—"}
                  </td>
                  <td className={"num " + (gain < 0 ? "amount-neg" : "amount-pos")}>
                    {priced ? formatCents(gain, currency) : "—"}
                  </td>
                </tr>
              );
            })}
          </tbody>
          <tfoot>
            <tr>
              <td>Total</td>
              <td className="num"></td>
              <td className="num">{formatCents(totalCost, currency)}</td>
              <td className="num">{formatCents(totalMarket, currency)}</td>
              <td className={"num " + (totalGain < 0 ? "amount-neg" : "amount-pos")}>
                {formatCents(totalGain, currency)}
              </td>
            </tr>
          </tfoot>
        </table>
      )}

      {status && <div className="holdings-status">{status}</div>}
    </div>
  );
}
