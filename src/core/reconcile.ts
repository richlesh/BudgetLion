// Per-side reconcile helpers. Pure, framework-agnostic.
//
// A transaction's `reconciled` is a 2-bit mask on its OWNING side: bit 1 (From)
// = the from-account side, bit 2 (To) = the to-account side. For a SPLIT, the
// owning account uses the transaction mask; each transfer LEG carries its own
// `reconciled` (0/1) for its counterparty account (transferAccountId).

import { ReconcileBit } from "../shared/types";

interface Reconcilable {
  fromAccountId: string | null;
  toAccountId: string | null;
  reconciled: number;
}

/** Minimal split-leg shape these helpers read. */
interface LegLike {
  transferAccountId: string | null;
  reconciled: number;
  deletedAt?: string | null;
}

/**
 * The reconcile bit that applies to `accountId` for this transaction's OWNING
 * side: From (1) if it's the from-account, To (2) if it's the to-account, else 0
 * (the account isn't the owner — it may still be a split-leg counterparty).
 */
export function reconciledBitFor(tx: Reconcilable, accountId: string): number {
  if (tx.fromAccountId === accountId) return ReconcileBit.From;
  if (tx.toAccountId === accountId) return ReconcileBit.To;
  return 0;
}

/** The non-deleted transfer legs that target `accountId` (the counterparty side). */
export function legsForAccount(splits: LegLike[] | undefined, accountId: string): LegLike[] {
  if (!splits) return [];
  return splits.filter((l) => l.deletedAt == null && l.transferAccountId === accountId);
}

/**
 * True when the given account's side of this transaction is reconciled. If the
 * account owns the transaction, it's the owning bit; otherwise the account is a
 * split transfer-leg counterparty and it's reconciled when the leg(s) targeting
 * it are all reconciled (and at least one such leg exists).
 */
export function isReconciledForAccount(
  tx: Reconcilable,
  accountId: string,
  splits?: LegLike[]
): boolean {
  const bit = reconciledBitFor(tx, accountId);
  if (bit !== 0) return (tx.reconciled & bit) !== 0;
  const legs = legsForAccount(splits, accountId);
  return legs.length > 0 && legs.every((l) => l.reconciled !== 0);
}

/**
 * True when ANY side of the transaction is reconciled — either owning bit set, or
 * any transfer leg reconciled. Used to lock editing/deletion of the whole row.
 */
export function isReconciledEitherSide(tx: Reconcilable, splits?: LegLike[]): boolean {
  if ((tx.reconciled ?? 0) !== 0) return true;
  return !!splits?.some((l) => l.deletedAt == null && l.reconciled !== 0);
}
