import { useEffect, useMemo, useState } from "react";
import type { Account, Asset, InvestmentAction, NewTradeInput } from "../shared/types";
import { parseCents, formatCents } from "../core/money";
import { tradeCashCents } from "../core/worth";

interface Props {
  account: Account; // the investment account we're trading in
  onCancel: () => void;
  onSubmit: (input: NewTradeInput) => void | Promise<void>;
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

const ACTIONS: { value: InvestmentAction; label: string }[] = [
  { value: "buy", label: "Buy" },
  { value: "sell", label: "Sell" },
  { value: "div", label: "Dividend (cash)" },
  { value: "reinvest", label: "Reinvest dividend" },
];

/**
 * Investment transaction entry: pick Buy/Sell/Dividend/Reinvest, a security
 * (existing or created inline via ticker), shares, per-share price, and fees.
 * The cash amount that will move in/out of the account is computed and shown live.
 */
export function NewInvestmentDialog({ account, onCancel, onSubmit }: Props) {
  const [assets, setAssets] = useState<Asset[]>([]);
  const [date, setDate] = useState(today());
  const [action, setAction] = useState<InvestmentAction>("buy");
  // "" = create new inline; otherwise an existing asset id.
  const [assetId, setAssetId] = useState<string>("");
  const [newName, setNewName] = useState("");
  const [newSymbol, setNewSymbol] = useState("");
  const [shares, setShares] = useState("0");
  const [price, setPrice] = useState("0.00");
  const [fees, setFees] = useState("0.00");
  const [cashDiv, setCashDiv] = useState("0.00");
  const [error, setError] = useState<string | null>(null);

  // Load existing securities for this account to populate the picker.
  useEffect(() => {
    let alive = true;
    void window.ledger.listAssets(account.id).then((list) => {
      if (!alive) return;
      const securities = list.filter((a) => a.assetClass === "security");
      setAssets(securities);
      // Default to the first existing security, else inline-create mode.
      setAssetId(securities[0]?.id ?? "");
    });
    return () => {
      alive = false;
    };
  }, [account.id]);

  const creatingNew = assetId === "";
  const isCashDiv = action === "div";
  const needsShares = action !== "div"; // buy/sell/reinvest move shares

  // Live computed cash effect on the account.
  const cashCents = useMemo(() => {
    const feesCents = parseCents(fees) ?? 0;
    if (isCashDiv) {
      const div = parseCents(cashDiv) ?? 0;
      return tradeCashCents("div", 0, feesCents, div);
    }
    const units = Number(shares) || 0;
    const priceCents = parseCents(price) ?? 0;
    const gross = Math.round(Math.abs(units) * priceCents);
    return tradeCashCents(action, gross, feesCents);
  }, [action, shares, price, fees, cashDiv, isCashDiv]);

  const cashLabel =
    cashCents > 0
      ? `Cash in: ${formatCents(cashCents, account.currency)}`
      : cashCents < 0
        ? `Cash out: ${formatCents(-cashCents, account.currency)}`
        : "No net cash (reinvested)";

  function submit() {
    setError(null);
    // Validate security selection.
    if (creatingNew) {
      if (!newSymbol.trim()) {
        setError("Enter a ticker symbol (or pick an existing security).");
        return;
      }
    }
    const feesCents = Math.max(0, parseCents(fees) ?? 0);

    if (needsShares) {
      const units = Number(shares);
      if (!Number.isFinite(units) || units <= 0) {
        setError("Enter a positive number of shares.");
        return;
      }
      const priceCents = parseCents(price);
      if (priceCents == null || priceCents < 0) {
        setError("Enter a valid per-share price.");
        return;
      }
    } else {
      const div = parseCents(cashDiv);
      if (div == null || div <= 0) {
        setError("Enter a positive dividend amount.");
        return;
      }
    }

    const input: NewTradeInput = {
      accountId: account.id,
      date,
      action,
      feesCents,
      memo: null,
      ...(creatingNew
        ? {
            newAsset: {
              name: newName.trim() || newSymbol.trim().toUpperCase(),
              symbol: newSymbol.trim().toUpperCase(),
              assetClass: "security",
            },
          }
        : { assetId }),
      ...(needsShares
        ? { units: Number(shares), pricePerUnitCents: parseCents(price) ?? 0 }
        : { cashCents: parseCents(cashDiv) ?? 0 }),
    };
    void onSubmit(input);
  }

  return (
    <div className="dialog-backdrop" onClick={onCancel}>
      <div className="dialog" onClick={(e) => e.stopPropagation()}>
        <h3>New Investment Transaction</h3>

        <div className="field">
          <label>Date</label>
          <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
        </div>

        <div className="field">
          <label>Action</label>
          <select value={action} onChange={(e) => setAction(e.target.value as InvestmentAction)}>
            {ACTIONS.map((a) => (
              <option key={a.value} value={a.value}>
                {a.label}
              </option>
            ))}
          </select>
        </div>

        <div className="field">
          <label>Security</label>
          <select value={assetId} onChange={(e) => setAssetId(e.target.value)}>
            {assets.map((a) => (
              <option key={a.id} value={a.id}>
                {a.symbol ? `${a.symbol} — ${a.name}` : a.name}
              </option>
            ))}
            <option value="">+ New security…</option>
          </select>
        </div>

        {creatingNew && (
          <>
            <div className="field">
              <label>Ticker symbol</label>
              <input
                value={newSymbol}
                autoFocus
                placeholder="e.g. VTSAX, AAPL"
                onChange={(e) => setNewSymbol(e.target.value)}
              />
            </div>
            <div className="field">
              <label>Name (optional)</label>
              <input
                value={newName}
                placeholder="Vanguard Total Stock Market"
                onChange={(e) => setNewName(e.target.value)}
              />
            </div>
          </>
        )}

        {needsShares && (
          <>
            <div className="field">
              <label>Shares</label>
              <input value={shares} onChange={(e) => setShares(e.target.value)} />
            </div>
            <div className="field">
              <label>Price per share</label>
              <input value={price} onChange={(e) => setPrice(e.target.value)} />
            </div>
          </>
        )}

        {isCashDiv && (
          <div className="field">
            <label>Dividend amount</label>
            <input value={cashDiv} autoFocus onChange={(e) => setCashDiv(e.target.value)} />
          </div>
        )}

        <div className="field">
          <label>Fees / commission</label>
          <input value={fees} onChange={(e) => setFees(e.target.value)} />
        </div>

        <div className="field">
          <label>Cash amount</label>
          <div className={cashCents < 0 ? "amount-neg" : "amount-pos"}>{cashLabel}</div>
        </div>

        {error && <div className="error">{error}</div>}
        <div className="dialog-actions">
          <button className="secondary" onClick={onCancel}>
            Cancel
          </button>
          <button onClick={submit}>Add</button>
        </div>
      </div>
    </div>
  );
}
