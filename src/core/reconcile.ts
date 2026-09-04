// Per-side reconcile helpers. Pure, framework-agnostic.
//
// `transaction.reconciled` is a bitmask: bit 1 (From) = the from-account side is
// reconciled, bit 2 (To) = the to-account side is reconciled. A transfer can be
// reconciled on each side independently; a plain expense/income only ever uses
// the one side it touches.

import { ReconcileBit } from "../shared/types";

/** A minimal transaction shape (from/to + reconciled) these helpers need. */
interface Reconcilable {
  fromAccountId: string | null;
  toAccountId: string | null;
  reconciled: number;
}

/**
 * The reconcile bit that applies to `accountId` for this transaction: From (1)
 * if it's the from-account, To (2) if it's the to-account, else 0 (the account
 * isn't directly on either side, e.g. a split-leg counterparty).
 */
export function reconciledBitFor(tx: Reconcilable, accountId: string): number {
  if (tx.fromAccountId === accountId) return ReconcileBit.From;
  if (tx.toAccountId === accountId) return ReconcileBit.To;
  return 0;
}

/** True when the given account's side of this transaction is reconciled. */
export function isReconciledForAccount(tx: Reconcilable, accountId: string): boolean {
  const bit = reconciledBitFor(tx, accountId);
  return bit !== 0 && (tx.reconciled & bit) !== 0;
}

/** True when either side of the transaction is reconciled (any bit set). */
export function isReconciledEitherSide(tx: Reconcilable): boolean {
  return (tx.reconciled ?? 0) !== 0;
}
