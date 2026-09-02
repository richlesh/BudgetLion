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
  Category,
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

/** Which side of the ledger a category chart aggregates. */
export type FlowDirection = "expense" | "income";

/**
 * For a transaction that flows in the requested DIRECTION within scope, return
 * the category->magnitude contributions. "expense" counts outflows (negative in
 * scope); "income" counts inflows (positive). Handles splits (category legs
 * only) and unsplit transactions (single inline category). Transfer legs are
 * ignored.
 */
function flowByCategory(
  tx: Transaction,
  splits: TransactionSplit[],
  scope: ChartScope,
  direction: FlowDirection
): Array<{ categoryId: string | null; amountCents: number }> {
  const scopeSigned = scopeSignedAmount(tx, scope);
  const wantOutflow = direction === "expense";
  // Skip transactions whose net scope effect is on the other side.
  if (wantOutflow ? scopeSigned >= 0 : scopeSigned <= 0) return [];

  const txSplits = splits.filter((s) => s.transactionId === tx.id && s.deletedAt == null);
  if (txSplits.length > 0) {
    const out: Array<{ categoryId: string | null; amountCents: number }> = [];
    for (const s of txSplits) {
      if (s.transferAccountId) continue; // transfer leg, not spending/income
      // Expense legs are negative; income legs are positive.
      if (wantOutflow ? s.amountCents < 0 : s.amountCents > 0) {
        out.push({ categoryId: s.categoryId, amountCents: Math.abs(s.amountCents) });
      }
    }
    return out;
  }

  // Unsplit: the whole flow belongs to the inline category (or uncategorized).
  return [{ categoryId: tx.categoryId, amountCents: Math.abs(scopeSigned) }];
}

/**
 * Category breakdown for a scope/range in one direction: "expense" (spending) or
 * "income". Amounts are positive magnitudes, sorted descending.
 */
