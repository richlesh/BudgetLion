import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import ReactECharts from "echarts-for-react";
import type { EChartsOption } from "echarts";
import type { Account, ProjectionRow, ForecastPoint } from "../shared/types";
import { formatCents } from "../core/money";

interface Props {
  account: Account;
  dark: boolean;
  onClose: () => void;
  /** Persisted per-column widths (colKey -> px), if any. */
  initialColumnWidths?: Record<string, number>;
  /** Called (debounced) after the user finishes resizing a column, to persist widths. */
  onColumnWidthsChange?: (widths: Record<string, number>) => void;
}

const HORIZONS = [3, 6, 12, 24];

// Forecast ledger columns and their default widths (px). Widths are user-adjustable.
const COLUMNS = [
  { key: "date", label: "Date", align: "left" as const, width: 96 },
  { key: "rule", label: "Rule", align: "left" as const, width: 160 },
  { key: "amount", label: "Amount", align: "right" as const, width: 100 },
  { key: "principal", label: "Principal", align: "right" as const, width: 100 },
  { key: "interest", label: "Interest", align: "right" as const, width: 100 },
  { key: "balance", label: "Balance", align: "right" as const, width: 110 },
];

const MIN_COL_WIDTH = 24;

export function ProjectionPanel({
  account,
  dark,
  onClose,
  initialColumnWidths,
  onColumnWidthsChange,
}: Props) {
  const [horizon, setHorizon] = useState(12);
  const [rows, setRows] = useState<ProjectionRow[]>([]);
  const [forecast, setForecast] = useState<ForecastPoint[]>([]);
  const [loading, setLoading] = useState(true);

  // Per-column widths (px), adjustable by dragging the header dividers.
  // Seeded from persisted settings (by column key) when available.
  const [colWidths, setColWidths] = useState<number[]>(() =>
    COLUMNS.map((c) => initialColumnWidths?.[c.key] ?? c.width)
  );

  // Chart instance + its container, so we can force a resize when the window
  // (and therefore the container) changes size.
  const chartRef = useRef<ReactECharts>(null);
  const chartCardRef = useRef<HTMLDivElement>(null);

  // Keep the latest persist callback in a ref so the resize handlers don't need
  // to be re-created (and re-bound) when the parent re-renders.
  const persistRef = useRef(onColumnWidthsChange);
  useEffect(() => {
    persistRef.current = onColumnWidthsChange;
  }, [onColumnWidthsChange]);

  // Active drag state: which column, the starting mouse X, and its starting width.
  const drag = useRef<{ index: number; startX: number; startWidth: number } | null>(null);

  const onResizeMove = useCallback((e: MouseEvent) => {
    const d = drag.current;
    if (!d) return;
    const delta = e.clientX - d.startX;
    const next = Math.max(MIN_COL_WIDTH, d.startWidth + delta);
    setColWidths((prev) => {
      const copy = [...prev];
      copy[d.index] = next;
      return copy;
    });
  }, []);

  const onResizeEnd = useCallback(() => {
    drag.current = null;
    document.body.style.cursor = "";
    document.body.style.userSelect = "";
    window.removeEventListener("mousemove", onResizeMove);
    window.removeEventListener("mouseup", onResizeEnd);
    // Persist the final widths keyed by column so they survive reopen/relaunch.
    setColWidths((widths) => {
      const record: Record<string, number> = {};
      COLUMNS.forEach((c, i) => (record[c.key] = widths[i]));
      persistRef.current?.(record);
      return widths;
    });
  }, [onResizeMove]);

  const startResize = useCallback(
    (index: number, e: React.MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      drag.current = { index, startX: e.clientX, startWidth: colWidths[index] };
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
      window.addEventListener("mousemove", onResizeMove);
      window.addEventListener("mouseup", onResizeEnd);
    },
    [colWidths, onResizeMove, onResizeEnd]
  );

  // Clean up listeners if the panel unmounts mid-drag.
  useEffect(() => onResizeEnd, [onResizeEnd]);

  // Keep the ECharts canvas sized to its container as the window resizes.
  // echarts-for-react listens to window "resize" itself, but observing the
  // container also covers layout changes (e.g. panel width) without a window event.
  // Re-run when the chart card actually mounts (it only renders once the
  // projection has loaded and there are rows), otherwise the ref is null and
  // the observer never attaches.
  useEffect(() => {
    const card = chartCardRef.current;
    if (loading || rows.length === 0 || !card) return;
    const resizeChart = () => {
      const inst = chartRef.current?.getEchartsInstance();
      inst?.resize();
    };
    const ro = new ResizeObserver(resizeChart);
    ro.observe(card);
    window.addEventListener("resize", resizeChart);
    // Size once now that it's visible.
    resizeChart();
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", resizeChart);
    };
  }, [loading, rows.length]);

  useEffect(() => {
    setLoading(true);
    void window.ledger.getProjection(account.id, horizon).then((p) => {
      setRows(p.rows);
      setForecast(p.forecast);
      setLoading(false);
    });
  }, [account.id, horizon]);

  const textColor = dark ? "#e6e6e6" : "#1e1e1e";

  const option: EChartsOption = useMemo(
    () => ({
      backgroundColor: "transparent",
      textStyle: { color: textColor },
      title: {
        text: `Projected Balance — ${account.name}`,
        left: "center",
        textStyle: { color: textColor, fontSize: 14 },
      },
      tooltip: {
        trigger: "axis",
        formatter: (params: unknown) => {
          const arr = params as Array<{ axisValue: string; value: number }>;
          return `${arr[0]?.axisValue}<br/>${formatCents(arr[0]?.value ?? 0, account.currency)}`;
        },
      },
      grid: { left: 70, right: 20, top: 40, bottom: 40 },
      xAxis: {
        type: "category",
        data: forecast.map((p) => p.date.slice(0, 7)),
        axisLabel: { color: textColor },
      },
      yAxis: {
        type: "value",
        axisLabel: { color: textColor, formatter: (v: number) => formatCents(v, account.currency) },
      },
      series: [
        {
          type: "line",
          smooth: true,
          areaStyle: { opacity: 0.15 },
          lineStyle: { color: "#5b8def", width: 2 },
          itemStyle: { color: "#5b8def" },
          data: forecast.map((p) => p.balanceCents),
          markLine: {
            silent: true,
            symbol: "none",
            lineStyle: { color: "#eb5757", type: "dashed" },
            data: [{ yAxis: 0 }],
          },
        },
      ],
    }),
    [forecast, account, textColor]
  );

  return (
    <div className="charts-panel">
      <div className="charts-toolbar">
        <strong>Forecast — {account.name}</strong>
        <span style={{ flex: 1 }} />
        <label className="chart-ctl">
          Horizon
          <select value={horizon} onChange={(e) => setHorizon(Number(e.target.value))}>
            {HORIZONS.map((h) => (
              <option key={h} value={h}>
                {h} months
              </option>
            ))}
          </select>
        </label>
        <button className="secondary" onClick={onClose}>
          Close
        </button>
      </div>

      {loading ? (
        <div className="empty">Computing projection…</div>
      ) : rows.length === 0 ? (
        <div className="empty">
          No recurring rules affect this account. Add rules via View → Recurring Rules.
        </div>
      ) : (
        <div className="charts-grid" style={{ gridTemplateColumns: "minmax(0, 1fr)" }}>
          <div className="chart-card" ref={chartCardRef}>
            <ReactECharts ref={chartRef} option={option} style={{ height: 300, width: "100%" }} notMerge />
          </div>
          <div className="chart-card" style={{ maxHeight: 280, overflow: "auto" }}>
            <table style={{ borderCollapse: "collapse", fontSize: 12, tableLayout: "fixed", width: "100%" }}>
              <colgroup>
                {COLUMNS.map((c, i) => (
                  // The last column has no fixed width so it absorbs remaining
                  // space, letting the table always fill the panel width. All
                  // earlier columns use their (resizable) pixel widths.
                  <col
                    key={c.key}
                    style={i === COLUMNS.length - 1 ? { width: "auto" } : { width: colWidths[i] }}
                  />
                ))}
              </colgroup>
              <thead>
                <tr>
                  {COLUMNS.map((c, i) => (
                    <th key={c.key} style={{ ...th, textAlign: c.align }}>
                      <span className="fc-th-label">{c.label}</span>
                      {i < COLUMNS.length - 1 && (
                        <span
                          className="fc-col-resizer"
                          onMouseDown={(e) => startResize(i, e)}
                          role="separator"
                          aria-orientation="vertical"
                          aria-label={`Resize ${c.label} column`}
                        />
                      )}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((r, i) => (
                  <tr key={i}>
                    <td style={td}>{r.occurrence.date}</td>
                    <td style={td}>{r.occurrence.ruleName}</td>
                    <td style={{ ...td, textAlign: "right" }} className={r.occurrence.signedAmountCents < 0 ? "neg" : ""}>
                      {formatCents(r.occurrence.signedAmountCents, account.currency)}
                    </td>
                    <td style={{ ...td, textAlign: "right" }}>
                      {r.occurrence.principalCents != null
                        ? formatCents(r.occurrence.principalCents, account.currency)
                        : ""}
                    </td>
                    <td style={{ ...td, textAlign: "right" }}>
                      {r.occurrence.interestCents != null
                        ? formatCents(r.occurrence.interestCents, account.currency)
                        : ""}
                    </td>
                    <td style={{ ...td, textAlign: "right" }} className={r.runningBalanceCents < 0 ? "neg" : ""}>
                      {formatCents(r.runningBalanceCents, account.currency)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

const th: React.CSSProperties = {
  textAlign: "left",
  padding: "6px 8px",
  position: "sticky",
  top: 0,
  background: "var(--panel)",
  borderBottom: "1px solid var(--border)",
  overflow: "hidden",
  whiteSpace: "nowrap",
};
const td: React.CSSProperties = {
  padding: "4px 8px",
  borderBottom: "1px solid var(--border)",
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};
