import { useEffect, useMemo, useState } from "react";
import type { Account, AccountWorth } from "../shared/types";
import { formatCents } from "../core/money";

interface Props {
  onClose: () => void;
}

/** Liability account types (their worth reduces net worth). */
function isLiabilityType(t: Account["type"]): boolean {
  return t === "credit_card" || t === "loan";
}

interface Line {
  name: string;
  type: Account["type"];
  cents: number; // signed net contribution (assets +, liabilities -)
}

/**
 * One-page Net Worth summary: assets (checking/savings/investment/asset) less
 * liabilities (credit card/loan), with subtotals and total net worth. Reads
 * per-account worth (cash + holdings) from getAllWorth. Printable.
 */
export function NetWorthReport({ onClose }: Props) {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [worth, setWorth] = useState<AccountWorth[]>([]);

  useEffect(() => {
    void Promise.all([window.ledger.listAccounts(), window.ledger.getAllWorth()]).then(
      ([a, w]) => {
        setAccounts(a);
        setWorth(w);
      }
    );
  }, []);

  const { assets, liabilities, assetTotal, liabilityTotal, netWorth, asOf } = useMemo(() => {
    const worthById = new Map(worth.map((w) => [w.accountId, w.worthCents]));
    const assetsL: Line[] = [];
    const liabsL: Line[] = [];
    for (const a of accounts) {
      const raw = worthById.get(a.id) ?? 0;
      if (isLiabilityType(a.type)) {
        // A liability's stored worth is negative (a debt); show the magnitude.
        liabsL.push({ name: a.name, type: a.type, cents: Math.abs(raw) });
      } else {
        assetsL.push({ name: a.name, type: a.type, cents: raw });
      }
    }
    // Sort each group by account type, then by account name (case-insensitive).
    const byTypeThenName = (x: Line, y: Line) =>
      x.type !== y.type ? x.type.localeCompare(y.type) : x.name.localeCompare(y.name, undefined, { sensitivity: "base" });
    assetsL.sort(byTypeThenName);
    liabsL.sort(byTypeThenName);
    const at = assetsL.reduce((s, l) => s + l.cents, 0);
    const lt = liabsL.reduce((s, l) => s + l.cents, 0);
    return {
      assets: assetsL,
      liabilities: liabsL,
      assetTotal: at,
      liabilityTotal: lt,
      netWorth: at - lt,
      asOf: new Date().toISOString().slice(0, 10),
    };
  }, [accounts, worth]);

  const currency = accounts[0]?.currency ?? "USD";
  const typeLabel = (t: Account["type"]) => t.replace("_", " ");

  function printReport() {
    const row = (l: Line, sign = 1) =>
      `<tr><td>${escapeHtml(l.name)}</td><td class="t">${typeLabel(l.type)}</td>` +
      `<td class="n">${formatCents(l.cents * sign, currency)}</td></tr>`;
    const html = `<!doctype html><html><head><meta charset="utf-8"><title>Net Worth Report</title>
      <style>
        body{font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;margin:32px;color:#111}
        h1{font-size:20px;margin:0 0 2px} .sub{color:#666;margin:0 0 18px}
        table{width:100%;border-collapse:collapse;margin:0 0 18px}
        th,td{padding:6px 8px;border-bottom:1px solid #ddd;text-align:left}
        td.n,th.n{text-align:right;font-variant-numeric:tabular-nums}
        td.t,th.t{color:#666;text-transform:capitalize}
        .section{font-size:14px;font-weight:700;margin:10px 0 4px}
        .subtotal td{font-weight:700;border-top:2px solid #999}
        .net{font-size:18px;font-weight:800;margin-top:8px}
      </style></head><body>
      <h1>Net Worth Report</h1>
      <p class="sub">As of ${asOf}</p>
      <div class="section">Assets</div>
      <table><thead><tr><th>Account</th><th class="t">Type</th><th class="n">Value</th></tr></thead>
        <tbody>${assets.map((l) => row(l)).join("")}
        <tr class="subtotal"><td>Total Assets</td><td></td><td class="n">${formatCents(assetTotal, currency)}</td></tr>
        </tbody></table>
      <div class="section">Liabilities</div>
      <table><thead><tr><th>Account</th><th class="t">Type</th><th class="n">Balance</th></tr></thead>
        <tbody>${liabilities.map((l) => row(l)).join("") || '<tr><td colspan="3">None</td></tr>'}
        <tr class="subtotal"><td>Total Liabilities</td><td></td><td class="n">${formatCents(liabilityTotal, currency)}</td></tr>
        </tbody></table>
      <div class="net">Net Worth: ${formatCents(netWorth, currency)}</div>
      </body></html>`;
    void window.ledger.printLedger(html);
  }

  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <div className="dialog" style={{ width: "min(680px, 94vw)" }} onClick={(e) => e.stopPropagation()}>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <h3 style={{ margin: 0 }}>Net Worth Report</h3>
          <span className="account-type">As of {asOf}</span>
          <span style={{ flex: 1 }} />
          <button className="secondary" onClick={printReport}>Print…</button>
          <button className="secondary" onClick={onClose}>Close</button>
        </div>

        <div style={{ maxHeight: "70vh", overflow: "auto" }}>
          <div className="nwr-section">Assets</div>
          <table className="holdings-table">
            <thead>
              <tr><th>Account</th><th>Type</th><th className="num">Value</th></tr>
            </thead>
            <tbody>
              {assets.map((l) => (
                <tr key={l.name + l.type}>
                  <td>{l.name}</td>
                  <td className="account-type">{typeLabel(l.type)}</td>
                  <td className="num">{formatCents(l.cents, currency)}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr><td>Total Assets</td><td></td><td className="num">{formatCents(assetTotal, currency)}</td></tr>
            </tfoot>
          </table>

          <div className="nwr-section">Liabilities</div>
          <table className="holdings-table">
            <thead>
              <tr><th>Account</th><th>Type</th><th className="num">Balance</th></tr>
            </thead>
            <tbody>
              {liabilities.length === 0 ? (
                <tr><td colSpan={3} className="account-type">None</td></tr>
              ) : (
                liabilities.map((l) => (
                  <tr key={l.name + l.type}>
                    <td>{l.name}</td>
                    <td className="account-type">{typeLabel(l.type)}</td>
                    <td className="num">{formatCents(l.cents, currency)}</td>
                  </tr>
                ))
              )}
            </tbody>
            <tfoot>
              <tr><td>Total Liabilities</td><td></td><td className="num">{formatCents(liabilityTotal, currency)}</td></tr>
            </tfoot>
          </table>

          <div className="nwr-net">Net Worth: {formatCents(netWorth, currency)}</div>
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
