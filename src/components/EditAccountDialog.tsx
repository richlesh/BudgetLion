import { useState } from "react";
import type { Account, AccountType, UpdateAccountInput } from "../shared/types";
import { bpsToPercent, displaySign, formatCents, isLiability, parseCents, percentToBps } from "../core/money";

interface Props {
  account: Account;
  onCancel: () => void;
  onSave: (update: UpdateAccountInput) => void;
}

const TYPES: { value: AccountType; label: string }[] = [
  { value: "checking", label: "Checking" },
  { value: "savings", label: "Savings" },
  { value: "credit_card", label: "Credit Card" },
  { value: "loan", label: "Loan / Mortgage" },
  { value: "investment", label: "Investment" },
  { value: "asset", label: "Asset" },
];

/**
 * Edit an existing account's fields. The opening balance is shown using the same
 * display-sign convention as the ledger (liability debts shown positive) and
 * flipped back to the stored convention on save.
 */
export function EditAccountDialog({ account, onCancel, onSave }: Props) {
  const [name, setName] = useState(account.name);
  const [type, setType] = useState<AccountType>(account.type);
  const [accountCode, setAccountCode] = useState(account.accountCode ?? "");
  const [currency, setCurrency] = useState(account.currency);
  const [opening, setOpening] = useState(
    // Show in display-sign space (e.g. a credit-card debt as a positive number).
    formatCents(account.openingBalanceCents * displaySign(account.type), account.currency)
  );
  const [openingDate, setOpeningDate] = useState(account.openingBalanceDate ?? "");
  const [interestRate, setInterestRate] = useState(bpsToPercent(account.interestRateBps));
  const [escrow, setEscrow] = useState(
    account.escrowPaymentCents != null
      ? formatCents(account.escrowPaymentCents, account.currency)
      : ""
  );
  const [error, setError] = useState<string | null>(null);

  function submit() {
    if (!name.trim()) {
      setError("Name is required.");
      return;
    }
    const entered = parseCents(opening);
    if (entered == null) {
      setError("Enter a valid opening balance.");
      return;
    }
    // Flip the entered amount back to the stored convention based on the chosen type.
    const storedOpening = entered * displaySign(type);
    onSave({
      id: account.id,
      name: name.trim(),
      type,
      accountCode: accountCode.trim() || null,
      currency: currency.trim() || "USD",
      openingBalanceCents: storedOpening,
      openingBalanceDate: openingDate || null,
      // Interest rate applies only to liability accounts; cleared otherwise.
      interestRateBps: isLiability(type) ? percentToBps(interestRate) : null,
      // Escrow applies to a mortgage (loan); cleared for other types, null if blank.
      escrowPaymentCents: type === "loan" ? parseCents(escrow) : null,
    });
  }

  return (
    <div className="dialog-backdrop" onClick={onCancel}>
      <div className="dialog" onClick={(e) => e.stopPropagation()}>
        <h3>Edit account</h3>
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
        {isLiability(type) && (
          <div className="field">
            <label>Annual interest rate (%)</label>
            <input value={interestRate} onChange={(e) => setInterestRate(e.target.value)} />
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
        <div className="field">
          <label>Account ID (optional)</label>
          <input value={accountCode} onChange={(e) => setAccountCode(e.target.value)} />
        </div>
        <div className="field">
          <label>Currency</label>
          <input value={currency} onChange={(e) => setCurrency(e.target.value)} />
        </div>
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
        {error && <div className="error">{error}</div>}
        <div className="dialog-actions">
          <button className="secondary" onClick={onCancel}>
            Cancel
          </button>
          <button onClick={submit}>Save</button>
        </div>
      </div>
    </div>
  );
}
