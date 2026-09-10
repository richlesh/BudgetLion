// Installment / BNPL payment allocation. Pure and framework-agnostic: given a
// payment and the account's plans (with computed remaining balances), decide how
// much of the payment goes to each plan, split into interest and principal.
//
// Two strategies mirror how real providers behave:
//   per_plan          — Affirm-style: each plan is paid separately, so a payment
//                        is matched to ONE plan (by its fixed installment amount).
//   waterfall_soonest — PayPal Pay Later-style: a single payment is applied to
//                        the plan expiring soonest first, cascading to the next.
//
// Interest is charged monthly on a plan's remaining balance at its APR; a 0% plan
// contributes zero interest (all principal).

import type { PlanBalance } from "../shared/types";

/** How a payment is distributed to one plan. */
export interface PlanAllocation {
  planId: string;
  label: string;
  /** Interest portion (cents) applied to this plan. */
  interestCents: number;
  /** Principal portion (cents) — reduces the plan's remaining balance. */
  principalCents: number;
}

/** The full allocation of a payment across plans. */
export interface AllocationResult {
  perPlan: PlanAllocation[];
  /** Cents that couldn't be applied (payment exceeded total remaining + interest). */
  unallocatedCents: number;
}

/**
 * One period's interest on a remaining balance at an annual APR (basis points).
 * Monthly convention: remaining × (rateBps / 10000) / 12, rounded to cents.
 * Returns 0 for a 0% plan or non-positive balance.
 */
export function perInstallmentInterest(remainingCents: number, rateBps: number): number {
  if (rateBps <= 0 || remainingCents <= 0) return 0;
  return Math.round((remainingCents * (rateBps / 10000)) / 12);
}

/** Sort plans by soonest expiration; nulls (no expiration) last, then origination. */
function byExpiration(a: PlanBalance, b: PlanBalance): number {
  const ax = a.plan.expirationDate;
  const bx = b.plan.expirationDate;
  if (ax !== bx) {
    if (ax == null) return 1;
    if (bx == null) return -1;
    return ax < bx ? -1 : 1;
  }
  const ao = a.plan.originationDate;
  const bo = b.plan.originationDate;
  if (ao !== bo) return ao < bo ? -1 : 1;
  return a.plan.id < b.plan.id ? -1 : a.plan.id > b.plan.id ? 1 : 0;
}

/**
 * Split an amount applied to a plan into interest + principal. Interest is this
 * period's interest on the plan's remaining balance, capped at the applied amount;
 * principal is the remainder (never exceeding the plan's remaining balance).
 */
function splitApplied(applied: number, pb: PlanBalance): PlanAllocation {
  const interest = Math.min(perInstallmentInterest(pb.remainingCents, pb.plan.rateBps), applied);
  const principal = Math.min(applied - interest, pb.remainingCents);
  return { planId: pb.plan.id, label: pb.plan.label, interestCents: interest, principalCents: principal };
}

/**
 * per_plan matcher: find the plan whose fixed installment equals the payment and
 * allocate the whole payment to it (interest + principal). Ties (same installment)
 * are broken by fewest payments made, then soonest expiration. Falls back to the
 * plan with the soonest expiration when no installment matches (the UI lets the
 * user override). Only plans with a positive remaining balance are considered.
 */
export function allocatePerPlan(paymentCents: number, plans: PlanBalance[]): AllocationResult {
  const active = plans.filter((p) => p.remainingCents > 0);
  if (active.length === 0 || paymentCents <= 0) {
    return { perPlan: [], unallocatedCents: Math.max(0, paymentCents) };
  }
  const exact = active
    .filter((p) => p.plan.paymentCents === paymentCents)
    .sort((a, b) => a.paymentsMade - b.paymentsMade || byExpiration(a, b));
  const chosen = exact[0] ?? [...active].sort(byExpiration)[0];

  // Apply up to the plan's remaining+interest (can't overpay a single plan here).
  const interest = perInstallmentInterest(chosen.remainingCents, chosen.plan.rateBps);
  const cap = chosen.remainingCents + interest;
  const applied = Math.min(paymentCents, cap);
  const alloc = splitApplied(applied, chosen);
  return { perPlan: [alloc], unallocatedCents: paymentCents - applied };
}

/**
 * waterfall_soonest distributor: apply the payment to the soonest-expiring plan
 * first (up to its due installment, or its remaining balance if the installment
 * is 0/larger), splitting interest vs principal, then cascade the remainder to the
 * next plan, and so on. Overpayment continues into later plans' principal.
 */
