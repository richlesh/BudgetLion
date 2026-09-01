// Balance and running-balance computation. Pure, framework-agnostic.

import type { Account, LedgerRow, LedgerTradeInfo, Transaction, TransactionSplit } from "../shared/types";

/**
 * The signed effect of a transaction on a given account, in cents.
 *  - money arriving (to_account == account) is positive (inflow)
 *  - money leaving (from_account == account) is negative (outflow)
 * A transaction referencing the account on neither side has zero effect.
 * (A pathological self-transfer where from == to nets to zero, which is correct.)
 */
export function signedAmountFor(tx: Transaction, accountId: string): number {
  let effect = 0;
  if (tx.toAccountId === accountId) effect += tx.amountCents;
  if (tx.fromAccountId === accountId) effect -= tx.amountCents;
  return effect;
}

/**
 * Signed effect of a transaction on an account, accounting for splits.
 *  - Unsplit (no legs): same as signedAmountFor.
 *  - Split, account is the owning side (tx.from/to === account): sum of all legs
 *    (equals the owning signed total by the write-time invariant).
 *  - Split, account is a transfer-leg counterparty: the inverse of the sum of the
 *    transfer legs pointing at it (money the owning account sent becomes the
 *    counterparty's inflow, and vice versa).
 */
export function effectOnAccount(
  tx: Transaction,
  splits: TransactionSplit[] | undefined,
  accountId: string
): number {
  if (!splits || splits.length === 0) return signedAmountFor(tx, accountId);
  const isOwner = tx.fromAccountId === accountId || tx.toAccountId === accountId;
  if (isOwner) {
    return splits.reduce((s, leg) => s + leg.amountCents, 0);
  }
  // Counterparty via transfer legs: inverse of the legs pointing at this account.
  const toThis = splits.reduce(
    (s, leg) => (leg.transferAccountId === accountId ? s + leg.amountCents : s),
    0
  );
  return -toThis;
}

/** Whether a transaction affects an account (owning side OR via a transfer-leg split). */
function affectsAccount(
  tx: Transaction,
  splits: TransactionSplit[] | undefined,
  accountId: string
): boolean {
  if (tx.fromAccountId === accountId || tx.toAccountId === accountId) return true;
  return !!splits?.some((leg) => leg.transferAccountId === accountId);
}

/**
 * Build the ledger for one account: filter relevant, non-deleted transactions,
 * plus a synthetic opening-balance row, sort everything chronologically (ties
 * broken by createdAt then id for stability, with the opening row ordered first
 * among same-date rows), and compute a running balance in that sorted order.
 *
 * The opening balance is modeled as a normal ledger event dated by
 * account.openingBalanceDate so it sorts by date and is editable in the UI.
 */
export function buildLedger(
  account: Account,
  transactions: Transaction[],
  splitsByTx: Map<string, TransactionSplit[]> = new Map(),
  tradeByTxn: Map<string, LedgerTradeInfo> = new Map()
): LedgerRow[] {
  const relevant = transactions.filter(
    (tx) => tx.deletedAt == null && affectsAccount(tx, splitsByTx.get(tx.id), account.id)
  );

  // Normalize to date-sortable events. The opening balance is its own event.
  // Opening date defaults to the account's creation date when not set.
  const openingDate = account.openingBalanceDate ?? account.createdAt.slice(0, 10);
  interface Event {
    kind: "opening" | "transaction";
    date: string;
    createdAt: string;
    id: string;
    signed: number;
    tx: Transaction | null;
  }

  const events: Event[] = [
    {
      kind: "opening",
      date: openingDate,
      createdAt: account.createdAt,
      id: account.id,
      signed: account.openingBalanceCents,
      tx: null,
    },
    ...relevant.map((tx) => ({
      kind: "transaction" as const,
      date: tx.date,
      createdAt: tx.createdAt,
      id: tx.id,
      signed: effectOnAccount(tx, splitsByTx.get(tx.id), account.id),
      tx,
    })),
  ];

  events.sort((a, b) => {
    if (a.date !== b.date) return a.date < b.date ? -1 : 1;
    // Among same-date rows, keep the opening balance first.
    if (a.kind !== b.kind) return a.kind === "opening" ? -1 : 1;
    if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -1 : 1;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });

  let running = 0;
  const rows: LedgerRow[] = [];
  for (const e of events) {
    running += e.signed;
    const splits = e.tx ? splitsByTx.get(e.tx.id) : undefined;
    rows.push({
      kind: e.kind,
      transaction: e.tx,
      signedAmountCents: e.signed,
      runningBalanceCents: running,
      isSplit: !!(splits && splits.length > 0),
      splits: splits ?? [],
      trade: e.tx ? tradeByTxn.get(e.tx.id) : undefined,
    });
  }
  return rows;
}

/** Current balance of an account = opening balance + sum of signed effects (split-aware). */
export function currentBalance(
  account: Account,
  transactions: Transaction[],
  splitsByTx: Map<string, TransactionSplit[]> = new Map()
): number {
  return transactions.reduce(
    (sum, tx) =>
      tx.deletedAt == null ? sum + effectOnAccount(tx, splitsByTx.get(tx.id), account.id) : sum,
    account.openingBalanceCents
  );
}
