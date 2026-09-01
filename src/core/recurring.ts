// Recurring-rule expansion, amount estimation, loan amortization, and balance
// projection. Pure, framework-agnostic. Projections are computed, never stored.

import type {
  Account,
  ForecastPoint,
  Frequency,
  ProjectedOccurrence,
  ProjectionRow,
  RecurringRule,
  Transaction,
} from "../shared/types";
import { currentBalance, signedAmountFor } from "./balances";

// ---- Date helpers (UTC-based, ISO YYYY-MM-DD) ----

function parseISO(d: string): Date {
  const [y, m, day] = d.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, day));
}
function toISO(d: Date): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(
    d.getUTCDate()
  ).padStart(2, "0")}`;
}
function addDays(d: Date, n: number): Date {
  const x = new Date(d);
  x.setUTCDate(x.getUTCDate() + n);
  return x;
}
/** Add months, clamping the day to the target month's length (or dayOfMonth). */
function addMonths(d: Date, n: number, dayOfMonth: number | null): Date {
  const year = d.getUTCFullYear();
  const month = d.getUTCMonth() + n;
  const targetYear = year + Math.floor(month / 12);
  const targetMonth = ((month % 12) + 12) % 12;
  const daysInMonth = new Date(Date.UTC(targetYear, targetMonth + 1, 0)).getUTCDate();
  const desired = dayOfMonth ?? d.getUTCDate();
  const day = Math.min(desired, daysInMonth);
  return new Date(Date.UTC(targetYear, targetMonth, day));
}

function stepDate(from: Date, freq: Frequency, interval: number, dayOfMonth: number | null): Date {
  switch (freq) {
    case "weekly":
      return addDays(from, 7 * interval);
    case "biweekly":
      return addDays(from, 14 * interval);
    case "monthly":
      return addMonths(from, interval, dayOfMonth);
    case "yearly":
      return addMonths(from, 12 * interval, dayOfMonth);
  }
}

/** Add N months to an ISO date (for horizon computation). */
export function addMonthsISO(iso: string, n: number): string {
  return toISO(addMonths(parseISO(iso), n, null));
}

/**
 * Expand a rule into occurrence dates within [rangeStart, rangeEnd] inclusive.
 * Stops at the rule's endDate if earlier than rangeEnd. Guards against runaway loops.
 */
export function expandDates(
  rule: RecurringRule,
  rangeStart: string,
  rangeEnd: string
): string[] {
  const interval = Math.max(1, rule.intervalCount || 1);
  const hardEnd = rule.endDate && rule.endDate < rangeEnd ? rule.endDate : rangeEnd;

  const dates: string[] = [];
  let cursor = parseISO(rule.startDate);
  const endD = parseISO(hardEnd);
  const startD = parseISO(rangeStart);

  let guard = 0;
  while (cursor <= endD && guard < 10000) {
    guard++;
    if (cursor >= startD) dates.push(toISO(cursor));
    cursor = stepDate(cursor, rule.frequency, interval, rule.dayOfMonth);
  }
  return dates;
}

// ---- Amount estimation ----

/** Signed magnitude a rule contributes per occurrence, from the account's view. */
export function ruleSignedAmount(rule: RecurringRule, forAccountId: string): number {
  // Direction from the account's perspective.
  const outflow = rule.fromAccountId === forAccountId;
  const inflow = rule.toAccountId === forAccountId;
  const magnitude = Math.abs(rule.amountCents ?? 0);
  if (outflow && !inflow) return -magnitude;
  if (inflow && !outflow) return magnitude;
  return 0; // rule doesn't touch this account (or self-transfer)
}

/**
 * Estimate a rule's per-occurrence magnitude (positive cents) using history.
 *  - fixed:   rule.amountCents
 *  - average: mean magnitude of matching past transactions
 *  - last:    magnitude of the most recent matching transaction
 * "Matching" = transactions sharing the rule's from/to account & category.
 */
export function estimateMagnitude(rule: RecurringRule, history: Transaction[]): number {
  if (rule.estimateMode === "fixed") return Math.abs(rule.amountCents ?? 0);

  const matches = history
    .filter((t) => t.deletedAt == null)
    .filter(
      (t) =>
        t.fromAccountId === rule.fromAccountId &&
        t.toAccountId === rule.toAccountId &&
        (rule.categoryId == null || t.categoryId === rule.categoryId)
    )
    .sort((a, b) => (a.date < b.date ? 1 : -1)); // newest first

  if (matches.length === 0) return Math.abs(rule.amountCents ?? 0);

  if (rule.estimateMode === "last") return Math.abs(matches[0].amountCents);

  // average
  const sum = matches.reduce((s, t) => s + Math.abs(t.amountCents), 0);
  return Math.round(sum / matches.length);
}

// ---- Loan amortization ----

export interface AmortizationEntry {
  date: string;
  paymentCents: number;
  interestCents: number;
  principalCents: number;
  balanceCents: number; // remaining principal after this payment
}

/**
 * Build an amortization schedule for a loan account paid by a monthly rule.
 * Uses the account's interest_rate_bps (annual) and current outstanding balance.
 * The payment magnitude comes from the rule (fixed). Interest each period is
 * balance * monthlyRate; principal is payment - interest (clamped to balance).
 */
export function amortize(
  outstandingCents: number,
  annualRateBps: number,
  paymentCents: number,
  dates: string[]
): AmortizationEntry[] {
  const monthlyRate = annualRateBps / 10000 / 12;
  let balance = Math.abs(outstandingCents);
  const out: AmortizationEntry[] = [];

  for (const date of dates) {
    if (balance <= 0) break;
    const interest = Math.round(balance * monthlyRate);
    let principal = paymentCents - interest;
    let payment = paymentCents;
    if (principal >= balance) {
      // Final payment: pay off remaining principal + this period's interest.
      principal = balance;
      payment = principal + interest;
    }
    balance -= principal;
    out.push({
      date,
      paymentCents: payment,
      interestCents: interest,
      principalCents: principal,
      balanceCents: balance,
    });
  }
  return out;
}

// ---- Projection ----

/**
 * Produce projected occurrences for a single account over [today, horizonEnd].
 * Loan accounts with a matching payment rule are amortized (principal/interest).
 */
export function projectOccurrencesForAccount(
  account: Account,
  rules: RecurringRule[],
  history: Transaction[],
  today: string,
  horizonEnd: string
): ProjectedOccurrence[] {
  const occ: ProjectedOccurrence[] = [];
  // Start projecting the day AFTER today so we don't duplicate today's actuals.
  const start = addMonthsISO(today, 0); // normalize
  const relevant = rules.filter(
    (r) => r.deletedAt == null && (r.fromAccountId === account.id || r.toAccountId === account.id)
  );

  for (const rule of relevant) {
    const dates = expandDates(rule, start, horizonEnd).filter((d) => d > today);
    if (dates.length === 0) continue;

    const magnitude = estimateMagnitude(rule, history);
    const sign = ruleSignedAmount(rule, account.id) < 0 ? -1 : 1;

    const isLoanPayment =
      account.type === "loan" &&
      rule.toAccountId === account.id && // paying INTO the loan reduces its balance
      account.interestRateBps != null;

    if (isLoanPayment && account.interestRateBps != null) {
      const outstanding = Math.abs(currentBalance(account, history));
      const schedule = amortize(outstanding, account.interestRateBps, magnitude, dates);
      for (const e of schedule) {
        occ.push({
          ruleId: rule.id,
          ruleName: rule.name,
          date: e.date,
          // Payment reduces loan balance; on a loan account, paying in is +.
          signedAmountCents: e.principalCents, // principal reduces what you owe
          fromAccountId: rule.fromAccountId,
          toAccountId: rule.toAccountId,
          categoryId: rule.categoryId,
          principalCents: e.principalCents,
          interestCents: e.interestCents,
        });
      }
    } else {
      for (const date of dates) {
        occ.push({
          ruleId: rule.id,
          ruleName: rule.name,
          date,
          signedAmountCents: sign * magnitude,
          fromAccountId: rule.fromAccountId,
          toAccountId: rule.toAccountId,
          categoryId: rule.categoryId,
        });
      }
    }
  }

  occ.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  return occ;
}

/** Projected ledger rows (occurrence + running balance) from the current balance. */
export function projectLedger(
  account: Account,
  actuals: Transaction[],
  rules: RecurringRule[],
  today: string,
  horizonEnd: string
): ProjectionRow[] {
  let running = currentBalance(account, actuals);
  const occurrences = projectOccurrencesForAccount(account, rules, actuals, today, horizonEnd);
  return occurrences.map((occurrence) => {
    running += occurrence.signedAmountCents;
    return { occurrence, runningBalanceCents: running };
  });
}

/**
 * Monthly balance-forecast points for an account across the horizon. Point 0 is
 * today's actual balance; subsequent points are end-of-month projected balances.
 */
export function balanceForecast(
  account: Account,
  actuals: Transaction[],
  rules: RecurringRule[],
  today: string,
  horizonMonths: number
): ForecastPoint[] {
  const horizonEnd = addMonthsISO(today, horizonMonths);
  const rows = projectLedger(account, actuals, rules, today, horizonEnd);

  const points: ForecastPoint[] = [{ date: today, balanceCents: currentBalance(account, actuals) }];

  // Walk month boundaries, taking the running balance as of each month end.
  for (let m = 1; m <= horizonMonths; m++) {
    const monthEnd = addMonthsISO(today, m);
    let bal = points[0].balanceCents;
    for (const r of rows) {
      if (r.occurrence.date <= monthEnd) bal = r.runningBalanceCents;
      else break;
    }
    points.push({ date: monthEnd, balanceCents: bal });
  }
  return points;
}

// Re-export for convenience in callers/tests.
export { signedAmountFor };