export function allocateWaterfall(paymentCents: number, plans: PlanBalance[]): AllocationResult {
  const active = plans.filter((p) => p.remainingCents > 0).sort(byExpiration);
  const perPlan: PlanAllocation[] = [];
  let remainingPayment = Math.max(0, paymentCents);

  for (const pb of active) {
    if (remainingPayment <= 0) break;
    const interest = perInstallmentInterest(pb.remainingCents, pb.plan.rateBps);
    // This plan's target for the payment: its scheduled installment if set,
    // otherwise its full remaining balance + interest. Never exceed remaining+interest.
    const planCap = pb.remainingCents + interest;
    const installmentTarget = pb.plan.paymentCents > 0 ? pb.plan.paymentCents : planCap;
    const target = Math.min(installmentTarget, planCap);
    const applied = Math.min(remainingPayment, target);
    if (applied <= 0) continue;
    const alloc = splitApplied(applied, pb);
    perPlan.push(alloc);
    remainingPayment -= applied;
  }

  // Any money left after every plan hit its installment cascades as extra
  // principal into plans (soonest first) until remaining balances are exhausted.
  if (remainingPayment > 0) {
    for (const pb of active) {
      if (remainingPayment <= 0) break;
      const existing = perPlan.find((a) => a.planId === pb.plan.id);
      const alreadyPrincipal = existing?.principalCents ?? 0;
      const room = pb.remainingCents - alreadyPrincipal;
      if (room <= 0) continue;
      const extra = Math.min(remainingPayment, room);
      if (existing) existing.principalCents += extra;
      else
        perPlan.push({
          planId: pb.plan.id,
          label: pb.plan.label,
          interestCents: 0,
          principalCents: extra,
        });
      remainingPayment -= extra;
    }
  }

  return { perPlan, unallocatedCents: remainingPayment };
}

/**
 * True when the payment exactly equals the fixed installment of at least one
 * active (positive-remaining) plan. Used by the dialog to decide whether the
 * auto-allocation is confident (exact match) or the user must pick a plan.
 */
export function matchesPlanInstallment(paymentCents: number, plans: PlanBalance[]): boolean {
  if (paymentCents <= 0) return false;
  return plans.some((p) => p.remainingCents > 0 && p.plan.paymentCents === paymentCents);
}

/**
 * Allocate the whole payment to ONE explicitly-chosen plan (a user override from
 * the dialog), splitting interest vs principal and capping at that plan's
 * remaining balance + this period's interest. Anything over the cap is reported
 * as unallocated. Returns an empty allocation if the plan is missing or paid off.
 */
export function allocateToPlan(
  paymentCents: number,
  plans: PlanBalance[],
  planId: string
): AllocationResult {
  const pb = plans.find((p) => p.plan.id === planId && p.remainingCents > 0);
  if (!pb || paymentCents <= 0) {
    return { perPlan: [], unallocatedCents: Math.max(0, paymentCents) };
  }
  const interest = perInstallmentInterest(pb.remainingCents, pb.plan.rateBps);
  const cap = pb.remainingCents + interest;
  const applied = Math.min(paymentCents, cap);
  return { perPlan: [splitApplied(applied, pb)], unallocatedCents: paymentCents - applied };
}

/**
 * Allocate a payment using the account's strategy. `mode` is the account's
 * paymentAllocation; defaults to waterfall when unset.
 */
export function allocatePayment(
  paymentCents: number,
  plans: PlanBalance[],
  mode: "per_plan" | "waterfall_soonest" | null
): AllocationResult {
  return mode === "per_plan"
    ? allocatePerPlan(paymentCents, plans)
    : allocateWaterfall(paymentCents, plans);
}

/** A consolidated month in the payoff projection across all plans. */
export interface PayoffMonth {
  /** First of the month (YYYY-MM-01). */
  date: string;
  paymentCents: number;
  interestCents: number;
  principalCents: number;
  /** Total remaining balance across all plans after this month. */
  remainingCents: number;
}

/** Summary of a payoff projection. */
export interface PayoffProjection {
  months: PayoffMonth[];
  /** Month (YYYY-MM-01) the last plan is paid off, or null if none/never. */
  payoffDate: string | null;
  totalInterestCents: number;
  /** Sum of all plans' current remaining balances (the account's owed principal). */
  startingRemainingCents: number;
}

/** First-of-month ISO string N months after a YYYY-MM(-DD) date. */
function monthStartAfter(iso: string, n: number): string {
  const [y, m] = iso.split("-").map(Number);
  const total = (y * 12 + (m - 1)) + n;
  const yy = Math.floor(total / 12);
  const mm = (total % 12) + 1;
  return `${yy}-${String(mm).padStart(2, "0")}-01`;
}

