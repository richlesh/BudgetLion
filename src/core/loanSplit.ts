// Auto principal/interest split for a loan payment. Pure/framework-agnostic.
//
// Given a loan account's rate and outstanding balance AS OF a payment date, split
// a payment into interest (this period) and principal (the remainder):
//   monthlyRate = annualRateBps / 10000 / 12
//   interest    = round(balanceAsOfDate * monthlyRate)   (0 if no rate)
//   principal   = payment - interest                     (clamped to >= 0)

import type { Account, Transaction, TransactionSplit } from "../shared/types";
import { effectOnAccount } from "./balances";

export interface LoanPaymentSplit {
  interestCents: number;
  principalCents: number;
  escrowCents: number;
}

/**
 * The loan account's outstanding balance (magnitude) as of `asOfDate`, computed
 * from its opening balance + all its non-deleted transactions dated on or before
 * that date, EXCLUDING the payment transaction itself (so the interest is charged
 * on the balance before this payment is applied). Split-aware.
 */
export function loanBalanceAsOf(
  loan: Account,
  transactions: Transaction[],
  splitsByTx: Map<string, TransactionSplit[]>,
  asOfDate: string,
  excludeTxId: string | null
): number {
  let bal = loan.openingBalanceCents;
  for (const tx of transactions) {
    if (tx.deletedAt != null) continue;
    if (excludeTxId && tx.id === excludeTxId) continue;
    if (tx.date > asOfDate) continue;
    bal += effectOnAccount(tx, splitsByTx.get(tx.id), loan.id);
  }
  return Math.abs(bal);
}

/**
 * Split a payment into interest + escrow + principal. Interest is charged on the
 * loan balance (unaffected by escrow). Escrow is a fixed portion (0/undefined =
 * none), clamped so interest + escrow never exceed the payment. Principal is the
 * remainder: payment - interest - escrow (never negative). `annualRateBps` null
 * => zero interest.
 */
export function computeLoanPaymentSplit(
  paymentCents: number,
  balanceAsOfCents: number,
  annualRateBps: number | null,
  escrowCents = 0
): LoanPaymentSplit {
  const payment = Math.abs(paymentCents);
  // Interest on the balance (independent of escrow).
  let interest = 0;
  if (annualRateBps && annualRateBps > 0 && balanceAsOfCents > 0) {
    const monthlyRate = annualRateBps / 10000 / 12;
    interest = Math.round(balanceAsOfCents * monthlyRate);
  }
  if (interest > payment) interest = payment;

  // Escrow takes what's left after interest (can't push the total past payment).
  let escrow = Math.max(0, escrowCents);
  if (interest + escrow > payment) escrow = payment - interest;

  const principal = payment - interest - escrow;
  return { interestCents: interest, principalCents: principal, escrowCents: escrow };
}
