// Transaction validation. Pure, framework-agnostic.

import type { NewTransactionInput } from "../shared/types";

export interface ValidationResult {
  ok: boolean;
  errors: string[];
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}/;

/**
 * Validate a new/edited transaction against the hybrid double-entry invariants:
 *  - amount is a non-negative integer number of cents
 *  - at least one of from/to account is set
 *  - from and to are not the same account (a no-op self transfer)
 *  - date looks like an ISO date
 */
export function validateTransaction(input: NewTransactionInput): ValidationResult {
  const errors: string[] = [];

  if (!Number.isInteger(input.amountCents)) {
    errors.push("Amount must be an integer number of cents.");
  } else if (input.amountCents < 0) {
    errors.push("Amount must be zero or positive; direction is set by From/To.");
  }

  const hasFrom = !!input.fromAccountId;
  const hasTo = !!input.toAccountId;
  if (!hasFrom && !hasTo) {
    errors.push("A transaction must have a From account, a To account, or both.");
  }
  if (hasFrom && hasTo && input.fromAccountId === input.toAccountId) {
    errors.push("From and To accounts cannot be the same.");
  }

  if (!input.date || !ISO_DATE.test(input.date)) {
    errors.push("Date must be in YYYY-MM-DD format.");
  }

  return { ok: errors.length === 0, errors };
}