/**
 * Project a consolidated monthly payoff across all plans, assuming each plan pays
 * its fixed installment every month until its balance reaches zero. Interest each
 * month is charged per plan on its remaining balance (0% plans accrue none). A
 * plan with no installment (paymentCents 0) is paid off in a single month.
 * `fromDate` anchors month 1 (defaults handled by the caller).
 */
export function projectPlanPayoff(plans: PlanBalance[], fromDate: string): PayoffProjection {
  // Working copy of remaining balances.
  const state = plans
    .filter((p) => p.remainingCents > 0)
    .map((p) => ({ plan: p.plan, remaining: p.remainingCents }));
  const startingRemainingCents = state.reduce((s, p) => s + p.remaining, 0);

  const months: PayoffMonth[] = [];
  let totalInterest = 0;
  let payoffDate: string | null = null;
  let guard = 0;

  while (state.some((p) => p.remaining > 0) && guard < 600) {
    guard++;
    const date = monthStartAfter(fromDate, guard);
    let mPayment = 0;
    let mInterest = 0;
    let mPrincipal = 0;

    for (const p of state) {
      if (p.remaining <= 0) continue;
      const interest = perInstallmentInterest(p.remaining, p.plan.rateBps);
      const installment = p.plan.paymentCents > 0 ? p.plan.paymentCents : p.remaining + interest;
      const pay = Math.min(installment, p.remaining + interest);
      const principal = Math.min(pay - interest, p.remaining);
      p.remaining -= principal;
      mPayment += pay;
      mInterest += interest;
      mPrincipal += principal;
    }

    totalInterest += mInterest;
    const remaining = state.reduce((s, p) => s + p.remaining, 0);
    months.push({ date, paymentCents: mPayment, interestCents: mInterest, principalCents: mPrincipal, remainingCents: remaining });
    if (remaining <= 0) {
      payoffDate = date;
      break;
    }
  }

  return { months, payoffDate, totalInterestCents: totalInterest, startingRemainingCents };
}

/** One projected future installment in a single plan's amortization tail. */
export interface PlanScheduleEntry {
  /** Installment number (1-based) within the plan's scheduled payments. */
  paymentNumber: number;
  /** Projected due date (ISO), origination + paymentNumber months. */
  date: string;
  paymentCents: number;
  interestCents: number;
  principalCents: number;
  /** Remaining balance after this projected payment. */
  remainingCents: number;
}

/** ISO date N months after `iso`, preserving the day-of-month where possible. */
function addMonthsIso(iso: string, n: number): string {
  const d = new Date(iso + "T00:00:00");
  if (Number.isNaN(d.getTime())) return iso;
  d.setMonth(d.getMonth() + n);
  return d.toISOString().slice(0, 10);
}

/**
 * Project the FUTURE payments for a single plan as an amortization tail: starting
 * from `remainingCents`, apply the plan's fixed installment each month (interest =
 * remaining × APR/12, principal = installment − interest, capped at remaining)
 * until the balance reaches zero or the plan's scheduled payment count is reached.
 * `paymentsMade` is how many payments have already posted (so numbering and dates
 * continue from there). A plan with no installment amount is paid off in one final
 * payment. Returns [] when nothing remains.
 */
export function projectPlanSchedule(
  remainingCents: number,
  rateBps: number,
  installmentCents: number,
  numPayments: number,
  paymentsMade: number,
  originationDate: string
): PlanScheduleEntry[] {
  const out: PlanScheduleEntry[] = [];
  let remaining = Math.max(0, remainingCents);
  let n = paymentsMade;
  let guard = 0;
  while (remaining > 0 && guard < 600) {
    guard++;
    // Stop once the scheduled number of payments is reached, unless a balance
    // still remains (then emit a final catch-up payment so the tail pays off).
    const scheduledExhausted = numPayments > 0 && n >= numPayments;
    const interest = perInstallmentInterest(remaining, rateBps);
    const baseInstallment = installmentCents > 0 ? installmentCents : remaining + interest;
    // On the last scheduled (or catch-up) step, pay off the full remainder.
    const installment = scheduledExhausted ? remaining + interest : Math.min(baseInstallment, remaining + interest);
    const pay = Math.min(installment, remaining + interest);
    const principal = Math.min(pay - interest, remaining);
    if (principal <= 0 && interest <= 0) break; // no progress; avoid infinite loop
    remaining -= principal;
    n++;
    out.push({
      paymentNumber: n,
      date: addMonthsIso(originationDate, n),
      paymentCents: pay,
      interestCents: interest,
      principalCents: principal,
      remainingCents: remaining,
    });
    if (scheduledExhausted && remaining <= 0) break;
  }
  return out;
}
