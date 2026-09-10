import { useCallback, useEffect, useMemo, useState } from "react";
import type {
  Account,
  Category,
  NewSplitInput,
  NewTransactionInput,
  PlanBalance,
} from "../shared/types";
import { formatCents, parseCents } from "../core/money";
import { allocatePayment, allocateToPlan, matchesPlanInstallment } from "../core/installment";
import { categoriesForDirection, categoryOptions } from "../core/categories";

interface Props {
  account: Account; // the installment / BNPL account being paid
  accounts: Account[]; // funding-account candidates
  categories: Category[]; // for the interest expense category
  /**
   * When set, the dialog is CATEGORIZING an existing transfer (e.g. an imported
   * checking transaction pointed at this installment account) rather than
   * creating a new payment. The amount and funding account are pre-filled and
   * locked; on submit `onApplyToExisting` is called instead of `onSubmit`.
   */
  existingTx?: { id: string; amountCents: number; date: string; fromAccountId: string | null } | null;
  onCancel: () => void;
  onSubmit: (input: NewTransactionInput) => void | Promise<void>;
  onApplyToExisting?: (txId: string, splits: NewSplitInput[]) => void | Promise<void>;
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Apply a payment to an installment/BNPL account. The account's allocation mode
 * (per_plan or waterfall_soonest) decides how the payment is distributed across
 * its plans; the result is previewed and posted as a multi-leg split: principal
 * legs are transfers into this account tagged with each plan_id, and interest
 * legs are a categorized expense.
 */
export function PlanPaymentDialog({ account, accounts, categories, existingTx, onCancel, onSubmit, onApplyToExisting }: Props) {
  const [plans, setPlans] = useState<PlanBalance[]>([]);
  const [amount, setAmount] = useState(
    existingTx ? (Math.abs(existingTx.amountCents) / 100).toFixed(2) : ""
  );
  const [date, setDate] = useState(existingTx?.date ?? today());
  const fundingAccounts = useMemo(() => accounts.filter((a) => a.id !== account.id), [accounts, account.id]);
  // "" = Unspecified (no external source — owned by the installment account).
  const [fromAccountId, setFromAccountId] = useState<string>(existingTx?.fromAccountId ?? "");
  const expenseCats = useMemo(
    () => categoryOptions(categoriesForDirection(categories, "expense")),
    [categories]
  );
  const [interestCategoryId, setInterestCategoryId] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
  // Manual plan override: "" = auto (use the account's allocation strategy); a
  // plan id = apply the whole payment to that plan. Required when the payment
  // doesn't exactly match a plan installment (see needsPlanChoice below).
  const [forcedPlanId, setForcedPlanId] = useState<string>("");
  // When true, the plan control shows the picker even though a plan is matched
  // (the user double-clicked the matched plan name to override it).
  const [pickingPlan, setPickingPlan] = useState(false);
  const editingExisting = !!existingTx;

  useEffect(() => {
    let alive = true;
    void window.ledger.planBalances(account.id).then((b) => {
      if (alive) setPlans(b);
    });
    return () => {
      alive = false;
    };
  }, [account.id]);

  // Default the interest category to the one used by the most recent prior
  // payment on this account, so recurring payments don't re-pick it each time.
  // Only applies while the user hasn't chosen a category yet.
  useEffect(() => {
    let alive = true;
    void window.ledger.planLastInterestCategory(account.id).then((catId) => {
      if (!alive || !catId) return;
      if (!categories.some((c) => c.id === catId)) return; // category deleted
      setInterestCategoryId((cur) => (cur === "" ? catId : cur));
    });
    return () => {
      alive = false;
    };
  }, [account.id, categories]);

  const paymentCents = parseCents(amount) ?? 0;

  // Active plans (positive remaining) offered in the picker.
  const activePlans = useMemo(() => plans.filter((p) => p.remainingCents > 0), [plans]);

  // Whether the payment exactly matches some plan's fixed installment.
  const exactMatch = useMemo(
    () => matchesPlanInstallment(Math.abs(paymentCents), plans),
    [paymentCents, plans]
  );

  // Live allocation preview. A manual plan override (forcedPlanId) wins; otherwise
  // use the account's strategy.
  const alloc = useMemo(
    () =>
      forcedPlanId
        ? allocateToPlan(Math.abs(paymentCents), plans, forcedPlanId)
        : allocatePayment(Math.abs(paymentCents), plans, account.paymentAllocation),
    [paymentCents, plans, account.paymentAllocation, forcedPlanId]
  );

  // User overrides for the computed principal/interest per plan, stored as the
  // RAW text the user typed (source of truth while editing) keyed by
  // `${planId}:principal|interest`. A present entry means the user edited that
  // cell; parsing it (parseCents) yields the override amount. Storing text — not
  // a re-derived number — keeps the input from fighting the caret as you type.
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  useEffect(() => {
    setDrafts({});
  }, [paymentCents, forcedPlanId, account.paymentAllocation, plans]);

  const draftKey = (planId: string, field: "principal" | "interest") => `${planId}:${field}`;

  // The effective allocation: computed values with any user text overrides applied.
  const effAlloc = useMemo(() => {
    const perPlan = alloc.perPlan.map((a) => {
      const pd = drafts[draftKey(a.planId, "principal")];
      const idr = drafts[draftKey(a.planId, "interest")];
      const pc = pd != null ? parseCents(pd) : null;
      const ic = idr != null ? parseCents(idr) : null;
      return {
        ...a,
        principalCents: pc != null ? Math.abs(pc) : a.principalCents,
        interestCents: ic != null ? Math.abs(ic) : a.interestCents,
      };
    });
    return { perPlan, unallocatedCents: alloc.unallocatedCents };
  }, [alloc, drafts]);

  // For a per_plan account, when the amount doesn't exactly match an installment
  // and the user hasn't chosen a plan, they MUST pick one — the auto-fallback
  // (soonest expiration) is only a hint, not a safe default here.
  const needsPlanChoice =
    account.paymentAllocation === "per_plan" &&
    paymentCents > 0 &&
    !exactMatch &&
    forcedPlanId === "";

  const totalInterest = effAlloc.perPlan.reduce((s, a) => s + a.interestCents, 0);
  const planById = useMemo(() => new Map(plans.map((b) => [b.plan.id, b.plan.label])), [plans]);

  const submit = useCallback(async () => {
    setError(null);
    if (paymentCents <= 0) { setError("Enter a payment amount."); return; }
    if (needsPlanChoice) {
      setError("This amount doesn't match a plan's installment — choose which plan to apply it to.");
      return;
    }
    if (effAlloc.perPlan.length === 0) { setError("No plans to apply this payment to."); return; }

    // Categorizing an EXISTING transfer (e.g. imported checking txn) into this
    // installment account: build the plan-attributed split legs and hand them to
    // onApplyToExisting, which updates the transaction in place.
    if (editingExisting && existingTx) {
      if (effAlloc.unallocatedCents > 0) {
        setError(
          "This payment exceeds the plans' remaining balances, so it can't be fully allocated. Adjust plan balances or split it manually."
        );
        return;
      }
      if (totalInterest > 0 && !interestCategoryId) {
        setError("Choose an interest category (this payment includes interest).");
        return;
      }
      const legs: NewSplitInput[] = [];
      for (const a of effAlloc.perPlan) {
        if (a.principalCents > 0) {
          legs.push({
            amountCents: -a.principalCents,
            transferAccountId: account.id,
            planId: a.planId,
            memo: `Principal — ${planById.get(a.planId) ?? "plan"}`,
          });
        }
        if (a.interestCents > 0) {
          legs.push({
            amountCents: -a.interestCents,
            categoryId: interestCategoryId,
            planId: a.planId,
            memo: `Interest — ${planById.get(a.planId) ?? "plan"}`,
          });
        }
      }
      if (legs.length === 0) { setError("Nothing to allocate."); return; }
      await onApplyToExisting?.(existingTx.id, legs);
      return;
    }

    const unspecified = fromAccountId === "";

    if (unspecified) {
      // No external funding source: record the payment as OWNED by the installment
      // account (its balance drops as debt is paid). Principal-only — legs are
      // self-referential transfer legs tagged with plan_id, positive (owner-side
      // effect reduces the liability). Interest is skipped for these simplified
      // pre-history entries. Owner is the 'to' side, so legs sum to +applied.
      const legs: NewSplitInput[] = [];
      let applied = 0;
      for (const a of effAlloc.perPlan) {
        if (a.principalCents <= 0) continue;
        legs.push({
          amountCents: a.principalCents,
          transferAccountId: account.id,
          planId: a.planId,
          memo: `Principal — ${planById.get(a.planId) ?? "plan"}`,
        });
        applied += a.principalCents;
      }
      if (applied <= 0 || legs.length === 0) { setError("Nothing to allocate."); return; }
      await onSubmit({
        date,
        payee: account.name,
        memo: "Payment (source unspecified)",
        amountCents: applied,
        fromAccountId: null,
        toAccountId: account.id,
        categoryId: null,
        splits: legs,
      });
      return;
    }

    if (totalInterest > 0 && !interestCategoryId) {
      setError("Choose an interest category (this payment includes interest).");
      return;
    }

    // Funded by a real account. Build split legs, all negative (outflow from the
    // funding account): principal -> transfer into this installment account tagged
    // with plan_id; interest -> categorized expense.
    const legs: NewSplitInput[] = [];
    for (const a of effAlloc.perPlan) {
      if (a.principalCents > 0) {
        legs.push({
          amountCents: -a.principalCents,
          transferAccountId: account.id,
          planId: a.planId,
          memo: `Principal — ${planById.get(a.planId) ?? "plan"}`,
        });
      }
      if (a.interestCents > 0) {
        legs.push({
          amountCents: -a.interestCents,
          categoryId: interestCategoryId,
          planId: a.planId,
          memo: `Interest — ${planById.get(a.planId) ?? "plan"}`,
        });
      }
    }
    const applied = effAlloc.perPlan.reduce((s, a) => s + a.principalCents + a.interestCents, 0);
    if (applied <= 0 || legs.length === 0) { setError("Nothing to allocate."); return; }

    const input: NewTransactionInput = {
      date,
      payee: account.name,
      memo: null,
      amountCents: applied, // magnitude; direction from from/to
      fromAccountId,
      toAccountId: null,
      categoryId: null,
      splits: legs,
    };
    await onSubmit(input);
  }, [paymentCents, fromAccountId, totalInterest, interestCategoryId, effAlloc, account, date, planById, onSubmit, editingExisting, existingTx, onApplyToExisting, needsPlanChoice]);

  const currency = account.currency;
  const modeLabel = account.paymentAllocation === "per_plan" ? "Per plan" : "Waterfall (soonest first)";

  return (
    <div className="dialog-backdrop dialog-backdrop-top" onClick={onCancel}>
      <div className="dialog" style={{ width: 520 }} onClick={(e) => e.stopPropagation()}>
        <h3>Apply payment — {account.name}</h3>
        <div className="account-type" style={{ marginTop: 0 }}>
          Allocation: {modeLabel}
        </div>

        <div style={{ display: "flex", gap: 8 }}>
          <div className="field" style={{ flex: 1 }}>
            <label>Payment amount</label>
            <input value={amount} placeholder="0.00" style={{ textAlign: "right" }} disabled={editingExisting} onChange={(e) => setAmount(e.target.value)} />
          </div>
          <div className="field" style={{ flex: 1 }}>
            <label>Date</label>
            <input type="date" value={date} disabled={editingExisting} onChange={(e) => setDate(e.target.value)} />
          </div>
        </div>

        <div className="field">
          <label>Paid from</label>
          <select value={fromAccountId} disabled={editingExisting} onChange={(e) => setFromAccountId(e.target.value)}>
            <option value="">— Unspecified — (no external source)</option>
            {fundingAccounts.map((a) => (
              <option key={a.id} value={a.id}>{a.name}</option>
            ))}
          </select>
        </div>

        <div className="field">
          <label>
            Interest category{" "}
            {fromAccountId === ""
              ? "(not used — Unspecified records principal only)"
              : totalInterest === 0
                ? "(not needed — 0 interest)"
                : ""}
          </label>
          <select
            value={interestCategoryId}
            onChange={(e) => setInterestCategoryId(e.target.value)}
            disabled={fromAccountId === "" || totalInterest === 0}
          >
            <option value="">— Choose category —</option>
            {expenseCats.map((o) => (
              <option key={o.category.id} value={o.category.id}>{o.display}</option>
            ))}
          </select>
        </div>

        {/* Apply to plan — an explicit plan target. Required when the amount
            doesn't match an installment (per_plan); otherwise the auto match is
            shown and can be overridden by double-clicking the plan name. */}
        <div className="field">
          <label>
            Apply to plan{" "}
            {needsPlanChoice ? "(required — amount doesn't match an installment)" : ""}
          </label>
          {(() => {
            const showPicker = needsPlanChoice || pickingPlan || forcedPlanId !== "";
            if (!showPicker) {
              // Auto mode: show what the strategy chose. For per_plan that's the
              // matched plan; for waterfall it may span plans. Double-click to override.
              const autoLabel =
                account.paymentAllocation === "per_plan"
                  ? alloc.perPlan[0]?.label ?? "—"
                  : alloc.perPlan.length <= 1
                    ? alloc.perPlan[0]?.label ?? "—"
                    : `Auto (waterfall — ${alloc.perPlan.length} plans)`;
              return (
                <div
                  className="plan-auto-target"
                  title="Double-click to apply this payment to a specific plan"
                  onDoubleClick={() => setPickingPlan(true)}
                  style={{ padding: "6px 10px", border: "1px solid var(--border)", borderRadius: 6, cursor: "pointer" }}
                >
                  {autoLabel}
                </div>
              );
            }
            return (
              <select
                value={forcedPlanId}
                onChange={(e) => {
                  setForcedPlanId(e.target.value);
                  if (e.target.value === "") setPickingPlan(false);
                }}
              >
                <option value="">
                  {needsPlanChoice ? "— Choose a plan —" : "— Auto —"}
                </option>
                {activePlans.map((b) => (
                  <option key={b.plan.id} value={b.plan.id}>
                    {b.plan.label}
                    {b.plan.paymentCents > 0 ? ` - ${formatCents(b.plan.paymentCents, currency)}` : ""}
                  </option>
                ))}
              </select>
            );
          })()}
        </div>

        {/* Allocation preview */}
        <div style={{ maxHeight: 220, overflow: "auto", border: "1px solid var(--border)", borderRadius: 6, marginTop: 6 }}>
          <table className="holdings-table" style={{ fontSize: 12 }}>
            <thead>
              <tr>
                <th>Plan</th>
                <th className="num">Principal</th>
                <th className="num">Interest</th>
              </tr>
            </thead>
            <tbody>
              {effAlloc.perPlan.length === 0 ? (
                <tr><td colSpan={3} className="empty">Enter an amount to preview the allocation.</td></tr>
              ) : (
                effAlloc.perPlan.map((a) => (
                  <tr key={a.planId}>
                    <td>{a.label}</td>
                    <td className="num">
                      <input
                        value={drafts[draftKey(a.planId, "principal")] ?? (a.principalCents / 100).toFixed(2)}
                        title="Override the principal for this plan"
                        style={{ width: 90, textAlign: "right" }}
                        onChange={(e) =>
                          setDrafts((prev) => ({ ...prev, [draftKey(a.planId, "principal")]: e.target.value }))
                        }
                      />
                    </td>
                    <td className="num">
                      <input
                        value={drafts[draftKey(a.planId, "interest")] ?? (a.interestCents / 100).toFixed(2)}
                        title="Override the interest for this plan"
                        style={{ width: 90, textAlign: "right" }}
                        onChange={(e) =>
                          setDrafts((prev) => ({ ...prev, [draftKey(a.planId, "interest")]: e.target.value }))
                        }
                      />
                    </td>
                  </tr>
                ))
              )}
            </tbody>
            {effAlloc.perPlan.length > 0 && (
              <tfoot>
                <tr>
                  <td>Total applied</td>
                  <td className="num">
                    {formatCents(effAlloc.perPlan.reduce((s, a) => s + a.principalCents, 0), currency)}
                  </td>
                  <td className="num">{formatCents(totalInterest, currency)}</td>
                </tr>
              </tfoot>
            )}
          </table>
        </div>
        {(() => {
          // When overrides are in play the applied total can differ from the
          // entered amount; surface the difference so the user can reconcile.
          const applied = effAlloc.perPlan.reduce((s, a) => s + a.principalCents + a.interestCents, 0);
          const diff = applied - Math.abs(paymentCents);
          if (paymentCents > 0 && diff !== 0) {
            return (
              <div className="account-type" style={{ marginTop: 4 }}>
                Applied total {formatCents(applied, currency)} {diff > 0 ? "exceeds" : "is under"} the
                entered amount {formatCents(Math.abs(paymentCents), currency)} by {formatCents(Math.abs(diff), currency)}.
              </div>
            );
          }
          return null;
        })()}
        {effAlloc.unallocatedCents > 0 && (
          <div className="account-type" style={{ marginTop: 4 }}>
            {formatCents(effAlloc.unallocatedCents, currency)} of this payment exceeds the plans' balances and won't be applied.
          </div>
        )}

        {error && <div className="error">{error}</div>}
        <div className="dialog-actions">
          <button className="secondary" onClick={onCancel}>Cancel</button>
          <button onClick={() => void submit()}>Apply payment</button>
        </div>
      </div>
    </div>
  );
}
