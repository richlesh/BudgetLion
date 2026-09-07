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
import { GlobeIcon } from "./GlobeIcon";
import { LockIcon } from "./LockIcon";

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
  { value: "add", label: "Add shares (opening / gift / transfer-in)" },
];

/** Which of the three linked trade fields is held fixed (A = S × P). */
export type TradeField = "shares" | "price" | "amount";

/** The three linked fields as raw input strings. */
export interface TradeFields {
  shares: string;
  price: string;
  amount: string;
}

/** Format a shares count (up to 6 dp, trailing zeros trimmed). */
function fmtShares(n: number): string {
  if (!Number.isFinite(n)) return "";
  return Number(n.toFixed(6)).toString();
}
/** Format a per-share price in dollars (up to 6 dp, trailing zeros trimmed). */
function fmtPrice(dollars: number): string {
  if (!Number.isFinite(dollars)) return "";
  return dollars.toFixed(6).replace(/0+$/, "").replace(/\.$/, "");
}
/** Format a money amount in dollars (2 dp). */
function fmtAmount(dollars: number): string {
  if (!Number.isFinite(dollars)) return "";
  return dollars.toFixed(2);
}

/** Parse the raw field strings into numbers (dollars for price/amount). */
function readTrade(f: TradeFields): { s: number; p: number; a: number } {
  const s = Math.abs(Number((f.shares || "").replace(/,/g, "")) || 0);
  const p = (parsePriceCents(f.price) ?? 0) / 100; // dollars/share
  const a = (parseCents(f.amount) ?? 0) / 100; // dollars
  return { s, p, a };
}

/**
 * Recompute the linked trade fields after `changed` was edited, holding `locked`
 * fixed (A = S × P). With a lock on L, editing one free field recomputes the
 * OTHER free field so L stays put. With no lock (locked = null) it preserves the
 * legacy behavior: editing shares/price updates amount; editing amount updates
 * price (when shares are known). Returns the next set of raw strings.
 */
