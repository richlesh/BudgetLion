// Duplicate-transaction detection. Pure, framework-agnostic, and testable.
//
// Two transactions in the SAME account are considered a potential duplicate when
// they share:
//   - the same date,
//   - the same (positive) amount in cents,
//   - the same from/to account pair — OR, for transfers (both from and to set),
//     the transposed pair (A->B matches B->A),
// AND their payees are deemed "similar".
//
// The payee-similarity decision is injected as an (async) predicate so this
// module stays pure and testable. The Electron main process supplies an
// AI-backed predicate (with an exact/null fallback when no AI is configured).

import type { Transaction } from "../shared/types";

/** A candidate/confirmed duplicate pair. `a` is the earlier-created of the two. */
export interface DuplicatePair {
  a: Transaction;
  b: Transaction;
}

/** True when both sides of the transaction are set (i.e. it's a transfer). */
function isTransfer(t: Transaction): boolean {
  return t.fromAccountId != null && t.toAccountId != null;
}

/**
 * Do two transactions match on date, amount, and from/to accounts? Transfers may
 * additionally match when their from/to are transposed (A->B vs B->A).
 */
export function sameDateAmountAndAccounts(a: Transaction, b: Transaction): boolean {
  if (a.date !== b.date) return false;
  if (a.amountCents !== b.amountCents) return false;

  const directMatch = a.fromAccountId === b.fromAccountId && a.toAccountId === b.toAccountId;
  if (directMatch) return true;

  // Transposed match is only meaningful for transfers (both endpoints present).
  if (isTransfer(a) && isTransfer(b)) {
    const transposed = a.fromAccountId === b.toAccountId && a.toAccountId === b.fromAccountId;
    if (transposed) return true;
  }
  return false;
}

/** Normalize a payee for exact comparison: trimmed + lower-cased, null-ish => null. */
function normalizePayee(payee: string | null | undefined): string | null {
  if (payee == null) return null;
  const t = payee.trim().toLowerCase();
  return t.length === 0 ? null : t;
}

/**
 * Fallback field-similarity used when no AI is configured: two text fields are
 * "similar" when they are equal (case-insensitive, trimmed) or both empty/null.
 * Used for both payee and memo comparison.
 */
export function payeesSimilarFallback(
  aPayee: string | null | undefined,
  bPayee: string | null | undefined
): boolean {
  const a = normalizePayee(aPayee);
  const b = normalizePayee(bPayee);
  if (a === null && b === null) return true;
  return a !== null && b !== null && a === b;
}

/**
 * Fallback memo-similarity used when no AI is configured. Looser than payee: two
 * memos are considered potentially equal when they are equal (case-insensitive,
 * trimmed) OR when EITHER side is empty/null. Rationale: an imported row often
 * has a bank memo while the matching hand-entered row has none, so a missing memo
 * shouldn't block an otherwise-matching duplicate.
 */
export function memosSimilarFallback(
  aMemo: string | null | undefined,
  bMemo: string | null | undefined
): boolean {
  const a = normalizePayee(aMemo);
  const b = normalizePayee(bMemo);
  if (a === null || b === null) return true; // either empty => potentially equal
  return a === b;
}

/**
 * Deterministic fallback for a whole pair: the payee must be similar
 * ({@link payeesSimilarFallback}) AND the memo must be similar
 * ({@link memosSimilarFallback}, which treats an empty/null memo on either side
 * as a potential match).
 */
export function pairSimilarFallback(
  aPayee: string | null | undefined,
  aMemo: string | null | undefined,
  bPayee: string | null | undefined,
  bMemo: string | null | undefined
): boolean {
  return payeesSimilarFallback(aPayee, bPayee) && memosSimilarFallback(aMemo, bMemo);
}

/**
 * All unordered candidate pairs that match on date/amount/accounts, BEFORE the
 * payee-similarity check. Each transaction may appear in multiple candidate
 * pairs here; overlap is resolved in {@link resolveDuplicatePairs}.
 */
export function findCandidatePairs(txns: Transaction[]): DuplicatePair[] {
  // Sort by createdAt (then id) so the earlier transaction is always `a`. This
  // gives a stable, deterministic ordering for the review dialog.
  const sorted = [...txns].sort((x, y) => {
    const c = (x.createdAt ?? "").localeCompare(y.createdAt ?? "");
    return c !== 0 ? c : x.id.localeCompare(y.id);
  });

  const pairs: DuplicatePair[] = [];
  for (let i = 0; i < sorted.length; i++) {
    for (let j = i + 1; j < sorted.length; j++) {
      if (sameDateAmountAndAccounts(sorted[i], sorted[j])) {
        pairs.push({ a: sorted[i], b: sorted[j] });
      }
    }
  }
  return pairs;
}

/**
 * Resolve confirmed duplicate pairs: for each candidate pair (matching
 * date/amount/accounts), consult the injected payee-similarity predicate. A
 * transaction is only offered once — once it appears in a confirmed pair it is
 * not reused in a later pair, so the user never sees the same transaction twice
 * in a single de-dupe pass (avoiding double-deletes).
 *
 * @param txns           Transactions of a single account.
 * @param arePairSimilar Async predicate deciding whether two transactions'
 *                       descriptive fields (payee + memo) are similar enough to
 *                       be duplicates.
 */
export async function resolveDuplicatePairs(
  txns: Transaction[],
  arePairSimilar: (a: Transaction, b: Transaction) => boolean | Promise<boolean>
): Promise<DuplicatePair[]> {
  const candidates = findCandidatePairs(txns);
  const consumed = new Set<string>();
  const confirmed: DuplicatePair[] = [];

  for (const { a, b } of candidates) {
    if (consumed.has(a.id) || consumed.has(b.id)) continue;
    const similar = await arePairSimilar(a, b);
    if (similar) {
      confirmed.push({ a, b });
      consumed.add(a.id);
      consumed.add(b.id);
    }
  }
  return confirmed;
}
