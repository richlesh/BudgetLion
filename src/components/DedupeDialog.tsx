import { useState } from "react";
import type {
  Account,
  Category,
  Transaction,
  TransactionSplit,
} from "../shared/types";
import { formatCents } from "../core/money";

interface Props {
  /** The two transactions detected as potential duplicates. */
  a: Transaction;
  b: Transaction;
  /** Currency for formatting amounts (from the active account). */
  currency: string;
  /** All accounts, for resolving from/to names. */
  accounts: Account[];
  /** All categories, for resolving the category name of a non-transfer. */
  categories: Category[];
  /** Split legs per transaction id, for detecting split transactions. */
  splitsByTx: Map<string, TransactionSplit[]>;
  /** The scanned account id, used to orient transfer direction (To/From). */
  accountId: string | null;
  /** Progress indicator, e.g. "1 of 3". */
  progressLabel: string;
  /** Delete the chosen transaction (by id), then advance. */
  onDelete: (id: string) => void;
  /** Skip this pair without deleting. */
  onSkip: () => void;
  /** Cancel the whole de-dupe pass. */
  onClose: () => void;
}

/**
 * Review dialog for a single duplicate pair. The user must pick one transaction
 * (radio) before "Delete" is enabled. "Skip" leaves both and moves on; "Close"
 * ends the de-duplication pass.
 */
export function DedupeDialog({
  a,
  b,
  currency,
  accounts,
  categories,
  splitsByTx,
  accountId,
  progressLabel,
  onDelete,
  onSkip,
  onClose,
}: Props) {
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const acctName = (id: string | null) =>
    id ? accounts.find((x) => x.id === id)?.name ?? "(unknown)" : null;

  const catName = (id: string | null) =>
    id ? categories.find((c) => c.id === id)?.name ?? "(unknown)" : null;

  // The Category / To account / "Split" display line for a transaction, mirroring
  // the ledger's Category cell: split transactions show "Split"; transfers show
  // the counterparty account (oriented To/From relative to the scanned account);
  // otherwise the assigned category name (or "Uncategorized").
  const categoryDisplay = (t: Transaction): string => {
    const splits = splitsByTx.get(t.id);
    if (splits && splits.length > 0) return "Split";
    const isTransfer = !!(t.fromAccountId && t.toAccountId);
    if (isTransfer) {
      if (accountId && t.fromAccountId === accountId) {
        return `To ${acctName(t.toAccountId) ?? "account"}`;
      }
      if (accountId && t.toAccountId === accountId) {
        return `From ${acctName(t.fromAccountId) ?? "account"}`;
      }
      // Not oriented to the scanned account: show the destination side.
      return `To ${acctName(t.toAccountId) ?? "account"}`;
    }
    return catName(t.categoryId) ?? "Uncategorized";
  };

  const renderCard = (t: Transaction) => {
    const from = acctName(t.fromAccountId);
    const to = acctName(t.toAccountId);
    const selected = selectedId === t.id;
    return (
      <label
        className={"dedupe-card" + (selected ? " selected" : "")}
        style={{
          flex: 1,
          border: "1px solid var(--border)",
          borderRadius: 8,
          padding: 10,
          cursor: "pointer",
          display: "block",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
          <input
            type="radio"
            name="dedupe-choice"
            checked={selected}
            onChange={() => setSelectedId(t.id)}
          />
          <strong>Delete this one</strong>
        </div>
        <Row label="Date" value={t.date} />
        <Row label="Payee" value={t.payee ?? "—"} />
        <Row label="Amount" value={formatCents(t.amountCents, currency)} />
        <Row label="Category" value={categoryDisplay(t)} />
        {from && <Row label="From" value={from} />}
        {to && <Row label="To" value={to} />}
        <Row label="Memo" value={t.memo ?? "—"} />
      </label>
    );
  };

  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <div className="dialog" style={{ width: 620 }} onClick={(e) => e.stopPropagation()}>
        <h3>Possible Duplicate ({progressLabel})</h3>
        <p style={{ marginTop: 0 }} className="account-type">
          These two transactions look like duplicates. Select the one to delete, or skip.
        </p>

        <div style={{ display: "flex", gap: 12 }}>
          {renderCard(a)}
          {renderCard(b)}
        </div>

        <div className="dialog-actions" style={{ justifyContent: "space-between" }}>
          <button className="secondary" onClick={onClose}>
            Close
          </button>
          <div style={{ display: "flex", gap: 8 }}>
            <button className="secondary" onClick={onSkip}>
              Skip
            </button>
            <button
              className="danger"
              disabled={selectedId === null}
              onClick={() => selectedId && onDelete(selectedId)}
            >
              Delete
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", gap: 8, fontSize: 13 }}>
      <span className="account-type" style={{ textTransform: "none" }}>
        {label}
      </span>
      <span style={{ textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{value}</span>
    </div>
  );
}
