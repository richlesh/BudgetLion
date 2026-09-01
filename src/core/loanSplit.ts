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
 * Split a payment into interest + principal. `annualRateBps` may be null (no rate
 * set) => zero interest, all principal. Interest is clamped to the payment; the
 * principal is the remainder (never negative).
 */
export function computeLoanPaymentSplit(
  paymentCents: number,
  balanceAsOfCents: number,
  annualRateBps: number | null
): LoanPaymentSplit {
  const payment = Math.abs(paymentCents);
  if (!annualRateBps || annualRateBps <= 0 || balanceAsOfCents <= 0) {
    return { interestCents: 0, principalCents: payment };
  }
  const monthlyRate = annualRateBps / 10000 / 12;
  let interest = Math.round(balanceAsOfCents * monthlyRate);
  if (interest > payment) interest = payment; // never exceed the payment
  const principal = payment - interest;
  return { interestCents: interest, principalCents: principal };
}