export function recomputeTradeFields(
  next: TradeFields,
  locked: TradeField | null,
  changed: TradeField
): TradeFields {
  const { s, p, a } = readTrade(next);
  const out: TradeFields = { ...next };

  // No lock: legacy 2-way behavior (amount derived from shares×price by default).
  if (locked == null) {
    if (changed === "amount") {
      if (s > 0) out.price = fmtPrice(a / s);
    } else {
      out.amount = fmtAmount(s * p);
    }
    return out;
  }

  // Editing the locked field itself: keep it as typed and recompute amount from
  // shares×price (or price from amount when amount is the locked/basis field).
  if (changed === locked) {
    if (locked === "amount") {
      if (s > 0) out.price = fmtPrice(a / s);
    } else {
      out.amount = fmtAmount(s * p);
    }
    return out;
  }

  // Editing a FREE field: recompute the other free field so `locked` stays fixed.
  // free fields = the two that aren't `locked`; `changed` is one of them.
  if (locked === "amount") {
    // A fixed. Edit shares -> price = A/S; edit price -> shares = A/P.
    if (changed === "shares") out.price = s > 0 ? fmtPrice(a / s) : out.price;
    else out.shares = p > 0 ? fmtShares(a / p) : out.shares;
  } else if (locked === "price") {
    // P fixed. Edit shares -> amount = S×P; edit amount -> shares = A/P.
    if (changed === "shares") out.amount = fmtAmount(s * p);
    else out.shares = p > 0 ? fmtShares(a / p) : out.shares;
  } else {
    // locked === "shares". S fixed. Edit price -> amount = S×P; edit amount -> price = A/S.
    if (changed === "price") out.amount = fmtAmount(s * p);
    else out.price = s > 0 ? fmtPrice(a / s) : out.price;
  }
  return out;
}


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
  // Three linked fields: A = S × P. Exactly one may be LOCKED (held fixed); when
  // set, editing one free field recomputes the other free field. Null = no lock
  // (legacy 2-way behavior: amount follows shares×price). Default: lock Amount so
  // editing shares/price recomputes the other and the amount you set stays put.
  const [locked, setLocked] = useState<TradeField | null>(null);
  const [fees, setFees] = useState("0.00");
  const [cashDiv, setCashDiv] = useState("0.00");
  const [categoryId, setCategoryId] = useState<string>("");
  const [feeCategoryId, setFeeCategoryId] = useState<string>("");
  const [memo, setMemo] = useState("");
  const [error, setError] = useState<string | null>(null);
  // Price-on-date lookup (opt-in Yahoo): in-flight flag + last status message.
  const [priceLookupBusy, setPriceLookupBusy] = useState(false);
  const [priceLookupMsg, setPriceLookupMsg] = useState<string | null>(null);

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
  const needsShares = action !== "div"; // buy/sell/reinvest/grant/add move shares
  const isAdd = action === "add"; // opening / gift / transfer-in: no cash or income
  // Grant, cash dividend, and reinvested dividend are income and can be categorized.
  const isIncome = action === "grant" || action === "div" || action === "reinvest";

  // The ticker to price: the new-security field when creating, else the selected
  // existing security's symbol. Trimmed/uppercased; empty when none.
  const lookupSymbol = (
    creatingNew ? newSymbol : assets.find((a) => a.id === assetId)?.symbol ?? ""
  )
    .trim()
    .toUpperCase();

  // Fetch the per-share closing price for `lookupSymbol` on the Date field's date
  // and fill the Price per Share field. Opt-in Yahoo fetch (gated in main).
  async function lookupPriceOnDate() {
    setPriceLookupMsg(null);
    if (!lookupSymbol) {
      setPriceLookupMsg("Enter a ticker symbol first.");
      return;
    }
    setPriceLookupBusy(true);
    try {
      const res = await window.ledger.fetchPriceForDate(lookupSymbol, date);
      if (res.resolved && res.priceCents != null) {
        // Show cents as dollars with up to 6 dp (trim trailing zeros), matching
        // how the price field renders derived values.
        const dollars = (res.priceCents / 100)
          .toFixed(6)
          .replace(/0+$/, "")
          .replace(/\.$/, "");
        // Treat the fetched value as a Price edit so the linked fields recompute
        // per the current lock (the button is disabled when Price is locked).
        editTradeField("price", dollars);
        setPriceLookupMsg(
          res.asOfDate && res.asOfDate !== date
            ? `Close from ${res.asOfDate} (nearest trading day).`
            : `Price as of ${res.asOfDate ?? date}.`
        );
      } else {
        setPriceLookupMsg(res.error ?? "No price found for that symbol/date.");
      }
    } catch (e) {
      setPriceLookupMsg(e instanceof Error ? e.message : "Price lookup failed.");
    } finally {
      setPriceLookupBusy(false);
    }
  }

  // ---- Shares / price / amount (A = S × P) with an optional locked field ----
  // Effective per-share price in (possibly fractional) cents, read from the field.
  const effectivePriceCents = useMemo(() => parsePriceCents(price) ?? 0, [price]);

  // Effective gross amount in whole cents, read from the Amount field.
  const effectiveGrossCents = useMemo(() => parseCents(amount) ?? 0, [amount]);

  // Apply an edit to one of the three linked fields and recompute per the lock.
  function editTradeField(field: TradeField, value: string) {
    const base: TradeFields = { shares, price, amount };
    base[field] = value;
    const nextFields = recomputeTradeFields(base, locked, field);
    setShares(nextFields.shares);
    setPrice(nextFields.price);
    setAmount(nextFields.amount);
  }

  // Toggle the lock on a field (only one at a time; clicking the locked one clears it).
  function toggleLock(field: TradeField) {
    setLocked((cur) => (cur === field ? null : field));
  }

  const priceDisplay = price;
  const amountDisplay = amount;

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
        : isAdd
          ? "No cash change (shares added directly)"
          : "No net cash change";

  function submit() {
    setError(null);
    if (creatingNew && !newName.trim() && !newSymbol.trim()) {
      setError("Enter a security name (a ticker symbol is optional).");
      return;
    }
    const feesCents = Math.max(0, parseCents(fees) ?? 0);

    if (needsShares) {
      const units = Number(shares);
      if (!Number.isFinite(units) || units <= 0) {
        setError("Enter a positive number of shares.");
        return;
      }
      // For 'add' (opening/gift/transfer-in) the cost basis is OPTIONAL; other
      // actions require a valid price/amount.
      if (!isAdd && (!(effectivePriceCents >= 0) || effectiveGrossCents <= 0)) {
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
      memo: memo.trim() || null,
      categoryId: isIncome ? categoryId || null : null,
      feeCategoryId: feeCategoryId || null,
      ...(creatingNew
        ? {
            newAsset: {
              name: newName.trim() || newSymbol.trim().toUpperCase(),
              // Optional ticker: null when left blank (non-market-priced assets).
              symbol: newSymbol.trim() ? newSymbol.trim().toUpperCase() : null,
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
              <label>
                Shares{locked === "shares" ? " (locked)" : ""}
              </label>
              <div className="lock-row">
                <button
                  type="button"
                  className={"lock-btn" + (locked === "shares" ? " on" : "")}
                  title={locked === "shares" ? "Unlock Shares" : "Lock Shares (hold fixed)"}
                  aria-label={locked === "shares" ? "Unlock Shares" : "Lock Shares"}
                  aria-pressed={locked === "shares"}
                  onClick={() => toggleLock("shares")}
                >
                  <LockIcon locked={locked === "shares"} />
                </button>
                <input
                  style={{ flex: 1 }}
                  value={shares}
                  disabled={locked === "shares"}
                  onChange={(e) => editTradeField("shares", e.target.value)}
                />
              </div>
            </div>
            <div className="field">
              <label>
                {action === "grant" ? "Grant price per share" : "Price per Share"}
                {locked === "price" ? " (locked)" : ""}
              </label>
              <div className="lock-row">
                <button
                  type="button"
                  className={"lock-btn" + (locked === "price" ? " on" : "")}
                  title={locked === "price" ? "Unlock Price" : "Lock Price (hold fixed)"}
                  aria-label={locked === "price" ? "Unlock Price" : "Lock Price"}
                  aria-pressed={locked === "price"}
                  onClick={() => toggleLock("price")}
                >
                  <LockIcon locked={locked === "price"} />
                </button>
                <input
                  style={{ flex: 1 }}
                  value={priceDisplay}
                  disabled={locked === "price"}
                  onChange={(e) => editTradeField("price", e.target.value)}
                />
                <button
                  type="button"
                  className="price-lookup-btn"
                  title={
                    locked === "price"
                      ? "Unlock Price to look it up"
                      : lookupSymbol
                        ? `Look up ${lookupSymbol} price on ${date}`
                        : "Enter a ticker symbol to look up its price"
                  }
                  aria-label="Look up price on the selected date"
                  disabled={priceLookupBusy || !lookupSymbol || locked === "price"}
                  onClick={() => void lookupPriceOnDate()}
                >
                  <GlobeIcon />
                </button>
              </div>
              {(priceLookupBusy || priceLookupMsg) && (
                <div className="account-type" style={{ marginTop: 2 }}>
                  {priceLookupBusy ? "Looking up price…" : priceLookupMsg}
                </div>
              )}
            </div>
            <div className="field">
              <label>
                {isAdd ? "Amount (shares × price) (optional)" : "Amount (shares × price)"}
                {locked === "amount" ? " (locked)" : ""}
              </label>
              <div className="lock-row">
                <button
                  type="button"
                  className={"lock-btn" + (locked === "amount" ? " on" : "")}
                  title={locked === "amount" ? "Unlock Amount" : "Lock Amount (hold fixed)"}
                  aria-label={locked === "amount" ? "Unlock Amount" : "Lock Amount"}
                  aria-pressed={locked === "amount"}
                  onClick={() => toggleLock("amount")}
                >
                  <LockIcon locked={locked === "amount"} />
                </button>
                <input
                  style={{ flex: 1 }}
                  value={amountDisplay}
                  disabled={locked === "amount"}
                  onChange={(e) => editTradeField("amount", e.target.value)}
                />
              </div>
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
            <option value="">— Not categorized —</option>
            {expenseCategoryChoices.map((o) => (
              <option key={o.category.id} value={o.category.id}>
                {o.display}
              </option>
            ))}
          </select>
        </div>

        {isAdd && (
          <div className="field">
            <label>Reason / source (memo)</label>
            <input
              value={memo}
              placeholder="e.g. Opening holdings, Gift from…, Transfer from…"
              onChange={(e) => setMemo(e.target.value)}
            />
          </div>
        )}

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
