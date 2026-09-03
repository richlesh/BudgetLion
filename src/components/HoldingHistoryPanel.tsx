import { useEffect, useMemo, useState } from "react";
import ReactECharts from "echarts-for-react";
import type { EChartsOption } from "echarts";
import type { AssetValuation, InvestmentTransaction, SecurityHolding } from "../shared/types";
import { MICRO } from "../shared/types";
import { formatCents } from "../core/money";
import { sharesMicroAsOf } from "../core/worth";

interface Props {
  holding: SecurityHolding;
  currency: string;
  dark: boolean;
  /** When true, always chart Total Value and hide the Share Price/Total toggle
   *  (used for asset accounts, which hold a single item). */
  valueOnly?: boolean;
  onClose: () => void;
}

/** What the chart plots. */
type Metric = "price" | "value";

/** Preset display ranges for the history chart. */
type RangeKey = "ytd" | "3m" | "6m" | "1y" | "3y" | "5y" | "all";
const RANGE_OPTIONS: Array<{ key: RangeKey; label: string }> = [
  { key: "ytd", label: "Year to Date" },
  { key: "3m", label: "Last 3 Months" },
  { key: "6m", label: "Last 6 Months" },
  { key: "1y", label: "Last 1 Year" },
  { key: "3y", label: "Last 3 Years" },
  { key: "5y", label: "Last 5 Years" },
  { key: "all", label: "All Available" },
];

/** The inclusive start (ISO date) for a range relative to today, or null for "all". */
function rangeStartISO(key: RangeKey): string | null {
  const now = new Date();
  if (key === "all") return null;
  if (key === "ytd") return `${now.getFullYear()}-01-01`;
  const d = new Date(now);
  if (key === "3m") d.setMonth(d.getMonth() - 3);
  else if (key === "6m") d.setMonth(d.getMonth() - 6);
  else if (key === "1y") d.setFullYear(d.getFullYear() - 1);
  else if (key === "3y") d.setFullYear(d.getFullYear() - 3);
  else if (key === "5y") d.setFullYear(d.getFullYear() - 5);
  return d.toISOString().slice(0, 10);
}

/**
 * Historical valuation chart for a single holding. Plots the recorded per-share
 * prices over time (both manual and auto-fetched valuations share this store),
 * with a toggle between "Share Price" and "Total Value" (price × current shares).
 *
 * Note: Total Value uses the holding's CURRENT share count for every point (we
 * don't reconstruct historical share counts), so it reflects "what the position
 * would be worth at each historical price."
 */
