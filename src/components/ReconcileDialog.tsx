import { useMemo, useState } from "react";
import type { Account, Category, LedgerRow, ReconcileInput, ReconcileAdjustment } from "../shared/types";
import { formatCents, parseCents, isLiability, displaySign } from "../core/money";
import { categoryOptions, categoryDisplayName } from "../core/categories";
import { isReconciledForAccount } from "../core/reconcile";

interface Props {
  account: Account;
  /** The account's ledger rows (to list unreconciled transactions). */
  rows: LedgerRow[];
  categories: Category[];
  onCancel: () => void;
  /** Persist: mark the checked ids reconciled + create adjustments. */
  onReconcile: (input: ReconcileInput) => void | Promise<void>;
}

/** One adjustment set (Interest / Fees / Adjustment) as edited in the UI. */
interface AdjRow {
  enabled: boolean;
  date: string;
  description: string;
  amount: string; // positive magnitude typed; sign applied per kind
  categoryId: string;
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Find a category id by its full display name (e.g. "Interest:Income"), or "". */
function findCategoryId(categories: Category[], displayName: string): string {
  for (const c of categories) {
    if (c.deletedAt == null && categoryDisplayName(c, categories).toLowerCase() === displayName.toLowerCase()) {
      return c.id;
    }
  }
  return "";
}

/**
 * Reconcile an account: check off transactions that have cleared, and optionally
 * add interest, fee, and adjustment entries. Checked transactions (and any
 * created adjustments) are marked reconciled.
 */
export function ReconcileDialog({ account, rows, categories, onCancel, onReconcile }: Props) {
  const currency = account.currency;
  const catChoices = useMemo(() => categoryOptions(categories), [categories]);

  // Unreconciled real transactions on THIS account's side (exclude the opening row).
  const unreconciled = useMemo(
    () =>
      rows.filter(
        (r) => r.kind === "transaction" && r.transaction && !isReconciledForAccount(r.transaction, account.id, r.splits)
      ),
    [rows, account.id]
  );

  // Default: every unreconciled row checked (i.e. it has cleared).
  const [checked, setChecked] = useState<Set<string>>(
    () => new Set(unreconciled.map((r) => r.transaction!.id))
  );

  // Default categories per the account type.
  const interestCat = isLiability(account.type)
    ? findCategoryId(categories, "Interest:Expense")
    : findCategoryId(categories, "Interest:Income");
  const feeCat = findCategoryId(categories, "Bank Fee");

  const [interest, setInterest] = useState<AdjRow>({
    enabled: false, date: today(), description: "Interest", amount: "", categoryId: interestCat,
  });
  const [fees, setFees] = useState<AdjRow>({
    enabled: false, date: today(), description: "Fees", amount: "", categoryId: feeCat,
  });
  const [adjustment, setAdjustment] = useState<AdjRow>({
    enabled: false, date: today(), description: "Adjustment", amount: "", categoryId: "",
  });
  const [error, setError] = useState<string | null>(null);

  function toggle(id: string, on: boolean) {
    setChecked((prev) => {
      const next = new Set(prev);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  }

  // Signed (stored) magnitude of an enabled adjustment, per its kind.
  function adjSigned(r: AdjRow, kind: "interest" | "fees" | "adjustment"): number {
    if (!r.enabled) return 0;
    const cents = parseCents(r.amount);
    if (cents == null) return 0;
    const mag = Math.abs(cents);
    return kind === "interest" ? mag : kind === "fees" ? -mag : cents;
  }

  // Reconciled balance = opening balance + already-reconciled rows + the checked
  // (about-to-be-reconciled) rows + any enabled adjustments. Shown with the
  // account's display sign so it matches the ledger/statement.
  const reconciledBalance = useMemo(() => {
    let cents = account.openingBalanceCents;
    for (const r of rows) {
      if (r.kind === "opening") continue;
      const t = r.transaction;
      if (!t) continue;
      if (isReconciledForAccount(t, account.id, r.splits)) cents += r.signedAmountCents;
      else if (checked.has(t.id)) cents += r.signedAmountCents;
    }
    cents += adjSigned(interest, "interest") + adjSigned(fees, "fees") + adjSigned(adjustment, "adjustment");
    return cents * displaySign(account.type);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, checked, interest, fees, adjustment, account.openingBalanceCents, account.type, account.id]);

  // Build an adjustment (interest/fees positive = inflow/outflow per kind).
  // Interest is income (inflow, +); Fees are an expense (outflow, −); Adjustment
  // takes the user's sign (they can type a negative).
  function buildAdj(r: AdjRow, kind: "interest" | "fees" | "adjustment"): ReconcileAdjustment | null {
    if (!r.enabled) return null;
    const cents = parseCents(r.amount);
    if (cents == null || cents === 0) return null;
    const magnitude = Math.abs(cents);
    const signed =
      kind === "interest" ? magnitude : kind === "fees" ? -magnitude : cents; // adjustment keeps sign
    return {
      date: r.date,
      description: r.description.trim() || null,
      amountCents: signed,
      categoryId: r.categoryId || null,
    };
  }

  async function submit() {
    setError(null);
    const adjustments = [
      buildAdj(interest, "interest"),
      buildAdj(fees, "fees"),
      buildAdj(adjustment, "adjustment"),
    ].filter((a): a is ReconcileAdjustment => a !== null);
    // Validate enabled sets have a valid amount.
    for (const [r, label] of [[interest, "Interest"], [fees, "Fees"], [adjustment, "Adjustment"]] as const) {
      if (r.enabled && (parseCents(r.amount) == null || parseCents(r.amount) === 0)) {
        setError(`Enter a nonzero amount for ${label}, or uncheck it.`);
        return;
      }
    }
    try {
      await onReconcile({
        accountId: account.id,
        reconcileIds: Array.from(checked),
        adjustments,
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not reconcile.");
    }
  }

  const adjSet = (
    label: string,
    r: AdjRow,
    set: (v: AdjRow) => void,
    kind: "interest" | "fees" | "adjustment"
  ) => (
    <div className="paycheck-section">
      <div className="paycheck-section-head">
        <label style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <input
            type="checkbox"
            checked={r.enabled}
            onChange={(e) => set({ ...r, enabled: e.target.checked })}
            style={{ width: "auto" }}
          />
          <strong>{label}</strong>
        </label>
        <span className="account-type">
          {kind === "interest" ? "added as income/expense" : kind === "fees" ? "expense (outflow)" : "signed adjustment"}
        </span>
      </div>
      {r.enabled && (
        <div className="paycheck-row">
          <input type="date" value={r.date} onChange={(e) => set({ ...r, date: e.target.value })} />
          <input
            value={r.description}
            placeholder="Description"
            onChange={(e) => set({ ...r, description: e.target.value })}
            style={{ flex: 1 }}
          />
          <input
            value={r.amount}
            placeholder="0.00"
            onChange={(e) => set({ ...r, amount: e.target.value })}
            style={{ width: 90, textAlign: "right" }}
          />
          <select
            value={r.categoryId}
            onChange={(e) => set({ ...r, categoryId: e.target.value })}
            style={{ flex: 1 }}
          >
            <option value="">— Uncategorized —</option>
            {catChoices.map((o) => (
              <option key={o.category.id} value={o.category.id}>{o.display}</option>
            ))}
          </select>
        </div>
      )}
    </div>
  );

  return (
    <div className="dialog-backdrop" onClick={onCancel}>
      <div className="dialog" style={{ width: "min(720px, 94vw)" }} onClick={(e) => e.stopPropagation()}>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <h3 style={{ margin: 0 }}>Reconcile — {account.name}</h3>
          <span className="account-type">{checked.size} of {unreconciled.length} checked</span>
          <span style={{ flex: 1 }} />
          <div className="nwr-net" style={{ margin: 0, fontSize: 16 }}>
            Reconciled balance: {formatCents(reconciledBalance, currency)}
          </div>
        </div>

        <div style={{ maxHeight: "42vh", overflow: "auto", border: "1px solid var(--border)", borderRadius: 6 }}>
          <table className="holdings-table">
            <thead>
              <tr>
                <th style={{ width: 28, textAlign: "center" }}>
                  <input
                    type="checkbox"
                    aria-label="Check all"
                    checked={unreconciled.length > 0 && checked.size === unreconciled.length}
                    ref={(el) => {
                      if (el) el.indeterminate = checked.size > 0 && checked.size < unreconciled.length;
                    }}
                    onChange={(e) =>
                      setChecked(e.target.checked ? new Set(unreconciled.map((r) => r.transaction!.id)) : new Set())
                    }
                    style={{ width: "auto" }}
                  />
                </th>
                <th>Date</th>
                <th>Payee</th>
                <th className="num">Amount</th>
              </tr>
            </thead>
            <tbody>
              {unreconciled.length === 0 ? (
                <tr><td colSpan={4} className="account-type">No unreconciled transactions.</td></tr>
              ) : (
                unreconciled.map((r) => {
                  const t = r.transaction!;
                  return (
                    <tr key={t.id}>
                      <td style={{ textAlign: "center" }}>
                        <input
                          type="checkbox"
                          checked={checked.has(t.id)}
                          onChange={(e) => toggle(t.id, e.target.checked)}
                          style={{ width: "auto" }}
                        />
                      </td>
                      <td>{t.date}</td>
                      <td>{t.payee ?? ""}</td>
                      <td className="num">{formatCents(r.signedAmountCents, currency)}</td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>

        {adjSet("Interest", interest, setInterest, "interest")}
        {adjSet("Fees", fees, setFees, "fees")}
        {adjSet("Adjustment", adjustment, setAdjustment, "adjustment")}

        {error && <div className="error">{error}</div>}
        <div className="dialog-actions">
          <button className="secondary" onClick={onCancel}>Cancel</button>
          <button onClick={submit}>Reconcile</button>
        </div>
      </div>
    </div>
  );
}
