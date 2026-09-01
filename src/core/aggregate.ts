// Chart aggregation. Pure, framework-agnostic. Operates on raw domain objects so
// the renderer can re-aggregate instantly as filters change.
//
// Spending semantics:
//  - "Spending" = money leaving the scope toward a CATEGORY (an expense), not a
//    transfer between tracked accounts (transfers just move money around).
//  - Account scope: outflow from the selected account (from_account_id == account).
//  - All-accounts scope: outflow whose other side is NOT a tracked account
//    (to_account_id is null), i.e. real expenses leaving the system.
//  - Split transactions attribute each category leg's outflow to its category.

import type {
  Account,
  AggregateData,
  CategorySpend,
  ChartScope,
  DateRange,
  MonthSpend,
  Transaction,
  TransactionSplit,
} from "../shared/types";
import { categoryDisplayName } from "./categories";

function inRange(date: string, range: DateRange): boolean {
  if (range.start && date < range.start) return false;
  if (range.end && date > range.end) return false;
  return true;
}

/** Is this transaction within the given scope at all (touches the scoped account)? */
function touchesScope(tx: Transaction, scope: ChartScope): boolean {
  if (scope.kind === "all") return true;
  return tx.fromAccountId === scope.accountId || tx.toAccountId === scope.accountId;
}

/** Is this a transfer between two tracked accounts (not real spending/income)? */
function isInternalTransfer(tx: Transaction): boolean {
  return !!(tx.fromAccountId && tx.toAccountId);
}

/**
 * Signed effect of a transaction on the scope for SPENDING/INCOME purposes, in
 * cents (outflow negative). Internal transfers (both sides tracked) are excluded
 * entirely — moving money between your own accounts is neither spending nor income.
 *  - account scope: the account's own outflow/inflow, excluding internal transfers
 *  - all scope: only legs whose other side is external (null)
 */
function scopeSignedAmount(tx: Transaction, scope: ChartScope): number {
  if (isInternalTransfer(tx)) return 0; // transfers aren't spending or income
  if (scope.kind === "account") {
    let eff = 0;
    if (tx.toAccountId === scope.accountId) eff += tx.amountCents;
    if (tx.fromAccountId === scope.accountId) eff -= tx.amountCents;
    return eff;
  }
  // all-accounts: only external-facing legs (one side null)
  let eff = 0;
  if (tx.toAccountId && !tx.fromAccountId) eff += tx.amountCents; // income from external
  if (tx.fromAccountId && !tx.toAccountId) eff -= tx.amountCents; // expense to external
  return eff;
}

/**
 * For a transaction that is an OUTFLOW in scope, return the category->outflow
 * magnitude contributions. Handles splits (category legs only) and unsplit
 * transactions (single inline category). Transfer legs are ignored.
 */
function outflowByCategory(
  tx: Transaction,
  splits: TransactionSplit[],
  scope: ChartScope
): Array<{ categoryId: string | null; amountCents: number }> {
  const scopeSigned = scopeSignedAmount(tx, scope);
  if (scopeSigned >= 0) return []; // not an outflow in this scope

  const txSplits = splits.filter((s) => s.transactionId === tx.id && s.deletedAt == null);
  if (txSplits.length > 0) {
    // Split: each category leg with a negative (outflow) signed amount contributes.
    const out: Array<{ categoryId: string | null; amountCents: number }> = [];
    for (const s of txSplits) {
      if (s.transferAccountId) continue; // transfer leg, not spending
      if (s.amountCents < 0) {
        out.push({ categoryId: s.categoryId, amountCents: Math.abs(s.amountCents) });
      }
    }
    // If splits didn't cover the whole outflow (or were all transfers), ignore remainder.
    return out;
  }

  // Unsplit: the whole outflow belongs to the inline category (or uncategorized).
  return [{ categoryId: tx.categoryId, amountCents: Math.abs(scopeSigned) }];
}

export function spendingByCategory(
  data: AggregateData,
  scope: ChartScope,
  range: DateRange
): CategorySpend[] {
  const catName = new Map(data.categories.map((c) => [c.id, categoryDisplayName(c, data.categories)]));
  const totals = new Map<string | null, number>();

  for (const tx of data.transactions) {
    if (tx.deletedAt != null) continue;
    if (!touchesScope(tx, scope)) continue;
    if (!inRange(tx.date, range)) continue;

    for (const { categoryId, amountCents } of outflowByCategory(tx, data.splits, scope)) {
      totals.set(categoryId, (totals.get(categoryId) ?? 0) + amountCents);
    }
  }

  const result: CategorySpend[] = [];
  for (const [categoryId, amountCents] of totals) {
    if (amountCents === 0) continue;
    result.push({
      categoryId,
      categoryName: categoryId ? catName.get(categoryId) ?? "(unknown)" : "Uncategorized",
      amountCents,
    });
  }
  result.sort((a, b) => b.amountCents - a.amountCents);
  return result;
}

export function spendingByMonth(
  data: AggregateData,
  scope: ChartScope,
  range: DateRange
): MonthSpend[] {
  const months = new Map<string, { spending: number; income: number }>();

  for (const tx of data.transactions) {
    if (tx.deletedAt != null) continue;
    if (!touchesScope(tx, scope)) continue;
    if (!inRange(tx.date, range)) continue;

    const signed = scopeSignedAmount(tx, scope);
    if (signed === 0) continue;
    const month = tx.date.slice(0, 7); // YYYY-MM
    const bucket = months.get(month) ?? { spending: 0, income: 0 };
    if (signed < 0) bucket.spending += Math.abs(signed);
    else bucket.income += signed;
    months.set(month, bucket);
  }

  return Array.from(months.entries())
    .map(([month, v]) => ({ month, spendingCents: v.spending, incomeCents: v.income }))
    .sort((a, b) => (a.month < b.month ? -1 : 1));
}

/** Default range covering the transactions present (earliest..latest), for UI init. */
export function dataDateBounds(data: AggregateData): DateRange {
  let min: string | null = null;
  let max: string | null = null;
  for (const tx of data.transactions) {
    if (tx.deletedAt != null) continue;
    if (min == null || tx.date < min) min = tx.date;
    if (max == null || tx.date > max) max = tx.date;
  }
  return { start: min, end: max };
}

/** Human label for a scope (account name or "All accounts"). */
export function scopeLabel(scope: ChartScope, accounts: Account[]): string {
  if (scope.kind === "all") return "All accounts";
  return accounts.find((a) => a.id === scope.accountId)?.name ?? "Account";
}