export function HoldingHistoryPanel({ holding, currency, dark, valueOnly = false, onClose }: Props) {
  const [valuations, setValuations] = useState<AssetValuation[]>([]);
  const [lots, setLots] = useState<InvestmentTransaction[]>([]);
  const [metric, setMetric] = useState<Metric>(valueOnly ? "value" : "price");
  const [range, setRange] = useState<RangeKey>("1y");
  const [filling, setFilling] = useState(false);
  const [status, setStatus] = useState<string | null>(null);

  const loadValuations = () =>
    window.ledger.listValuations(holding.asset.id).then(setValuations);

  useEffect(() => {
    void loadValuations();
    // The asset's lots (for shares-as-of); filter the account's txns to this asset.
    void window.ledger
      .listInvestmentTxns(holding.asset.accountId)
      .then((txns) => setLots(txns.filter((t) => t.assetId === holding.asset.id)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [holding.asset.id, holding.asset.accountId]);

  const textColor = dark ? "#e6e6e6" : "#1e1e1e";

  // Backfill monthly historical prices from the provider (tickered assets only).
  async function fillHistory() {
    setFilling(true);
    setStatus(null);
    try {
      const res = await window.ledger.backfillPriceHistory(holding.asset.id);
      if (!res.resolved) {
        setStatus(res.error ?? "Could not fetch historical prices.");
      } else {
        setStatus(
          res.added > 0
            ? `Added ${res.added} monthly price${res.added === 1 ? "" : "s"}.`
            : "History is already up to date."
        );
        await loadValuations();
      }
    } finally {
      setFilling(false);
    }
  }

  // Sorted (asc) [date, cents] points for the selected metric. Share Price uses
  // the raw valuation; Total Value multiplies each date's price by the shares
  // held AS OF that date (from the lots), so the value curve tracks the position.
  // In Total Value mode, sharesByIndex[i] is the share count at points[i] (for
  // the tooltip).
  const { points, sharesByIndex } = useMemo(() => {
    const cutoff = rangeStartISO(range);
    const rows = [...valuations]
      .filter((v) => v.deletedAt == null && (cutoff == null || v.asOfDate >= cutoff))
      .sort((a, b) => (a.asOfDate < b.asOfDate ? -1 : a.asOfDate > b.asOfDate ? 1 : 0));
    const pts: Array<[string, number]> = [];
    const shares: number[] = [];
    for (const v of rows) {
      const priceCents = v.valueMicros / MICRO; // per-share cents (may be fractional)
      if (metric === "price") {
        pts.push([v.asOfDate, Math.round(priceCents)]);
        shares.push(0);
      } else {
        // No lots (a physical asset item) => constant quantity from the holding.
        const sharesMicro = lots.length > 0 ? sharesMicroAsOf(lots, v.asOfDate) : holding.sharesMicro;
        pts.push([v.asOfDate, Math.round((sharesMicro * v.valueMicros) / (MICRO * MICRO))]);
        shares.push(sharesMicro / MICRO);
      }
    }
    return { points: pts, sharesByIndex: shares };
  }, [valuations, metric, lots, range, holding]);

  const title = holding.asset.symbol
    ? `${holding.asset.symbol} — ${holding.asset.name}`
    : holding.asset.name;

  const option: EChartsOption = useMemo(
    () => ({
      backgroundColor: "transparent",
      textStyle: { color: textColor },
      title: {
        text: metric === "price" ? "Share Price" : "Total Value",
        left: "center",
        textStyle: { color: textColor, fontSize: 14 },
      },
      grid: { left: 70, right: 24, top: 44, bottom: 40 },
      tooltip: {
        trigger: "axis",
        formatter: (params: unknown) => {
          const arr = params as Array<{ axisValue: string; value: number; dataIndex: number }>;
          const p = arr[0];
          const base = `${p.axisValue}<br/>${formatCents(p.value, currency)}`;
          if (metric !== "value" || valueOnly) return base;
          const sh = sharesByIndex[p.dataIndex] ?? 0;
          // Trim trailing zeros from the share count.
          const shStr = Number(sh.toFixed(6)).toString();
          return `${base}<br/>${shStr} share${sh === 1 ? "" : "s"}`;
        },
      },
      xAxis: {
        type: "category",
        data: points.map((p) => p[0]),
        axisLabel: { color: textColor },
      },
      yAxis: {
        type: "value",
        scale: true,
        axisLabel: { color: textColor, formatter: (v: number) => formatCents(v, currency) },
      },
      series: [
        {
          type: "line",
          showSymbol: true,
          smooth: false,
          data: points.map((p) => p[1]),
          lineStyle: { color: "#2d9cdb" },
          itemStyle: { color: "#2d9cdb" },
          areaStyle: { color: "rgba(45,156,219,0.12)" },
        },
      ],
    }),
    [points, sharesByIndex, metric, textColor, currency, valueOnly]
  );

  return (
    <div className="dialog-backdrop dialog-backdrop-top" onClick={onClose}>
      <div className="dialog" style={{ width: "min(760px, 92vw)" }} onClick={(e) => e.stopPropagation()}>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <h3 style={{ margin: 0 }}>Price History — {title}</h3>
          <span style={{ flex: 1 }} />
          {holding.asset.symbol && (
            <button className="secondary" onClick={() => void fillHistory()} disabled={filling}>
              {filling ? "Filling…" : "Fill monthly history"}
            </button>
          )}
          <button className="secondary" onClick={onClose}>Close</button>
        </div>

        <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 18, flexWrap: "wrap" }}>
          {!valueOnly && (
            <div className="pie-mode-toggle">
              <span className={metric === "price" ? "active" : ""}>Share Price</span>
              <button
                type="button"
                role="switch"
                aria-checked={metric === "value"}
                aria-label="Toggle between share price and total value"
                className={"switch" + (metric === "value" ? " on" : "")}
                onClick={() => setMetric((m) => (m === "price" ? "value" : "price"))}
              >
                <span className="switch-knob" />
              </button>
              <span className={metric === "value" ? "active" : ""}>Total Value</span>
            </div>
          )}
          <label className="chart-ctl">
            Range
            <select value={range} onChange={(e) => setRange(e.target.value as RangeKey)}>
              {RANGE_OPTIONS.map((o) => (
                <option key={o.key} value={o.key}>{o.label}</option>
              ))}
            </select>
          </label>
        </div>

        {points.length === 0 ? (
          <div className="empty">
            {valuations.some((v) => v.deletedAt == null) ? (
              <>No prices in this range. Choose a wider range (e.g. All Available).</>
            ) : (
              <>
                No price history yet.
                {holding.asset.symbol ? " Use \u201CFill monthly history\u201D to pull past prices, or " : " "}
                enter a price in the Holdings panel (double-click the Price cell).
              </>
            )}
          </div>
        ) : (
          <ReactECharts option={option} style={{ height: 340 }} notMerge />
        )}
        {metric === "value" && !valueOnly && points.length > 0 && (
          <div className="account-type" style={{ marginTop: 6 }}>
            Total Value = each date&rsquo;s price &times; shares held as of that date.
          </div>
        )}
        {status && (
          <div className="account-type" style={{ marginTop: 6 }}>{status}</div>
        )}
      </div>
    </div>
  );
}
