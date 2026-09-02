// Transaction search. Pure, framework-agnostic. Filters the whole-DB aggregate
// data by a set of optional criteria; a transaction matches only when ALL the
// provided (non-empty) criteria match. Empty criteria are ignored.

import type { AggregateData, Transaction, TransactionSplit } from "../shared/types";

/** Search criteria. Any field left null/empty is ignored. */
export interface SearchCriteria {
  /** Restrict to a single account (matches from/to or a transfer-leg split). Null = all. */
  accountId: string | null;
  /** Inclusive ISO date lower bound (YYYY-MM-DD), or null. */
  startDate: string | null;
  /** Inclusive ISO date upper bound (YYYY-MM-DD), or null. */
  endDate: string | null;
  /** Case-insensitive substring match on payee, or empty to ignore. */
  payee: string;
  /** Case-insensitive substring match on memo (tx memo OR any split leg memo). */
  memo: string;
  /** Category id: matches the tx category OR any split leg category. Empty = ignore. */
  categoryId: string;
  /** Amount magnitude in cents (abs match on tx.amountCents), or null to ignore. */
  amountCents: number | null;
}

/** True when no criteria are set (nothing to search for). */
export function isEmptyCriteria(c: SearchCriteria): boolean {
  return (
    !c.accountId &&
    !c.startDate &&
    !c.endDate &&
    c.payee.trim() === "" &&
    c.memo.trim() === "" &&
    c.categoryId === "" &&
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
    const inTx = tx.categoryId === c.categoryId;
    const inLeg = splits.some((s) => s.categoryId === c.categoryId);
    if (!inTx && !inLeg) return false;
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
