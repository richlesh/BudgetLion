import { useCallback, useEffect, useMemo, useState } from "react";
import type { Account, Category, LoanPlan, PlanBalance } from "../shared/types";
import { formatCents, parseCents, bpsToPercent, percentToBps } from "../core/money";
import { projectPlanPayoff } from "../core/installment";
import { categoryOptions, categoriesForDirection } from "../core/categories";
import { ConfirmDialog } from "./ConfirmDialog";
import { TrashIcon } from "./TrashIcon";
import { PlanLedgerDialog } from "./PlanLedgerDialog";

interface Props {
  account: Account; // an installment / BNPL account
  /** Expense categories for the optional purchase category. */
  categories: Category[];
  /** Bump to force a reload (e.g. after a payment posts). */
  reloadKey?: number;
  /** Fired when the user clicks "Apply payment" — the app owns the payment flow. */
  onApplyPayment?: () => void;
  /** Fired after plans change so the app can refresh balances/forecast. */
  onChanged?: () => void;
  /** Open the Split editor on a just-recorded purchase transaction so the user
   *  can divide it across multiple expense categories (the app owns the editor). */
  onSplitPurchase?: (txId: string) => void;
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * The soonest upcoming payment date for a plan, assuming monthly installments
 * starting one month after origination. `paymentsMade` payments have already
 * been posted, so the next one is due at origination + (paymentsMade + 1) months.
 * Returns null when the plan is fully paid (no remaining balance or all
 * scheduled payments made) — those sort to the bottom.
 */
function nextDueDate(b: PlanBalance): string | null {
  const p = b.plan;
  if (b.remainingCents <= 0) return null;
  if (p.numPayments > 0 && b.paymentsMade >= p.numPayments) return null;
  const d = new Date(p.originationDate + "T00:00:00");
  if (Number.isNaN(d.getTime())) return null;
  // Add whole months for payments already made plus the next one. setMonth
  // normalizes overflow (e.g. Jan 31 + 1mo → Mar 3), which is fine for ordering.
  d.setMonth(d.getMonth() + b.paymentsMade + 1);
  return d.toISOString().slice(0, 10);
}

/**
 * Plans panel for an installment / BNPL account: one row per financed plan with
 * its computed remaining balance, APR, payments left, expiration, and installment.
 * Add a plan via the footer row; delete via the trash button (with confirmation).
 */
export function PlansPanel({ account, categories, reloadKey, onApplyPayment, onChanged, onSplitPurchase }: Props) {
  const [balances, setBalances] = useState<PlanBalance[]>([]);
  const [deleteFor, setDeleteFor] = useState<LoanPlan | null>(null);
  // Plan whose transaction-history dialog is open (double-click the Remaining cell).
  const [historyFor, setHistoryFor] = useState<LoanPlan | null>(null);
  // Inline edit: which plan's field is being edited (label / rate / payment) + draft.
  const [editing, setEditing] = useState<{ planId: string; field: "label" | "rate" | "payment" | "orig" | "exp" } | null>(null);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  // New-plan draft fields.
  const [label, setLabel] = useState("");
  const [orig, setOrig] = useState(today());
  const [exp, setExp] = useState("");
  const [principal, setPrincipal] = useState("");
  const [rate, setRate] = useState("0");
  const [numPayments, setNumPayments] = useState("1");
  const [payment, setPayment] = useState("");
  // New-plan optional purchase: record an originating purchase transaction and,
  // if chosen, attribute it to an expense category (else uncategorized).
  const [recordPurchase, setRecordPurchase] = useState(false);
  const [purchaseCategoryId, setPurchaseCategoryId] = useState("");
  // Per-plan: whether an originating purchase transaction already exists.
  const [purchaseByPlan, setPurchaseByPlan] = useState<Record<string, boolean>>({});
  // A plan for which the retroactive "Record purchase" dialog is open.
  const [recordFor, setRecordFor] = useState<LoanPlan | null>(null);
  const [recordCatId, setRecordCatId] = useState("");

  const currency = account.currency;
  const expenseCats = useMemo(
    () => categoryOptions(categoriesForDirection(categories, "expense")),
    [categories]
  );

  const load = useCallback(async () => {
    const bal = await window.ledger.planBalances(account.id);
    setBalances(bal);
    // Track which plans already have an originating purchase transaction, so the
    // "Record purchase" action only shows for plans that don't.
    const flags = await Promise.all(
      bal.map((b) => window.ledger.planHasPurchase(b.plan.id).then((has) => [b.plan.id, has] as const))
    );
    setPurchaseByPlan(Object.fromEntries(flags));
  }, [account.id]);

  useEffect(() => {
    void load();
  }, [load, reloadKey]);

  const totalRemaining = balances.reduce((s, b) => s + b.remainingCents, 0);
  // Displayed order: soonest next-due date first, then increasing. Plans with no
  // upcoming payment (fully paid) sort last; ties fall back to the label.
  const sortedBalances = useMemo(() => {
    return [...balances].sort((a, b) => {
      const da = nextDueDate(a);
      const db = nextDueDate(b);
      if (da && db) return da.localeCompare(db) || a.plan.label.localeCompare(b.plan.label);
      if (da) return -1; // a has a due date, b doesn't → a first
      if (db) return 1;
      return a.plan.label.localeCompare(b.plan.label);
    });
  }, [balances]);
  // Consolidated payoff projection (each plan pays its installment monthly).
  const payoff = useMemo(() => projectPlanPayoff(balances, today()), [balances]);

  const addPlan = useCallback(async (splitAfter = false) => {
    setError(null);
    if (!label.trim()) { setError("Enter a plan label."); return; }
    const principalCents = parseCents(principal);
    if (principalCents == null || principalCents <= 0) { setError("Enter a valid principal."); return; }
    if (!orig) { setError("Choose an origination date."); return; }
    const paymentCents = parseCents(payment) ?? 0;
    try {
      // Splitting requires a recorded purchase; record it uncategorized and open
      // the split editor after. Otherwise honor the checkbox/category choice.
      const willRecord = splitAfter || recordPurchase;
      const plan = await window.ledger.createLoanPlan({
        accountId: account.id,
        label: label.trim(),
        originationDate: orig,
        expirationDate: exp || null,
        principalCents,
        rateBps: percentToBps(rate) ?? 0,
        numPayments: Math.max(1, Number(numPayments) || 1),
        paymentCents,
        recordPurchase: willRecord,
        purchaseCategoryId: willRecord ? (splitAfter ? null : (purchaseCategoryId || null)) : undefined,
      });
      setLabel(""); setPrincipal(""); setRate("0"); setNumPayments("1"); setPayment(""); setExp("");
      setRecordPurchase(false); setPurchaseCategoryId("");
      await load();
      onChanged?.();
      if (splitAfter && plan.purchaseTxnId) onSplitPurchase?.(plan.purchaseTxnId);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not add the plan.");
    }
  }, [account.id, label, orig, exp, principal, rate, numPayments, payment, recordPurchase, purchaseCategoryId, load, onChanged, onSplitPurchase]);

  // Record an originating purchase for an EXISTING plan (retroactive opt-in).
  const submitRecordPurchase = useCallback(async () => {
    const p = recordFor;
    if (!p) return;
    setRecordFor(null);
    try {
      await window.ledger.recordPlanPurchase({ planId: p.id, categoryId: recordCatId || null });
      setRecordCatId("");
      await load();
      onChanged?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not record the purchase.");
    }
  }, [recordFor, recordCatId, load, onChanged]);

  // Record the purchase uncategorized, then hand the new transaction to the app
  // to open the Split editor so it can be divided across multiple categories.
  const submitRecordAndSplit = useCallback(async () => {
    const p = recordFor;
    if (!p) return;
    setRecordFor(null);
    setRecordCatId("");
    try {
      const txId = await window.ledger.recordPlanPurchase({ planId: p.id, categoryId: null });
      await load();
      onChanged?.();
      onSplitPurchase?.(txId);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not record the purchase.");
    }
  }, [recordFor, load, onChanged, onSplitPurchase]);

  const confirmDelete = useCallback(async () => {
    const p = deleteFor;
    setDeleteFor(null);
    if (!p) return;
    try {
      await window.ledger.deleteLoanPlan(p.id);
      await load();
      onChanged?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not close the plan.");
    }
  }, [deleteFor, load, onChanged]);

  // Begin editing a plan field (double-click). Seeds the draft from the value.
  const beginEdit = useCallback((p: LoanPlan, field: "label" | "rate" | "payment" | "orig" | "exp") => {
    setError(null);
    setEditing({ planId: p.id, field });
    setDraft(
      field === "label"
        ? p.label
        : field === "rate"
          ? (p.rateBps ? bpsToPercent(p.rateBps).toString() : "0")
          : field === "orig"
            ? p.originationDate
            : field === "exp"
              ? (p.expirationDate ?? "")
              : p.paymentCents > 0
                ? (p.paymentCents / 100).toFixed(2)
                : ""
    );
  }, []);

  // Commit the inline edit: validate, persist via updateLoanPlan, reload.
  const commitEdit = useCallback(async () => {
    const ed = editing;
    setEditing(null);
    if (!ed) return;
    const text = draft.trim();
    try {
      if (ed.field === "label") {
        if (!text) return; // don't blank a label
        await window.ledger.updateLoanPlan({ id: ed.planId, label: text });
      } else if (ed.field === "rate") {
        const bps = percentToBps(text) ?? 0;
        if (bps < 0) { setError("Enter a valid APR."); return; }
        await window.ledger.updateLoanPlan({ id: ed.planId, rateBps: bps });
      } else if (ed.field === "orig") {
        if (!text) return; // origination date is required
        await window.ledger.updateLoanPlan({ id: ed.planId, originationDate: text });
      } else if (ed.field === "exp") {
        // Expiration is optional; blank clears it.
        await window.ledger.updateLoanPlan({ id: ed.planId, expirationDate: text || null });
      } else {
        const cents = parseCents(text) ?? 0;
        if (cents < 0) { setError("Enter a valid installment amount."); return; }
        await window.ledger.updateLoanPlan({ id: ed.planId, paymentCents: cents });
      }
      await load();
      onChanged?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not update the plan.");
    }
  }, [editing, draft, load, onChanged]);

  return (
    <div className="holdings-panel">
      <div className="holdings-head">
        <h3>Plans</h3>
        <button className="secondary" onClick={() => onApplyPayment?.()}>
          Apply payment…
        </button>
      </div>

      {balances.length === 0 ? (
        <div className="empty">No plans yet. Add a financed plan below.</div>
      ) : (
        <table className="holdings-table">
          <thead>
            <tr>
              <th>Plan</th>
              <th className="num">Remaining</th>
              <th className="num">APR</th>
              <th className="num">Payments left</th>
              <th>Originated</th>
              <th>Expires</th>
              <th className="num">Installment</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {sortedBalances.map((b) => {
              const p = b.plan;
              const left = Math.max(0, p.numPayments - b.paymentsMade);
              return (
                <tr key={p.id}>
                  {/* Plan label — double-click to edit. */}
                  <td>
                    {editing?.planId === p.id && editing.field === "label" ? (
                      <input
                        className="holdings-edit"
                        autoFocus
                        value={draft}
                        onChange={(e) => setDraft(e.target.value)}
                        onBlur={() => void commitEdit()}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") { e.preventDefault(); void commitEdit(); }
                          else if (e.key === "Escape") { e.preventDefault(); setEditing(null); }
                        }}
                      />
                    ) : (
                      <span title="Double-click to edit the plan name" onDoubleClick={() => beginEdit(p, "label")}>
                        {p.label}
                      </span>
                    )}
                  </td>
                  {/* Remaining — double-click opens the plan's transaction history. */}
                  <td className="num">
                    <span
                      title="Double-click for this plan's transaction history"
                      onDoubleClick={() => setHistoryFor(p)}
                    >
                      {formatCents(b.remainingCents, currency)}
                    </span>
                  </td>
                  {/* APR — double-click to edit (percent). */}
                  <td className="num">
                    {editing?.planId === p.id && editing.field === "rate" ? (
                      <input
                        className="holdings-edit"
                        autoFocus
                        value={draft}
                        style={{ width: 70, textAlign: "right" }}
                        onChange={(e) => setDraft(e.target.value)}
                        onBlur={() => void commitEdit()}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") { e.preventDefault(); void commitEdit(); }
                          else if (e.key === "Escape") { e.preventDefault(); setEditing(null); }
                        }}
                      />
                    ) : (
                      <span title="Double-click to edit the APR" onDoubleClick={() => beginEdit(p, "rate")}>
                        {p.rateBps > 0 ? `${bpsToPercent(p.rateBps)}%` : "0%"}
                      </span>
                    )}
                  </td>
                  <td className="num">{left} of {p.numPayments}</td>
                  {/* Origination date — double-click to edit. */}
                  <td>
                    {editing?.planId === p.id && editing.field === "orig" ? (
                      <input
                        type="date"
                        autoFocus
                        value={draft}
                        onChange={(e) => setDraft(e.target.value)}
                        onBlur={() => void commitEdit()}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") { e.preventDefault(); void commitEdit(); }
                          else if (e.key === "Escape") { e.preventDefault(); setEditing(null); }
                        }}
                      />
                    ) : (
                      <span title="Double-click to edit the origination date" onDoubleClick={() => beginEdit(p, "orig")}>
                        {p.originationDate}
                      </span>
                    )}
                  </td>
                  {/* Expiration date — double-click to edit (blank clears it). */}
                  <td>
                    {editing?.planId === p.id && editing.field === "exp" ? (
                      <input
                        type="date"
                        autoFocus
                        value={draft}
                        onChange={(e) => setDraft(e.target.value)}
                        onBlur={() => void commitEdit()}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") { e.preventDefault(); void commitEdit(); }
                          else if (e.key === "Escape") { e.preventDefault(); setEditing(null); }
                        }}
                      />
                    ) : (
                      <span title="Double-click to edit the expiration date" onDoubleClick={() => beginEdit(p, "exp")}>
                        {p.expirationDate ?? "—"}
                      </span>
                    )}
                  </td>
                  {/* Installment — double-click to edit. */}
                  <td className="num">
                    {editing?.planId === p.id && editing.field === "payment" ? (
                      <input
                        className="holdings-edit"
                        autoFocus
                        value={draft}
                        placeholder="0.00"
                        style={{ width: 90, textAlign: "right" }}
                        onChange={(e) => setDraft(e.target.value)}
                        onBlur={() => void commitEdit()}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") { e.preventDefault(); void commitEdit(); }
                          else if (e.key === "Escape") { e.preventDefault(); setEditing(null); }
                        }}
                      />
                    ) : (
                      <span title="Double-click to edit the installment" onDoubleClick={() => beginEdit(p, "payment")}>
                        {p.paymentCents > 0 ? formatCents(p.paymentCents, currency) : "—"}
                      </span>
                    )}
                  </td>
                  <td className="num">
                    {purchaseByPlan[p.id] === false && (
                      <button
                        className="secondary"
                        title="Record the originating purchase (charges this account for the principal)"
                        style={{ marginRight: 6, fontSize: 12 }}
                        onClick={() => { setRecordCatId(p.purchaseCategoryId ?? ""); setRecordFor(p); }}
                      >
                        Record purchase
                      </button>
                    )}
                    <button
                      className="secondary icon-btn"
                      title="Close (delete) this plan"
                      aria-label={`Delete ${p.label}`}
                      onClick={() => setDeleteFor(p)}
                    >
                      <TrashIcon />
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
          <tfoot>
            <tr>
              <td>Total</td>
              <td className="num">{formatCents(totalRemaining, currency)}</td>
              <td className="num"></td>
              <td className="num"></td>
              <td></td>
              <td></td>
              <td className="num"></td>
              <td></td>
            </tr>
          </tfoot>
        </table>
      )}

      {balances.length > 0 && (
        <div className="account-type" style={{ marginTop: 6 }}>
          Total owed {formatCents(totalRemaining, currency)}
          {payoff.payoffDate
            ? ` · paid off by ${payoff.payoffDate.slice(0, 7)} · remaining interest ${formatCents(payoff.totalInterestCents, currency)}`
            : ""}
        </div>
      )}

      {/* Add-plan form */}
      <div className="plans-add">
        <h4 style={{ margin: "12px 0 6px" }}>Add a plan</h4>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
          <div className="field" style={{ flex: "2 1 200px" }}>
            <label>Label</label>
            <input value={label} placeholder="e.g. Wayfair couch — Mar 2026" onChange={(e) => setLabel(e.target.value)} />
          </div>
          <div className="field" style={{ flex: "1 1 120px" }}>
            <label>Principal</label>
            <input value={principal} placeholder="0.00" style={{ textAlign: "right" }} onChange={(e) => setPrincipal(e.target.value)} />
          </div>
          <div className="field" style={{ width: 90 }}>
            <label>APR %</label>
            <input value={rate} onChange={(e) => setRate(e.target.value)} />
          </div>
        </div>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
          <div className="field" style={{ flex: "1 1 130px" }}>
            <label>Origination date</label>
            <input type="date" value={orig} onChange={(e) => setOrig(e.target.value)} />
          </div>
          <div className="field" style={{ flex: "1 1 130px" }}>
            <label>Expiration date</label>
            <input type="date" value={exp} onChange={(e) => setExp(e.target.value)} />
          </div>
          <div className="field" style={{ width: 90 }}>
            <label># Payments</label>
            <input value={numPayments} onChange={(e) => setNumPayments(e.target.value)} />
          </div>
          <div className="field" style={{ flex: "1 1 120px" }}>
            <label>Installment</label>
            <input value={payment} placeholder="0.00" style={{ textAlign: "right" }} onChange={(e) => setPayment(e.target.value)} />
          </div>
        </div>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "flex-end", marginTop: 4 }}>
          <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13 }}>
            <input
              type="checkbox"
              checked={recordPurchase}
              onChange={(e) => setRecordPurchase(e.target.checked)}
            />
            Record the purchase (charges this account for the principal)
          </label>
          {recordPurchase && (
            <div className="field" style={{ flex: "1 1 200px" }}>
              <label>Purchase expense category (optional)</label>
              <select value={purchaseCategoryId} onChange={(e) => setPurchaseCategoryId(e.target.value)}>
                <option value="">— Uncategorized —</option>
                {expenseCats.map((o) => (
                  <option key={o.category.id} value={o.category.id}>{o.display}</option>
                ))}
              </select>
            </div>
          )}
        </div>
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 6 }}>
          {recordPurchase && (
            <button className="secondary" onClick={() => void addPlan(true)}>
              Add & split across categories…
            </button>
          )}
          <button onClick={() => void addPlan(false)}>Add plan</button>
        </div>
      </div>

      {error && <div className="error">{error}</div>}

      {deleteFor && (
        <ConfirmDialog
          title={`Close plan "${deleteFor.label}"?`}
          message="This removes the plan from this account. Payments already recorded against it stay in the ledger. Close it anyway?"
          confirmLabel="Close plan"
          onConfirm={() => void confirmDelete()}
          onCancel={() => setDeleteFor(null)}
        />
      )}
      {historyFor && (
        <PlanLedgerDialog plan={historyFor} currency={currency} onClose={() => setHistoryFor(null)} />
      )}
      {recordFor && (
        <div className="dialog-backdrop dialog-backdrop-top" onClick={() => setRecordFor(null)}>
          <div className="dialog" style={{ width: 460 }} onClick={(e) => e.stopPropagation()}>
            <h3>Record purchase — {recordFor.label}</h3>
            <div className="account-type" style={{ marginTop: 0 }}>
              Charges this account {formatCents(recordFor.principalCents, currency)} on{" "}
              {recordFor.originationDate}, recorded as spending in the chosen category.
              This does not count as a payment against the plan balance.
            </div>
            <div className="field">
              <label>Purchase expense category (optional)</label>
              <select value={recordCatId} onChange={(e) => setRecordCatId(e.target.value)}>
                <option value="">— Uncategorized —</option>
                {expenseCats.map((o) => (
                  <option key={o.category.id} value={o.category.id}>{o.display}</option>
                ))}
              </select>
              <div className="account-type" style={{ marginTop: 4 }}>
                To divide this purchase across several categories, use “Split across
                categories…” below.
              </div>
            </div>
            <div className="dialog-actions">
              <button className="secondary" onClick={() => setRecordFor(null)}>Cancel</button>
              <button className="secondary" onClick={() => void submitRecordAndSplit()}>
                Split across categories…
              </button>
              <button onClick={() => void submitRecordPurchase()}>Record purchase</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
