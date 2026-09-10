// Transaction search. Pure, framework-agnostic. Filters the whole-DB aggregate
// data by a set of optional criteria; a transaction matches only when ALL the
// provided (non-empty) criteria match. Empty criteria are ignored.

import type { AggregateData, Transaction, TransactionSplit } from "../shared/types";

/**
 * Sentinel `categoryId` value meaning "match transactions that have no category".
 * A transaction is uncategorized when it has no inline category and none of its
 * (non-deleted) split legs carry a category, and it is not a transfer. Chosen to
 * never collide with a real category id.
 */
export const UNCATEGORIZED_CATEGORY_ID = "__uncategorized__";

/** Search criteria. Any field left null/empty is ignored. */
export interface SearchCriteria {
  /** Restrict to a single account (matches from/to or a transfer-leg split). Null = all. */
  accountId: string | null;
  /** Match transfers whose destination (to-account, or a transfer-leg target) is
   *  this account. Null = ignore. Helps find "money into X" transfers. */
  toAccountId: string | null;
  /** Inclusive ISO date lower bound (YYYY-MM-DD), or null. */
  startDate: string | null;
  /** Inclusive ISO date upper bound (YYYY-MM-DD), or null. */
  endDate: string | null;
  /** Case-insensitive substring match on payee, or empty to ignore. */
  payee: string;
  /** Case-insensitive substring match on memo (tx memo OR any split leg memo). */
  memo: string;
  /** Category id: matches the tx category OR any split leg category. Empty = ignore.
   *  UNCATEGORIZED_CATEGORY_ID matches transactions with no category at all. */
  categoryId: string;
  /** Optional SET of category ids: matches when the tx category OR any split leg
   *  category is in this set. Used by the pie chart to search a rolled-up wedge
   *  (a category plus all its descendants). Empty/undefined = ignore. Applied in
   *  addition to (AND with) categoryId when both are set. */
  categoryIds?: string[];
  /** Optional flow direction constraint (used by the pie chart so a wedge search
   *  only returns the side the wedge represents): "expense" keeps outflows,
   *  "income" keeps inflows. Undefined = ignore. Evaluated against the matched
   *  category legs (or the inline-category transaction) using the same sign
   *  convention as the charts (negative = expense, positive = income). */
  direction?: "expense" | "income";
  /** Amount magnitude in cents (abs match on tx.amountCents), or null to ignore. */
  amountCents: number | null;
}

/** True when no criteria are set (nothing to search for). */
export function isEmptyCriteria(c: SearchCriteria): boolean {
  return (
    !c.accountId &&
    !c.toAccountId &&
    !c.startDate &&
    !c.endDate &&
    c.payee.trim() === "" &&
    c.memo.trim() === "" &&
    c.categoryId === "" &&
    (!c.categoryIds || c.categoryIds.length === 0) &&
    !c.direction &&
    c.amountCents == null
  );
}

/** Does this transaction touch the given account (from/to or via a transfer leg)? */
function touchesAccount(tx: Transaction, splits: TransactionSplit[], accountId: string): boolean {
  if (tx.fromAccountId === accountId || tx.toAccountId === accountId) return true;
  return splits.some((s) => s.transferAccountId === accountId);
}

/**
 * Does the transaction (with its splits) match ALL provided criteria?
 * `splits` are the (non-deleted) split legs for this transaction only.
 */
