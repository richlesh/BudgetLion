import { useEffect, useMemo, useState } from "react";
import type { LoanPlan, PlanLedgerEntry } from "../shared/types";
import { formatCents } from "../core/money";
import { projectPlanSchedule } from "../core/installment";

interface Props {
  plan: LoanPlan;
  currency: string;
  onClose: () => void;
}

/**
 * Read-only accounting of a single installment plan: every payment attributed to
 * it (principal + interest) with a running remaining balance, starting from the
 * plan's original principal.
 */
export function PlanLedgerDialog({ plan, currency, onClose }: Props) {
  const [rows, setRows] = useState<PlanLedgerEntry[]>([]);

  useEffect(() => {
    let alive = true;
    void window.ledger.planLedger(plan.id).then((r) => {
      if (alive) setRows(r);
    });
    return () => {
      alive = false;
    };
  }, [plan.id]);

  const totalPrincipal = rows.reduce((s, r) => s + r.principalCents, 0);
  const totalInterest = rows.reduce((s, r) => s + r.interestCents, 0);
  const remaining = rows.length > 0 ? rows[rows.length - 1].runningBalanceCents : plan.principalCents;

  // Projected future payments (amortization tail): continue the schedule from the
  // current remaining balance and the count of payments already posted, applying
  // the plan's installment monthly until it pays off (or the term is reached).
  const paymentsMade = rows.filter((r) => r.principalCents > 0).length;
  const future = useMemo(
    () =>
      projectPlanSchedule(
        remaining,
        plan.rateBps,
        plan.paymentCents,
        plan.numPayments,
        paymentsMade,
        plan.originationDate
      ),
    [remaining, plan.rateBps, plan.paymentCents, plan.numPayments, paymentsMade, plan.originationDate]
  );
  const futureInterest = future.reduce((s, r) => s + r.interestCents, 0);
  const payoffDate = future.length > 0 ? future[future.length - 1].date : null;

  return (
    <div className="dialog-backdrop dialog-backdrop-top" onClick={onClose}>
      <div className="dialog" style={{ width: "min(640px, 92vw)" }} onClick={(e) => e.stopPropagation()}>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <h3 style={{ margin: 0 }}>Plan history — {plan.label}</h3>
          <span style={{ flex: 1 }} />
          <button className="secondary" onClick={onClose}>Close</button>
        </div>
        <div className="account-type" style={{ marginTop: 4 }}>
          Original {formatCents(plan.principalCents, currency)}
          {plan.rateBps > 0 ? ` · APR from statements` : " · 0% APR"}
          {payoffDate
            ? ` · projected payoff ${payoffDate}${futureInterest > 0 ? ` · remaining interest ${formatCents(futureInterest, currency)}` : ""}`
            : remaining <= 0
              ? " · paid off"
              : ""}
        </div>

        <div style={{ maxHeight: "60vh", overflow: "auto", marginTop: 8 }}>
          <table className="holdings-table">
            <thead>
              <tr>
                <th>Date</th>
                <th>Payee / memo</th>
                <th className="num">Principal</th>
                <th className="num">Interest</th>
                <th className="num">Balance</th>
              </tr>
            </thead>
            <tbody>
              {/* Opening row = original principal. */}
              <tr>
                <td>{plan.originationDate}</td>
                <td className="account-type">Original balance</td>
                <td className="num">—</td>
                <td className="num">—</td>
                <td className="num">{formatCents(plan.principalCents, currency)}</td>
              </tr>
              {rows.length === 0 ? (
                <tr><td colSpan={5} className="empty">No payments recorded for this plan yet.</td></tr>
              ) : (
                rows.map((r, i) => (
                  <tr key={`${r.transactionId}-${i}`}>
                    <td>{r.date}</td>
                    <td>{r.payee ?? ""}{r.memo ? ` — ${r.memo}` : ""}</td>
                    <td className="num">{r.principalCents > 0 ? formatCents(r.principalCents, currency) : "—"}</td>
                    <td className="num">{r.interestCents > 0 ? formatCents(r.interestCents, currency) : "—"}</td>
                    <td className="num">{formatCents(r.runningBalanceCents, currency)}</td>
                  </tr>
                ))
              )}
              {/* Projected future payments (amortization tail). */}
              {future.length > 0 && (
                <>
                  <tr>
                    <td colSpan={5} className="account-type" style={{ paddingTop: 10, fontWeight: 700 }}>
                      Projected payoff schedule
                    </td>
                  </tr>
                  {future.map((f) => (
                    <tr key={`future-${f.paymentNumber}`} style={{ opacity: 0.75, fontStyle: "italic" }}>
                      <td>{f.date}</td>
                      <td className="account-type">Payment {f.paymentNumber}{plan.numPayments > 0 ? ` of ${plan.numPayments}` : ""} (projected)</td>
                      <td className="num">{formatCents(f.principalCents, currency)}</td>
                      <td className="num">{f.interestCents > 0 ? formatCents(f.interestCents, currency) : "—"}</td>
                      <td className="num">{formatCents(f.remainingCents, currency)}</td>
                    </tr>
                  ))}
                </>
              )}
            </tbody>
            <tfoot>
              <tr>
                <td>Totals</td>
                <td></td>
                <td className="num">{formatCents(totalPrincipal, currency)}</td>
                <td className="num">{formatCents(totalInterest, currency)}</td>
                <td className="num">{formatCents(remaining, currency)}</td>
              </tr>
            </tfoot>
          </table>
        </div>
      </div>
    </div>
  );
}
