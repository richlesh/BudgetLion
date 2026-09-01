import { useEffect, useMemo, useState } from "react";
import type {
  Account,
  Asset,
  Category,
  InvestmentAction,
  NewTradeInput,
} from "../shared/types";
import { parseCents, parsePriceCents, formatCents } from "../core/money";
import { tradeCashCents } from "../core/worth";
import { categoriesForDirection, categoryOptions } from "../core/categories";

interface Props {
  account: Account; // the investment account we're trading in
  categories: Category[]; // for the income-category picker (grant/div/reinvest)
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
  { value: "grant", label: "Grant (salary / RSU)" },
];

/**
 * Investment transaction entry: Buy / Sell / Dividend / Reinvest / Grant, a
 * security (existing or created inline via ticker), shares, per-share price, and
 * fees. Income-bearing actions (grant/dividend/reinvest) also take an income
 * category. The cash amount moving in/out of the account is computed live.
 */
export function NewInvestmentDialog({ account, categories, onCancel, onSubmit }: Props) {
  const [assets, setAssets] = useState<Asset[]>([]);
  const [date, setDate] = useState(today());
  const [action, setAction] = useState<InvestmentAction>("buy");
  const [assetId, setAssetId] = useState<string>("");
  const [newName, setNewName] = useState("");
  const [newSymbol, setNewSymbol] = useState("");
  const [shares, setShares] = useState("0");
  const [price, setPrice] = useState("0.00");
  const [amount, setAmount] = useState("0.00");
  // Which of price/amount the user last typed. The OTHER is derived from shares:
  //   lastEdited "price"  => amount = shares * price
  //   lastEdited "amount" => price  = amount / shares
  const [lastEdited, setLastEdited] = useState<"price" | "amount">("price");
  const [fees, setFees] = useState("0.00");
  const [cashDiv, setCashDiv] = useState("0.00");
  const [categoryId, setCategoryId] = useState<string>("");
  const [feeCategoryId, setFeeCategoryId] = useState<string>("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    void window.ledger.listAssets(account.id).then((list) => {
      if (!alive) return;
      const securities = list.filter((a) => a.assetClass === "security");
      setAssets(securities);
      setAssetId(securities[0]?.id ?? "");
    });
    return () => {
      alive = false;
    };
  }, [account.id]);

  const creatingNew = assetId === "";
  const isCashDiv = action === "div";
  const needsShares = action !== "div"; // buy/sell/reinvest/grant move shares
  // Grant, cash dividend, and reinvested dividend are income and can be categorized.
  const isIncome = action === "grant" || action === "div" || action === "reinvest";

  // ---- Bidirectional shares / price / amount ----
  // The user types two of the three; the third is derived. `lastEdited` records
  // whether price or amount is the typed one, so the other is computed here.
  const unitsNum = Math.abs(Number(shares) || 0);

  // Effective per-share price in (possibly fractional) cents.
  const effectivePriceCents = useMemo(() => {
    if (lastEdited === "price") return parsePriceCents(price) ?? 0;
    // Derived from amount: price = amount / shares.
    const amt = parseCents(amount) ?? 0;
    return unitsNum > 0 ? amt / unitsNum : 0;
  }, [lastEdited, price, amount, unitsNum]);

  // Effective gross amount (shares * price) in whole cents.
  const effectiveGrossCents = useMemo(() => {
    if (lastEdited === "amount") return parseCents(amount) ?? 0;
    return Math.round(unitsNum * (parsePriceCents(price) ?? 0));
  }, [lastEdited, price, amount, unitsNum]);

  // Display strings for the two fields: the typed one shows what the user typed;
  // the derived one shows the computed value.
  const priceDisplay =
    lastEdited === "price" ? price : (effectivePriceCents / 100).toFixed(6).replace(/0+$/, "").replace(/\.$/, "");
  const amountDisplay =
    lastEdited === "amount" ? amount : (effectiveGrossCents / 100).toFixed(2);

  // Income categories for the picker (Salary, Dividend, etc.).
  const incomeCategoryChoices = useMemo(
    () => categoryOptions(categoriesForDirection(categories, "income")),
    [categories]
  );
  // Expense categories for the optional fee picker (Investment:Fees, etc.).
  const expenseCategoryChoices = useMemo(
    () => categoryOptions(categoriesForDirection(categories, "expense")),
    [categories]
  );

  // Live computed cash effect on the account (trade leg + income leg).
  const cashCents = useMemo(() => {
    const feesCents = parseCents(fees) ?? 0;
    if (isCashDiv) {
      const div = parseCents(cashDiv) ?? 0;
      return tradeCashCents("div", 0, feesCents, div);
    }
    const gross = effectiveGrossCents;
    const tradeLeg = tradeCashCents(action, gross, feesCents);
    const incomeLeg = action === "grant" || action === "reinvest" ? gross : 0;
    return tradeLeg + incomeLeg;
  }, [action, effectiveGrossCents, fees, cashDiv, isCashDiv]);

  const cashLabel =
    cashCents > 0
      ? `Cash in: ${formatCents(cashCents, account.currency)}`
      : cashCents < 0
        ? `Cash out: ${formatCents(-cashCents, account.currency)}`
        : "No net cash change";

  function submit() {
    setError(null);
    if (creatingNew && !newSymbol.trim()) {
      setError("Enter a ticker symbol (or pick an existing security).");
      return;
    }
    const feesCents = Math.max(0, parseCents(fees) ?? 0);

    if (needsShares) {
      const units = Number(shares);
      if (!Number.isFinite(units) || units <= 0) {
        setError("Enter a positive number of shares.");
        return;
      }
      if (!(effectivePriceCents >= 0) || effectiveGrossCents <= 0) {
        setError("Enter a valid price per share or amount.");
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
      categoryId: isIncome ? categoryId || null : null,
      feeCategoryId: feeCategoryId || null,
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
        ? { units: Number(shares), pricePerUnitCents: effectivePriceCents }
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
              <label>{action === "grant" ? "Grant price per share" : "Price per share"}</label>
              <input
                value={priceDisplay}
                onChange={(e) => {
                  setPrice(e.target.value);
                  setLastEdited("price");
                }}
              />
            </div>
            <div className="field">
              <label>Amount (shares × price)</label>
              <input
                value={amountDisplay}
                onChange={(e) => {
                  setAmount(e.target.value);
                  setLastEdited("amount");
                }}
              />
            </div>
          </>
        )}

        {isCashDiv && (
          <div className="field">
            <label>Dividend amount</label>
            <input value={cashDiv} autoFocus onChange={(e) => setCashDiv(e.target.value)} />
          </div>
        )}

        {isIncome && (
          <div className="field">
            <label>Income category {action === "grant" ? "(e.g. Salary)" : "(e.g. Dividend)"}</label>
            <select value={categoryId} onChange={(e) => setCategoryId(e.target.value)}>
              <option value="">— Uncategorized —</option>
              {incomeCategoryChoices.map((o) => (
                <option key={o.category.id} value={o.category.id}>
                  {o.display}
                </option>
              ))}
            </select>
          </div>
        )}

        <div className="field">
          <label>Fees / commission</label>
          <input value={fees} onChange={(e) => setFees(e.target.value)} />
        </div>

        <div className="field">
          <label>Fee category (optional — expense)</label>
          <select value={feeCategoryId} onChange={(e) => setFeeCategoryId(e.target.value)}>
            <option value="">— Add to cost basis (not categorized) —</option>
            {expenseCategoryChoices.map((o) => (
              <option key={o.category.id} value={o.category.id}>
                {o.display}
              </option>
            ))}
          </select>
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
