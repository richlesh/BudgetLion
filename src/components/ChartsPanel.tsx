import { useEffect, useMemo, useRef, useState } from "react";
import ReactECharts from "echarts-for-react";
import type { EChartsOption } from "echarts";
import * as echarts from "echarts";
import type { Account, AggregateData, ChartScope, DateRange } from "../shared/types";
import { categoryFlow, spendingByMonth, dataDateBounds, scopeLabel } from "../core/aggregate";
import { formatCents } from "../core/money";

interface Props {
  account: Account | null; // currently selected account (for default scope)
  dark: boolean;
  onClose: () => void;
  onToast: (msg: string) => void;
}

const PALETTE = [
  "#5b8def", "#f2994a", "#27ae60", "#eb5757", "#9b51e0",
  "#2d9cdb", "#f2c94c", "#219653", "#bb6bd9", "#56ccf2",
];

export function ChartsPanel({ account, dark, onClose, onToast }: Props) {
  const [data, setData] = useState<AggregateData | null>(null);
  const [scopeKind, setScopeKind] = useState<"account" | "all">(account ? "account" : "all");
  const [range, setRange] = useState<DateRange>({ start: null, end: null });
  // Pie chart mode: expenses (outflows) or income (inflows).
  const [pieMode, setPieMode] = useState<"expense" | "income">("expense");
  const pieRef = useRef<ReactECharts>(null);
  const barRef = useRef<ReactECharts>(null);

  useEffect(() => {
    void window.ledger.getAggregateData().then((d) => {
      setData(d);
      setRange(dataDateBounds(d)); // default to full data range
    });
  }, []);

  const scope: ChartScope = useMemo(
    () =>
      scopeKind === "account" && account
        ? { kind: "account", accountId: account.id }
        : { kind: "all" },
    [scopeKind, account]
  );

  const categoryData = useMemo(
    () => (data ? categoryFlow(data, scope, range, pieMode) : []),
    [data, scope, range, pieMode]
  );
  const monthData = useMemo(
    () => (data ? spendingByMonth(data, scope, range) : []),
    [data, scope, range]
  );

  const currency = account?.currency ?? "USD";
  const textColor = dark ? "#e6e6e6" : "#1e1e1e";

  const pieOption: EChartsOption = useMemo(
    () => ({
      backgroundColor: "transparent",
      color: PALETTE,
      textStyle: { color: textColor },
      title: {
        text: pieMode === "expense" ? "Expenses by Category" : "Income by Category",
        left: "center",
        textStyle: { color: textColor, fontSize: 14 },
      },
      tooltip: {
        trigger: "item",
        formatter: (p: unknown) => {
          const d = p as { name: string; value: number; percent: number };
          return `${d.name}: ${formatCents(d.value, currency)} (${d.percent}%)`;
        },
      },
      legend: { bottom: 0, textStyle: { color: textColor }, type: "scroll" },
      series: [
        {
          type: "pie",
          radius: ["35%", "65%"],
          center: ["50%", "48%"],
          data: categoryData.map((c) => ({ name: c.categoryName, value: c.amountCents })),
          label: { color: textColor },
        },
      ],
    }),
    [categoryData, currency, textColor, pieMode]
  );

  const barOption: EChartsOption = useMemo(
    () => ({
      backgroundColor: "transparent",
      color: ["#eb5757", "#27ae60"],
      textStyle: { color: textColor },
      title: { text: "By Month", left: "center", textStyle: { color: textColor, fontSize: 14 } },
      tooltip: {
        trigger: "axis",
        formatter: (params: unknown) => {
          const arr = params as Array<{ axisValue: string; seriesName: string; value: number }>;
          const lines = arr.map((s) => `${s.seriesName}: ${formatCents(s.value, currency)}`);
          return `${arr[0]?.axisValue}<br/>${lines.join("<br/>")}`;
        },
      },
      legend: { bottom: 0, textStyle: { color: textColor } },
      grid: { left: 60, right: 20, top: 40, bottom: 50 },
      xAxis: {
        type: "category",
        data: monthData.map((m) => m.month),
        axisLabel: { color: textColor },
      },
      yAxis: {
        type: "value",
        axisLabel: {
          color: textColor,
          formatter: (v: number) => formatCents(v, currency),
        },
      },
      series: [
        { name: "Spending", type: "bar", data: monthData.map((m) => m.spendingCents) },
        { name: "Income", type: "bar", data: monthData.map((m) => m.incomeCents) },
      ],
    }),
    [monthData, currency, textColor]
  );

  async function exportPng(which: "pie" | "bar") {
    const ref = which === "pie" ? pieRef.current : barRef.current;
    const inst = ref?.getEchartsInstance();
    if (!inst) return;
    const url = inst.getDataURL({ pixelRatio: 2, backgroundColor: dark ? "#1e1f22" : "#ffffff" });
    const name = `${scopeLabel(scope, data?.accounts ?? []).replace(/[^a-z0-9]/gi, "_")}-${which}`;
    const ok = await window.ledger.saveDataUrl(name, url, "png");
    if (ok) onToast(`Exported ${which} chart as PNG.`);
  }

  async function exportSvg(which: "pie" | "bar") {
    const onScreen = (which === "pie" ? pieRef.current : barRef.current)?.getEchartsInstance();
    const option = which === "pie" ? pieOption : barOption;
    // ECharts renders SVG only via the SVG renderer, so build a temporary
    // offscreen instance with that renderer, sized to the on-screen chart.
    const width = onScreen?.getWidth() ?? 600;
    const height = onScreen?.getHeight() ?? 320;
    const holder = document.createElement("div");
    holder.style.cssText = `position:absolute;left:-99999px;top:0;width:${width}px;height:${height}px;`;
    document.body.appendChild(holder);
    try {
      const inst = echarts.init(holder, undefined, { renderer: "svg", width, height });
      // Disable animation: with the SVG renderer, renderToSVGString() captures a
      // single synchronous frame, so animated series (pie slices, bars) would
      // otherwise be captured at their pre-animation (empty) state.
      inst.setOption({
        ...option,
        animation: false,
        backgroundColor: dark ? "#1e1f22" : "#ffffff",
      });
      const svg = inst.renderToSVGString();
      inst.dispose();
      const name = `${scopeLabel(scope, data?.accounts ?? []).replace(/[^a-z0-9]/gi, "_")}-${which}`;
      const ok = await window.ledger.saveTextFile(name, svg, "svg");
      if (ok) onToast(`Exported ${which} chart as SVG.`);
    } finally {
      document.body.removeChild(holder);
    }
  }

  const pieTotal = categoryData.reduce((s, c) => s + c.amountCents, 0);

  return (
    <div className="charts-panel">
      <div className="charts-toolbar">
        <strong>Charts — {scopeLabel(scope, data?.accounts ?? [])}</strong>
        <span style={{ flex: 1 }} />
        <label className="chart-ctl">
          Scope
          <select value={scopeKind} onChange={(e) => setScopeKind(e.target.value as "account" | "all")}>
            <option value="account" disabled={!account}>
              This account
            </option>
            <option value="all">All accounts</option>
          </select>
        </label>
        <label className="chart-ctl">
          From
          <input
            type="date"
            value={range.start ?? ""}
            onChange={(e) => setRange((r) => ({ ...r, start: e.target.value || null }))}
          />
        </label>
        <label className="chart-ctl">
          To
          <input
            type="date"
            value={range.end ?? ""}
            onChange={(e) => setRange((r) => ({ ...r, end: e.target.value || null }))}
          />
        </label>
        <button className="secondary" onClick={onClose}>
          Close
        </button>
      </div>

      {!data ? (
        <div className="empty">Loading…</div>
      ) : categoryData.length === 0 && monthData.length === 0 ? (
        <div className="empty">No transactions in the selected range.</div>
      ) : (
        <div className="charts-grid">
          <div className="chart-card">
            <div className="pie-mode-toggle">
              <span className={pieMode === "expense" ? "active" : ""}>Expenses</span>
              <button
                type="button"
                role="switch"
                aria-checked={pieMode === "income"}
                aria-label="Toggle between expenses and income"
                className={"switch" + (pieMode === "income" ? " on" : "")}
                onClick={() => setPieMode((m) => (m === "expense" ? "income" : "expense"))}
              >
                <span className="switch-knob" />
              </button>
              <span className={pieMode === "income" ? "active" : ""}>Income</span>
            </div>
            <ReactECharts
              ref={pieRef}
              option={pieOption}
              style={{ height: 320 }}
              notMerge
              theme={undefined}
            />
            <div className="chart-actions">
              <button className="secondary" onClick={() => exportPng("pie")}>
                Export PNG
              </button>
              <span className="account-type">
                Total {pieMode === "expense" ? "expenses" : "income"}:{" "}
                {formatCents(pieTotal, currency)}
              </span>
              <button className="secondary" onClick={() => exportSvg("pie")}>
                Export SVG
              </button>
            </div>
          </div>
          <div className="chart-card">
            <ReactECharts ref={barRef} option={barOption} style={{ height: 320 }} notMerge />
            <div className="chart-actions">
              <button className="secondary" onClick={() => exportPng("bar")}>
                Export PNG
              </button>
              <button className="secondary" onClick={() => exportSvg("bar")}>
                Export SVG
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