export function categoryFlow(
  data: AggregateData,
  scope: ChartScope,
  range: DateRange,
  direction: FlowDirection
): CategorySpend[] {
  const catName = new Map(data.categories.map((c) => [c.id, categoryDisplayName(c, data.categories)]));
  const totals = new Map<string | null, number>();

  for (const tx of data.transactions) {
    if (tx.deletedAt != null) continue;
    if (!touchesScope(tx, scope)) continue;
    if (!inRange(tx.date, range)) continue;

    for (const { categoryId, amountCents } of flowByCategory(tx, data.splits, scope, direction)) {
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

/** Backward-compatible spending (expense) breakdown by category. */
export function spendingByCategory(
  data: AggregateData,
  scope: ChartScope,
  range: DateRange
): CategorySpend[] {
  return categoryFlow(data, scope, range, "expense");
}

/**
 * One wedge of a drill-down pie chart.
 *  - `categoryId` is the category this wedge represents (null = Uncategorized,
 *    or the synthetic "own spending" wedge of the current parent). It is
 *    `OTHER_ID` for the synthetic "Other" bucket of small top-level slices.
 *  - `amountCents` is the rolled-up total for this wedge (the category's own
 *    spending plus all of its descendants when it is a rollup wedge).
 *  - `drillable` is true when clicking should descend (into direct children, or
 *    into the members of the "Other" bucket).
 */
export interface PieWedge {
  categoryId: string | null;
  categoryName: string;
  amountCents: number;
  drillable: boolean;
}

/**
 * Sentinel category id for the synthetic "Other" bucket that collects small
 * top-level slices. Not a real category id (real ids are UUIDs), so it can be
 * used both as a wedge id and as a drill-path entry.
 */
export const OTHER_ID = "__other__";

/** Top-level slices at or below this fraction of the top-level total are pooled into "Other". */
const OTHER_THRESHOLD = 0.02; // 2%

/**
 * Build the pie wedges to display for a given drill level from a flat
 * per-leaf-category breakdown (as produced by `categoryFlow`).
 *
 * Rollup semantics:
 *  - At the top level (`parentId == null`): one wedge per top-level category
 *    whose subtree carries any spending, each summing its own spending plus all
 *    descendants. "Uncategorized" is included as its own wedge. Any of these
 *    slices worth less than 2% of the top-level total are pooled into a single
 *    drillable "Other" wedge.
 *  - Drilled into "Other" (`parentId === OTHER_ID`): the individual small
 *    top-level slices that were pooled, each still drillable if it has children.
 *  - Drilled into a parent category: a wedge for the parent's OWN direct
 *    spending (if any), plus one rolled-up wedge per direct child that carries
 *    spending.
 *
 * A category wedge is `drillable` when it has at least one child (with spending)
 * below it. The parent's own-spending wedge is never drillable.
 */
export function pieWedges(
  flow: CategorySpend[],
  categories: Category[],
  parentId: string | null
): PieWedge[] {
  const byId = new Map(categories.map((c) => [c.id, c]));
  // children[parentId] -> direct child category ids
  const childrenOf = new Map<string | null, string[]>();
  for (const c of categories) {
    if (c.deletedAt != null) continue;
    const key = c.parentId ?? null;
    const arr = childrenOf.get(key) ?? [];
    arr.push(c.id);
    childrenOf.set(key, arr);
  }

  // Own (leaf) spending directly attributed to each category id.
  const ownAmount = new Map<string | null, number>();
  for (const f of flow) ownAmount.set(f.categoryId, (ownAmount.get(f.categoryId) ?? 0) + f.amountCents);

  // Rolled-up total for a category subtree (own + all descendants). Memoized.
  const subtreeCache = new Map<string, number>();
  function subtreeTotal(catId: string): number {
    const cached = subtreeCache.get(catId);
    if (cached != null) return cached;
    let total = ownAmount.get(catId) ?? 0;
    for (const childId of childrenOf.get(catId) ?? []) total += subtreeTotal(childId);
    subtreeCache.set(catId, total);
    return total;
  }

  function hasSpendingBelow(catId: string): boolean {
    for (const childId of childrenOf.get(catId) ?? []) {
      if (subtreeTotal(childId) > 0) return true;
    }
    return false;
  }

  /** All top-level rollup wedges (each top-level category subtree + Uncategorized), unsorted. */
  function topLevelWedges(): PieWedge[] {
    const out: PieWedge[] = [];
    for (const catId of childrenOf.get(null) ?? []) {
      const amt = subtreeTotal(catId);
      if (amt <= 0) continue;
      const cat = byId.get(catId);
      out.push({
        categoryId: catId,
        categoryName: cat ? cat.name : "(unknown)",
        amountCents: amt,
        drillable: hasSpendingBelow(catId),
      });
    }
    const uncategorized = ownAmount.get(null) ?? 0;
    if (uncategorized > 0) {
      out.push({ categoryId: null, categoryName: "Uncategorized", amountCents: uncategorized, drillable: false });
    }
    return out;
  }

  let wedges: PieWedge[];

  if (parentId == null) {
    // Top level: pool slices under the threshold into a single "Other" wedge.
    const all = topLevelWedges();
    const total = all.reduce((s, w) => s + w.amountCents, 0);
    const cutoff = total * OTHER_THRESHOLD;
    // Only pool when at least two slices fall below the cutoff — a lone small
    // slice is clearer shown as itself than hidden behind an "Other" click.
    const small = all.filter((w) => w.amountCents < cutoff);
    if (small.length >= 2) {
      const large = all.filter((w) => w.amountCents >= cutoff);
      const otherTotal = small.reduce((s, w) => s + w.amountCents, 0);
      wedges = [
        ...large,
        { categoryId: OTHER_ID, categoryName: "Other", amountCents: otherTotal, drillable: true },
      ];
    } else {
      wedges = all;
    }
  } else if (parentId === OTHER_ID) {
    // Drilled into "Other": show the small top-level slices individually.
    const all = topLevelWedges();
    const total = all.reduce((s, w) => s + w.amountCents, 0);
    const cutoff = total * OTHER_THRESHOLD;
    wedges = all.filter((w) => w.amountCents < cutoff);
  } else {
    // Drilled into `parentId`: the parent's own spending + each child subtree.
    const parent = byId.get(parentId);
    const own = ownAmount.get(parentId) ?? 0;
    const out: PieWedge[] = [];
    if (own > 0) {
      out.push({
        categoryId: parentId,
        categoryName: parent ? parent.name : "(unknown)",
        amountCents: own,
        drillable: false,
      });
    }
    for (const childId of childrenOf.get(parentId) ?? []) {
      const amt = subtreeTotal(childId);
      if (amt <= 0) continue;
      const child = byId.get(childId);
      out.push({
        categoryId: childId,
        categoryName: child ? child.name : "(unknown)",
        amountCents: amt,
        drillable: hasSpendingBelow(childId),
      });
    }
    wedges = out;
  }

  wedges.sort((a, b) => b.amountCents - a.amountCents);
  return wedges;
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
