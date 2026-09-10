import { useState } from "react";
import type { Account, AccountType, Category, NewAccountInput } from "../shared/types";
import { displaySign, parseCents, percentToBps } from "../core/money";
import { categoriesForDirection, categoryOptions } from "../core/categories";

interface Props {
  categories: Category[];
  accounts: Account[];
  onCancel: () => void;
  onCreate: (input: NewAccountInput) => void;
}

const TYPES: { value: AccountType; label: string }[] = [
  { value: "checking", label: "Checking" },
  { value: "savings", label: "Savings" },
  { value: "credit_card", label: "Credit Card" },
  { value: "loan", label: "Loan / Mortgage" },
  { value: "installment", label: "Installment / BNPL" },
  { value: "investment", label: "Investment" },
  { value: "asset", label: "Asset" },
];

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

export function NewAccountDialog({ categories, accounts, onCancel, onCreate }: Props) {
  const [name, setName] = useState("");
  const [type, setType] = useState<AccountType>("checking");
  const [accountCode, setAccountCode] = useState("");
  const [opening, setOpening] = useState("0.00");
  const [openingDate, setOpeningDate] = useState(today());
  const [interestRate, setInterestRate] = useState("");
  const [escrow, setEscrow] = useState("");
  // Escrow destination: "" = default Escrow category, else "cat:<id>" | "acct:<id>".
  const [escrowTarget, setEscrowTarget] = useState("");
  const [paymentAllocation, setPaymentAllocation] = useState<"per_plan" | "waterfall_soonest">(
    "waterfall_soonest"
  );
  const [error, setError] = useState<string | null>(null);

  const expenseCats = categoryOptions(categoriesForDirection(categories, "expense"));

  function submit() {
    if (!name.trim()) {
      setError("Name is required.");
      return;
    }
    const entered = parseCents(opening) ?? 0;
    // For liability accounts (credit card / loan) the user enters the opening
    // balance as a positive debt. Internally a debt is a negative balance, so we
    // flip the entered sign to match the storage convention. This mirrors the
    // display-side sign flip in the ledger grid.
    const cents = entered * displaySign(type);
    // Asset accounts are pure holdings (no cash): never carry an opening balance.
    const isAsset = type === "asset";
    onCreate({
      name: name.trim(),
      type,
      accountCode: accountCode.trim() || null,
      openingBalanceCents: isAsset ? 0 : cents,
      openingBalanceDate: isAsset ? null : openingDate || null,
      // Interest rate applies to credit-card/loan (installment plans carry their
      // own per-plan rate); stored in basis points.
      interestRateBps: type === "credit_card" || type === "loan" ? percentToBps(interestRate) : null,
      // Escrow applies to a mortgage (loan); blank => null.
      escrowPaymentCents: type === "loan" ? parseCents(escrow) : null,
      escrowTarget: type === "loan" ? escrowTarget || null : null,
      // Installment/BNPL payment allocation strategy (null for other types).
      paymentAllocation: type === "installment" ? paymentAllocation : null,
    });
  }

  return (
    <div className="dialog-backdrop" onClick={onCancel}>
      <div className="dialog" onClick={(e) => e.stopPropagation()}>
        <h3>New Account</h3>
        <div className="field">
          <label>Name</label>
          <input value={name} autoFocus onChange={(e) => setName(e.target.value)} />
        </div>
        <div className="field">
          <label>Type</label>
          <select value={type} onChange={(e) => setType(e.target.value as AccountType)}>
            {TYPES.map((t) => (
              <option key={t.value} value={t.value}>
                {t.label}
              </option>
            ))}
          </select>
        </div>
        {(type === "credit_card" || type === "loan") && (
          <div className="field">
            <label>Annual interest rate (%)</label>
            <input
              value={interestRate}
              onChange={(e) => setInterestRate(e.target.value)}
              placeholder="e.g. 4.25"
            />
          </div>
        )}
        {type === "installment" && (
          <div className="field">
            <label>Payment allocation</label>
            <select
              value={paymentAllocation}
              onChange={(e) => setPaymentAllocation(e.target.value as "per_plan" | "waterfall_soonest")}
            >
              <option value="per_plan">Per plan (each plan paid separately — e.g. Affirm)</option>
              <option value="waterfall_soonest">
                Waterfall (one payment, soonest-expiring first — e.g. PayPal Pay Later)
              </option>
            </select>
          </div>
        )}
        {type === "loan" && (
          <div className="field">
            <label>Escrow payment (optional)</label>
            <input
              value={escrow}
              onChange={(e) => setEscrow(e.target.value)}
              placeholder="monthly escrow, e.g. 350.00"
            />
          </div>
        )}
        {type === "loan" && (
          <div className="field">
            <label>Escrow goes to</label>
            <select value={escrowTarget} onChange={(e) => setEscrowTarget(e.target.value)}>
              <option value="">— Escrow (expense category) —</option>
              <optgroup label="Categories">
                {expenseCats.map((o) => (
                  <option key={o.category.id} value={`cat:${o.category.id}`}>
                    {o.display}
                  </option>
                ))}
              </optgroup>
              <optgroup label="Transfer to account">
                {accounts.map((a) => (
                  <option key={a.id} value={`acct:${a.id}`}>
                    {a.name}
                  </option>
                ))}
              </optgroup>
            </select>
          </div>
        )}
        <div className="field">
          <label>Account ID (optional)</label>
          <input
            value={accountCode}
            onChange={(e) => setAccountCode(e.target.value)}
            placeholder="e.g. bank account number or external id"
          />
        </div>
        {type !== "asset" && (
          <>
            <div className="field">
              <label>Opening balance</label>
              <input value={opening} onChange={(e) => setOpening(e.target.value)} />
            </div>
            <div className="field">
              <label>Opening balance date</label>
              <input
                type="date"
                value={openingDate}
                onChange={(e) => setOpeningDate(e.target.value)}
              />
            </div>
          </>
        )}
        {error && <div className="error">{error}</div>}
        <div className="dialog-actions">
          <button className="secondary" onClick={onCancel}>
            Cancel
          </button>
          <button onClick={submit}>Create</button>
        </div>
      </div>
    </div>
  );
}
