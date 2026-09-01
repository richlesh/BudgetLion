import type { Account } from "../shared/types";
import { bpsToPercent, displaySign, formatCents, isLiability } from "../core/money";

interface Props {
  account: Account;
  onClose: () => void;
}

const TYPE_LABELS: Record<Account["type"], string> = {
  checking: "Checking",
  savings: "Savings",
  credit_card: "Credit Card",
  loan: "Loan / Mortgage",
  investment: "Investment",
  asset: "Asset",
};

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="field">
      <label>{label}</label>
      <div>{value || "—"}</div>
    </div>
  );
}

/** Read-only view of an account's fields. */
export function ViewAccountDialog({ account, onClose }: Props) {
  const openingDisplay = formatCents(
    account.openingBalanceCents * displaySign(account.type),
    account.currency
  );
  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <div className="dialog" onClick={(e) => e.stopPropagation()}>
        <h3>Account details</h3>
        <Row label="Name" value={account.name} />
        <Row label="Type" value={TYPE_LABELS[account.type]} />
        <Row label="Account ID" value={account.accountCode ?? ""} />
        <Row label="Currency" value={account.currency} />
        {isLiability(account.type) && (
          <Row
            label="Annual interest rate"
            value={account.interestRateBps != null ? `${bpsToPercent(account.interestRateBps)}%` : ""}
          />
        )}
        <Row label="Opening balance" value={openingDisplay} />
        <Row label="Opening balance date" value={account.openingBalanceDate ?? ""} />
        <div className="dialog-actions">
          <button onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}
