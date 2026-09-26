import { useEffect, useMemo, useState } from "react";
import type { AdjustPlanInput, Category, LoanPlan, PlanBalance } from "../shared/types";
import { formatCents, parseCents } from "../core/money";
import { categoriesForDirection, categoryOptions } from "../core/categories";

interface Props {
  /**
   * Fixed plan mode (from the Plans panel): the plan being adjusted plus its
   * current remaining balance. When omitted, the dialog runs in picker mode and
   * loads the plans for `accountId` so the user can choose one.
   */
  plan?: LoanPlan;
  remainingCents?: number;
  /** Picker mode (from the ledger): the installment account whose plans to list. */
  accountId?: string;
  currency: string;
  categories: Category[];
  onCancel: () => void;
  /** Submit the adjustment. Returns when the write completes. */
  onSubmit: (input: AdjustPlanInput) => void | Promise<void>;
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Apply a manual adjustment to a single installment/BNPL plan:
 *   - a signed PRINCIPAL adjustment (credit reduces the remaining balance, charge
 *     raises it), booked as a self-referential principal correction on the
 *     installment account (no external cash source);
 *   - and/or a LATE FEE, recorded as an expense on the account and attributed to
 *     the plan for history/reporting — it does NOT change the remaining balance.
 * At least one of the two must be provided.
 */
export function AdjustPlanDialog({ plan, remainingCents, accountId, currency, categories, onCancel, onSubmit }: Props) {
  // Picker mode: load the account's plans so the user can choose which to adjust.
  const [planBalances, setPlanBalances] = useState<PlanBalance[]>([]);
  const [selectedPlanId, setSelectedPlanId] = useState<string>(plan?.id ?? "");
  useEffect(() => {
    if (plan || !accountId) return;
    let alive = true;
    void window.ledger.planBalances(accountId).then((b) => {
      if (!alive) return;
      setPlanBalances(b);
      setSelectedPlanId((cur) => cur || (b[0]?.plan.id ?? ""));
    });
    return () => {
      alive = false;
    };
  }, [plan, accountId]);

  // The effective plan + remaining balance for the current selection.
  const effectivePlan = plan ?? planBalances.find((b) => b.plan.id === selectedPlanId)?.plan ?? null;
  const effectiveRemaining =
    plan != null
      ? remainingCents ?? 0
      : planBalances.find((b) => b.plan.id === selectedPlanId)?.remainingCents ?? 0;

  // Principal adjustment direction + magnitude. "credit" reduces the balance.
  const [direction, setDirection] = useState<"credit" | "charge">("credit");
  const [principalAmount, setPrincipalAmount] = useState("");
  const [feeAmount, setFeeAmount] = useState("");
  const [feeCategoryId, setFeeCategoryId] = useState("");
  const [memo, setMemo] = useState("");
  const [date, setDate] = useState(today());
  const [error, setError] = useState<string | null>(null);

  const expenseCats = useMemo(
    () => categoryOptions(categoriesForDirection(categories, "expense")),
    [categories]
  );

  const principalMagnitude = parseCents(principalAmount) ?? 0;
  const feeCents = parseCents(feeAmount) ?? 0;
  // Signed principal change: credit (>0) reduces the balance; charge (<0) raises it.
  const signedPrincipal =
    principalMagnitude > 0 ? (direction === "credit" ? principalMagnitude : -principalMagnitude) : 0;
  const previewRemaining = Math.max(0, effectiveRemaining - signedPrincipal);

  const submit = async () => {
    setError(null);
    if (!effectivePlan) {
      setError("Choose a plan to adjust.");
      return;
    }
    if (signedPrincipal === 0 && feeCents <= 0) {
      setError("Enter a principal adjustment and/or a late fee.");
      return;
    }
    if (feeCents > 0 && !feeCategoryId) {
      setError("Choose an expense category for the late fee.");
      return;
    }
    try {
      await onSubmit({
        planId: effectivePlan.id,
        date,
        principalAdjustmentCents: signedPrincipal !== 0 ? signedPrincipal : undefined,
        feeCents: feeCents > 0 ? feeCents : undefined,
        feeCategoryId: feeCents > 0 ? feeCategoryId : undefined,
        memo: memo.trim() || null,
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not apply the adjustment.");
    }
  };

  return (
    <div className="dialog-backdrop dialog-backdrop-top" onClick={onCancel}>
      <div className="dialog" style={{ width: 480 }} onClick={(e) => e.stopPropagation()}>
        <h3>Adjust plan{effectivePlan ? ` — ${effectivePlan.label}` : ""}</h3>
        {/* Plan picker (ledger/account mode only). */}
        {!plan && (
          <div className="field">
            <label>Plan</label>
            <select value={selectedPlanId} onChange={(e) => setSelectedPlanId(e.target.value)}>
              {planBalances.length === 0 && <option value="">— No plans —</option>}
              {planBalances.map((b) => (
                <option key={b.plan.id} value={b.plan.id}>
                  {b.plan.label} — {formatCents(b.remainingCents, currency)}
                </option>
              ))}
            </select>
          </div>
        )}
        <div className="account-type" style={{ marginTop: 0 }}>
          Current remaining {formatCents(effectiveRemaining, currency)}
        </div>

        <div style={{ display: "flex", gap: 8 }}>
          <div className="field" style={{ flex: 1 }}>
            <label>Date</label>
            <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          </div>
        </div>

        {/* Principal adjustment */}
        <div className="field">
          <label>Principal adjustment</label>
          <div style={{ display: "flex", gap: 8 }}>
            <select
              value={direction}
              onChange={(e) => setDirection(e.target.value as "credit" | "charge")}
              style={{ flex: "0 0 auto" }}
            >
              <option value="credit">Credit (reduce balance)</option>
              <option value="charge">Charge (increase balance)</option>
            </select>
            <input
              value={principalAmount}
              placeholder="0.00"
              style={{ flex: 1, textAlign: "right" }}
              onChange={(e) => setPrincipalAmount(e.target.value)}
            />
          </div>
          <div className="account-type" style={{ marginTop: 4 }}>
            A balance correction on this account (no external source). Does not book
            an interest/expense category.
          </div>
        </div>

        {/* Late fee */}
        <div className="field">
          <label>Late fee (optional)</label>
          <input
            value={feeAmount}
            placeholder="0.00"
            style={{ textAlign: "right" }}
            onChange={(e) => setFeeAmount(e.target.value)}
          />
        </div>
        <div className="field">
          <label>Late fee category {feeCents > 0 ? "(required)" : "(not needed — no fee)"}</label>
          <select
            value={feeCategoryId}
            onChange={(e) => setFeeCategoryId(e.target.value)}
            disabled={feeCents <= 0}
          >
            <option value="">— Choose category —</option>
            {expenseCats.map((o) => (
              <option key={o.category.id} value={o.category.id}>{o.display}</option>
            ))}
          </select>
          <div className="account-type" style={{ marginTop: 4 }}>
            Recorded as an expense attributed to this plan. Does not change the
            remaining balance.
          </div>
        </div>

        <div className="field">
          <label>Memo (optional)</label>
          <input value={memo} placeholder="e.g. Goodwill credit" onChange={(e) => setMemo(e.target.value)} />
        </div>

        {signedPrincipal !== 0 && (
          <div className="account-type" style={{ marginTop: 4 }}>
            New remaining after this adjustment: {formatCents(previewRemaining, currency)}
            {" "}({signedPrincipal > 0 ? "−" : "+"}{formatCents(Math.abs(signedPrincipal), currency)})
          </div>
        )}

        {error && <div className="error">{error}</div>}
        <div className="dialog-actions">
          <button className="secondary" onClick={onCancel}>Cancel</button>
          <button onClick={() => void submit()}>Apply adjustment</button>
        </div>
      </div>
    </div>
  );
}
