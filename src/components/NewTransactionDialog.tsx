import { useMemo, useState } from "react";
import type { Account, Category, NewTransactionInput } from "../shared/types";
import { parseCents } from "../core/money";
import { validateTransaction } from "../core/validation";
import { categoriesForDirection, categoryOptions } from "../core/categories";
import { AutocompleteInput } from "./AutocompleteInput";

interface Props {
  account: Account; // the account whose ledger we're editing
  accounts: Account[]; // for transfer target selection
  categories: Category[];
  /** Distinct prior payees in this account, for autocomplete. */
  payeeSuggestions?: string[];
  /** Distinct prior memos in this account, for autocomplete. */
  memoSuggestions?: string[];
  onCancel: () => void;
  onCreate: (input: NewTransactionInput) => void;
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Simplified M1 entry: pick a direction relative to the current account.
 *  - "out": money leaves this account (expense or transfer out)
 *  - "in":  money enters this account (income or transfer in)
 * Optional transfer target maps to the other account side.
 */
export function NewTransactionDialog({
  account,
  accounts,
  categories,
  payeeSuggestions = [],
  memoSuggestions = [],
  onCancel,
  onCreate,
}: Props) {
  const [date, setDate] = useState(today());
  const [payee, setPayee] = useState("");
  const [memo, setMemo] = useState("");
  const [amount, setAmount] = useState("0.00");
  const [direction, setDirection] = useState<"out" | "in">("out");
  const [transferId, setTransferId] = useState<string>("");
  const [categoryId, setCategoryId] = useState<string>("");
  const [error, setError] = useState<string | null>(null);

  const otherAccounts = accounts.filter((a) => a.id !== account.id);

  // Only show categories valid for the chosen direction (out=expense, in=income),
  // rendered with full Parent:Child display names.
  const categoryChoices = useMemo(
    () =>
      categoryOptions(
        categoriesForDirection(categories, direction === "out" ? "expense" : "income")
      ),
    [categories, direction]
  );
  // A transfer is when the user picks another tracked account as the counterparty.
  // Transfers don't take a payee: it's auto-generated from the other account on display.
  const isTransfer = transferId !== "";

  function submit() {
    const cents = parseCents(amount);
    if (cents == null) {
      setError("Enter a valid amount.");
      return;
    }
    const magnitude = Math.abs(cents);

    // Determine from/to based on direction and optional transfer target.
    let fromAccountId: string | null = null;
    let toAccountId: string | null = null;
    if (direction === "out") {
      fromAccountId = account.id;
      toAccountId = transferId || null;
    } else {
      toAccountId = account.id;
      fromAccountId = transferId || null;
    }

    const input: NewTransactionInput = {
      date,
      // Transfers never carry a user payee; the ledger shows "From/To <account>".
      payee: isTransfer ? null : payee.trim() || null,
      memo: memo.trim() || null,
      amountCents: magnitude,
      fromAccountId,
      toAccountId,
      // A transfer between two tracked accounts doesn't need a category.
      categoryId: transferId ? null : categoryId || null,
    };

    const result = validateTransaction(input);
    if (!result.ok) {
      setError(result.errors.join(" "));
      return;
    }
    onCreate(input);
  }

  return (
    <div className="dialog-backdrop" onClick={onCancel}>
      <div className="dialog" onClick={(e) => e.stopPropagation()}>
        <h3>New Transaction</h3>
        <div className="field">
          <label>Date</label>
          <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
        </div>
        <div className="field">
          <label>Direction</label>
          <select
            value={direction}
            onChange={(e) => {
              const dir = e.target.value as "out" | "in";
              setDirection(dir);
              // Drop a selected category that isn't valid for the new direction.
              if (categoryId) {
                const stillValid = categoriesForDirection(
                  categories,
                  dir === "out" ? "expense" : "income"
                ).some((c) => c.id === categoryId);
                if (!stillValid) setCategoryId("");
              }
            }}
          >
            <option value="out">Money out (payment / expense)</option>
            <option value="in">Money in (deposit / income)</option>
          </select>
        </div>
        <div className="field">
          <label>Transfer to/from account (optional)</label>
          <select value={transferId} onChange={(e) => setTransferId(e.target.value)}>
            <option value="">— External (not a tracked account) —</option>
            {otherAccounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
        </div>
        {!transferId && (
          <div className="field">
            <label>Category (optional)</label>
            <select value={categoryId} onChange={(e) => setCategoryId(e.target.value)}>
              <option value="">— Uncategorized —</option>
              {categoryChoices.map((o) => (
                <option key={o.category.id} value={o.category.id}>
                  {o.display}
                </option>
              ))}
            </select>
          </div>
        )}
        <div className="field">
          <label>Payee</label>
          {isTransfer ? (
            <input
              value="(auto — transfer)"
              disabled
              title="Transfers don't use a payee; the ledger shows the other account."
            />
          ) : (
            <AutocompleteInput
              value={payee}
              onChange={setPayee}
              suggestions={payeeSuggestions}
            />
          )}
        </div>
        <div className="field">
          <label>Memo</label>
          <AutocompleteInput value={memo} onChange={setMemo} suggestions={memoSuggestions} />
        </div>
        <div className="field">
          <label>Amount</label>
          <input value={amount} autoFocus onChange={(e) => setAmount(e.target.value)} />
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