export function matchesCriteria(
  tx: Transaction,
  splits: TransactionSplit[],
  c: SearchCriteria
): boolean {
  if (tx.deletedAt != null) return false;

  if (c.accountId && !touchesAccount(tx, splits, c.accountId)) return false;
  if (c.toAccountId) {
    // Money INTO the target account: the transaction's to-account is it, or a
    // split transfer leg targets it.
    const toTx = tx.toAccountId === c.toAccountId;
    const toLeg = splits.some((s) => s.transferAccountId === c.toAccountId);
    if (!toTx && !toLeg) return false;
  }
  if (c.startDate && tx.date < c.startDate) return false;
  if (c.endDate && tx.date > c.endDate) return false;

  const payeeQ = c.payee.trim().toLowerCase();
  if (payeeQ) {
    if (!(tx.payee ?? "").toLowerCase().includes(payeeQ)) return false;
  }

  const memoQ = c.memo.trim().toLowerCase();
  if (memoQ) {
    const inTx = (tx.memo ?? "").toLowerCase().includes(memoQ);
    const inLeg = splits.some((s) => (s.memo ?? "").toLowerCase().includes(memoQ));
    if (!inTx && !inLeg) return false;
  }

  if (c.categoryId) {
    if (c.categoryId === UNCATEGORIZED_CATEGORY_ID) {
      // Uncategorized: no inline category and no split leg carries a category.
      // Transfers are excluded (they have no category by design, but aren't
      // "uncategorized" spending/income): a transaction is a transfer when both
      // from/to accounts are set, or when any split leg is a transfer leg.
      const hasInline = tx.categoryId != null && tx.categoryId !== "";
      const hasLegCategory = splits.some((s) => s.categoryId != null && s.categoryId !== "");
      if (hasInline || hasLegCategory) return false;
      const isTransfer =
        (tx.fromAccountId != null && tx.toAccountId != null) ||
        splits.some((s) => s.transferAccountId != null);
      if (isTransfer) return false;
    } else {
      const inTx = tx.categoryId === c.categoryId;
      const inLeg = splits.some((s) => s.categoryId === c.categoryId);
      if (!inTx && !inLeg) return false;
    }
  }

  if (c.categoryIds && c.categoryIds.length > 0) {
    const set = new Set(c.categoryIds);
    // A pie wedge's subtree of categories; UNCATEGORIZED_CATEGORY_ID in the set
    // also matches transactions with no category (the "Uncategorized" wedge).
    const wantUncategorized = set.has(UNCATEGORIZED_CATEGORY_ID);
    const inTx = tx.categoryId != null && set.has(tx.categoryId);
    const inLeg = splits.some((s) => s.categoryId != null && set.has(s.categoryId));
    let matched = inTx || inLeg;
    if (!matched && wantUncategorized) {
      const hasInline = tx.categoryId != null && tx.categoryId !== "";
      const hasLegCategory = splits.some((s) => s.categoryId != null && s.categoryId !== "");
      const isTransfer =
        (tx.fromAccountId != null && tx.toAccountId != null) ||
        splits.some((s) => s.transferAccountId != null);
      matched = !hasInline && !hasLegCategory && !isTransfer;
    }
    if (!matched) return false;
  }

  if (c.direction) {
    // Keep only the requested side, mirroring the charts' sign convention:
    //  - a matched CATEGORY SPLIT LEG is an expense when negative, income when positive;
    //  - an unsplit INLINE-category transaction is an expense when it flows OUT to a
    //    category (from set, to null) and income when it flows IN (to set, from null).
    // Determine which category ids we're constraining to (categoryIds set, or the
    // single categoryId, or — when neither — any category leg / inline category).
    const set =
      c.categoryIds && c.categoryIds.length > 0
        ? new Set(c.categoryIds)
        : c.categoryId && c.categoryId !== UNCATEGORIZED_CATEGORY_ID
          ? new Set([c.categoryId])
          : null;
    const inSet = (id: string | null | undefined) => id != null && (set == null || set.has(id));

    const catLegs = splits.filter((s) => s.categoryId != null && s.transferAccountId == null && inSet(s.categoryId));
    let isExpense: boolean | null = null;
    if (catLegs.length > 0) {
      // Net the matched legs' signs (they should share a side for a given wedge).
      const net = catLegs.reduce((sum, s) => sum + s.amountCents, 0);
      isExpense = net < 0;
    } else if (tx.categoryId != null && inSet(tx.categoryId)) {
      // Unsplit inline category: expense = outflow toward a category.
      if (tx.fromAccountId != null && tx.toAccountId == null) isExpense = true;
      else if (tx.toAccountId != null && tx.fromAccountId == null) isExpense = false;
    }
    if (isExpense == null) {
      // Uncategorized (or indeterminate) side: fall back to the transaction's
      // external flow direction (outflow to external = expense).
      if (tx.fromAccountId != null && tx.toAccountId == null) isExpense = true;
      else if (tx.toAccountId != null && tx.fromAccountId == null) isExpense = false;
    }
    if (isExpense != null) {
      if (c.direction === "expense" && !isExpense) return false;
      if (c.direction === "income" && isExpense) return false;
    }
  }

  if (c.amountCents != null) {
    if (Math.abs(tx.amountCents) !== Math.abs(c.amountCents)) return false;
  }

  return true;
}

/** All matching transaction ids across the whole database. */
export function searchTransactionIds(data: AggregateData, c: SearchCriteria): Set<string> {
  const splitsByTx = new Map<string, TransactionSplit[]>();
  for (const s of data.splits) {
    if (s.deletedAt != null) continue;
    const arr = splitsByTx.get(s.transactionId) ?? [];
    arr.push(s);
    splitsByTx.set(s.transactionId, arr);
  }
  const ids = new Set<string>();
  for (const tx of data.transactions) {
    if (matchesCriteria(tx, splitsByTx.get(tx.id) ?? [], c)) ids.add(tx.id);
  }
  return ids;
}

/**
 * Account ids (in `data.accounts` order) that have at least one matching
 * transaction, given a precomputed matching-id set. An account "has" a match
 * when a matching transaction touches it (from/to or a transfer-leg split).
 *
 * When `scopeAccountId` is provided (the search was restricted to one account),
 * results are grouped under ONLY that account — the counterparty side of a
 * transfer in another account is not shown. When null, all touched accounts are
 * returned (multi-account results).
 */
export function accountsWithMatches(
  data: AggregateData,
  matchingIds: Set<string>,
  scopeAccountId: string | null = null
): string[] {
  // Single-account search: group everything under just that account.
  if (scopeAccountId) {
    return matchingIds.size > 0 ? [scopeAccountId] : [];
  }
  const splitsByTx = new Map<string, TransactionSplit[]>();
  for (const s of data.splits) {
    if (s.deletedAt != null) continue;
    const arr = splitsByTx.get(s.transactionId) ?? [];
    arr.push(s);
    splitsByTx.set(s.transactionId, arr);
  }
  const withMatch = new Set<string>();
  for (const tx of data.transactions) {
    if (!matchingIds.has(tx.id)) continue;
    const splits = splitsByTx.get(tx.id) ?? [];
    for (const a of data.accounts) {
      if (touchesAccount(tx, splits, a.id)) withMatch.add(a.id);
    }
  }
  return data.accounts.filter((a) => withMatch.has(a.id)).map((a) => a.id);
}
