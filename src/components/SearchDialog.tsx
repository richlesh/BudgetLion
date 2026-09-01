import { useMemo, useState } from "react";
import type { Account, Category } from "../shared/types";
import { categoryOptions } from "../core/categories";
import { parseCents } from "../core/money";
import type { SearchCriteria } from "../core/search";
import { isEmptyCriteria } from "../core/search";

interface Props {
  accounts: Account[];
  categories: Category[];
  /** Prefill the account scope (e.g. the currently-selected account), or null for ALL. */
  initialAccountId?: string | null;
  onCancel: () => void;
  onSearch: (criteria: SearchCriteria) => void;
}

/**
 * Search across the whole database. Every field is optional; only filled fields
 * constrain the results (empty fields are ignored). Account defaults to ALL.
 */
export function SearchDialog({ accounts, categories, initialAccountId = null, onCancel, onSearch }: Props) {
  const [accountId, setAccountId] = useState<string>(initialAccountId ?? "");
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const [payee, setPayee] = useState("");
  const [memo, setMemo] = useState("");
  const [categoryId, setCategoryId] = useState("");
  const [amount, setAmount] = useState("");
  const [error, setError] = useState<string | null>(null);

  const catChoices = useMemo(() => categoryOptions(categories), [categories]);

  function submit() {
    const amt = amount.trim() ? parseCents(amount) : null;
    if (amount.trim() && amt == null) {
      setError("Enter a valid amount, or leave it blank.");
      return;
    }
    const criteria: SearchCriteria = {
      accountId: accountId || null,
      startDate: startDate || null,
      endDate: endDate || null,
      payee,
      memo,
      categoryId,
      amountCents: amt,
    };
    if (isEmptyCriteria(criteria)) {
      setError("Enter at least one search field.");
      return;
    }
    onSearch(criteria);
  }

  return (
    <div className="dialog-backdrop" onClick={onCancel}>
      <div className="dialog" style={{ width: 460 }} onClick={(e) => e.stopPropagation()}>
        <h3>Search Transactions</h3>
        <div className="account-type" style={{ marginTop: 0 }}>
          Fill any fields to narrow the search; empty fields are ignored.
        </div>

        <div className="field">
          <label>Account</label>
          <select value={accountId} onChange={(e) => setAccountId(e.target.value)}>
            <option value="">All accounts</option>
            {accounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
        </div>

        <div style={{ display: "flex", gap: 8 }}>
          <div className="field" style={{ flex: 1 }}>
            <label>From date</label>
            <input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} />
          </div>
          <div className="field" style={{ flex: 1 }}>
            <label>To date</label>
            <input type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} />
          </div>
        </div>

        <div className="field">
          <label>Payee contains</label>
          <input value={payee} onChange={(e) => setPayee(e.target.value)} />
        </div>

        <div className="field">
          <label>Memo contains</label>
          <input value={memo} onChange={(e) => setMemo(e.target.value)} />
        </div>

        <div className="field">
          <label>Category</label>
          <select value={categoryId} onChange={(e) => setCategoryId(e.target.value)}>
            <option value="">Any category</option>
            {catChoices.map((o) => (
              <option key={o.category.id} value={o.category.id}>
                {o.display}
              </option>
            ))}
          </select>
        </div>

        <div className="field">
          <label>Amount</label>
          <input
            value={amount}
            placeholder="e.g. 42.00"
            onChange={(e) => setAmount(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && submit()}
          />
        </div>

        {error && <div className="error">{error}</div>}

        <div className="dialog-actions">
          <button className="secondary" onClick={onCancel}>
            Cancel
          </button>
          <button onClick={submit}>Search</button>
        </div>
      </div>
    </div>
  );
}
