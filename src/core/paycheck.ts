// Paycheck-to-transaction builder. Pure, framework-agnostic (no Electron/DB/React).
//
// Model (gross-as-income, deductions as real legs):
//   A paycheck becomes ONE split income transaction deposited into an account:
//     - deposit account is the TO side; amount = NET pay (gross - deductions)
//     - leg 1: +gross  -> an income category (e.g. Income:Salary)
//     - leg N: -deduction -> an expense category OR a transfer to another account
//     The legs are SIGNED (owning-account perspective) and sum to +net, which is
//     exactly the invariant enforced by the DB's writeSplits(). Mixed signs are
//     fine at the storage layer; only the general Split editor UI assumes a
//     uniform sign, which is why paychecks use this dedicated builder instead.
//
//   Employer contributions (e.g. a 401(k) match) do NOT pass through net pay, so
//   each becomes a SEPARATE transaction: money from an income category into the
//   target account/category. These are returned alongside the deposit transaction.

import type {
  AggregateData,
  EmployerContribution,
  NewSplitInput,
  NewTransactionInput,
  PaycheckDeduction,
  PaycheckInput,
  Transaction,
  TransactionSplit,
} from "../shared/types";

export interface PaycheckBuildResult {
  /** The main net-deposit split transaction, plus any employer-contribution transactions. */
  transactions: NewTransactionInput[];
  /** Computed net pay in cents (gross - total deductions). */
  netCents: number;
  /** Sum of all employee-side deductions in cents. */
  totalDeductionsCents: number;
}

export class PaycheckError extends Error {}

/** Sum of the (positive) deduction magnitudes. */
export function totalDeductions(deductions: PaycheckDeduction[]): number {
  return deductions.reduce((s, d) => s + Math.max(0, Math.round(d.amountCents)), 0);
}

/** Net pay = gross - total deductions (may not go negative). */
export function netPay(input: PaycheckInput): number {
  return Math.round(input.grossCents) - totalDeductions(input.deductions);
}

/** Map a deduction/contribution's target to a split leg field pair (validating the target). */
function legTargetFields(
  line: { target: "category" | "transfer"; categoryId?: string | null; accountId?: string | null },
  what: string
): { categoryId: string | null; transferAccountId: string | null } {
  if (line.target === "category") {
    if (!line.categoryId) throw new PaycheckError(`${what} is missing its category.`);
    return { categoryId: line.categoryId, transferAccountId: null };
  }
  if (!line.accountId) throw new PaycheckError(`${what} is missing its transfer account.`);
  return { categoryId: null, transferAccountId: line.accountId };
}

/**
 * Build the transaction(s) for a paycheck. Throws PaycheckError on invalid input
 * (missing gross category, zero gross, a deduction/contribution with no target,
 * non-positive amounts, or deductions exceeding gross).
 */
export function buildPaycheckTransactions(input: PaycheckInput): PaycheckBuildResult {
  const gross = Math.round(input.grossCents);
  if (!input.depositAccountId) throw new PaycheckError("Choose a deposit account.");
  if (gross <= 0) throw new PaycheckError("Gross pay must be greater than zero.");
  if (!input.grossCategoryId) throw new PaycheckError("Choose an income category for gross pay.");

  for (const d of input.deductions) {
    if (Math.round(d.amountCents) <= 0) {
      throw new PaycheckError(`Deduction "${d.label || "(unnamed)"}" must have a positive amount.`);
    }
  }

  const totalDed = totalDeductions(input.deductions);
  const net = gross - totalDed;
  if (net < 0) {
    throw new PaycheckError("Total deductions exceed gross pay.");
  }

  // Build the signed legs (owning = deposit account, an inflow, so net is +).
  const legs: NewSplitInput[] = [];
  // Gross income leg: positive.
  legs.push({ amountCents: gross, categoryId: input.grossCategoryId, memo: "Gross pay" });
  // Deduction legs: negative.
  for (const d of input.deductions) {
    const fields = legTargetFields(d, `Deduction "${d.label || "(unnamed)"}"`);
    legs.push({
      amountCents: -Math.round(d.amountCents),
      categoryId: fields.categoryId,
      transferAccountId: fields.transferAccountId,
      memo: d.label.trim() || null,
    });
  }

  // Sanity: legs must sum to +net (the writeSplits invariant).
  const legSum = legs.reduce((s, l) => s + l.amountCents, 0);
  if (legSum !== net) {
    // Should be unreachable given the arithmetic above; guard anyway.
    throw new PaycheckError(`Internal error: legs (${legSum}) do not sum to net (${net}).`);
  }

  const memoBits = [`Gross ${(gross / 100).toFixed(2)}`, `Net ${(net / 100).toFixed(2)}`];
  const depositTx: NewTransactionInput = {
    date: input.date,
    payee: input.employer.trim() || null,
    memo: input.memo?.trim() || memoBits.join(" · "),
    amountCents: net,
    fromAccountId: null,
    toAccountId: input.depositAccountId,
    categoryId: null, // split carries the detail
    splits: net === 0 && legs.length < 2 ? null : legs,
  };

  const transactions: NewTransactionInput[] = [depositTx];

  // Employer contributions: each a separate transaction (income -> target).
  for (const c of input.employerContributions ?? []) {
    transactions.push(buildEmployerContribution(c, input));
  }

  return { transactions, netCents: net, totalDeductionsCents: totalDed };
}

/**
 * An employer contribution as its own transaction. When routed to a transfer
 * account, it's income arriving in that account attributed to a source income
 * category via a two-leg split (so it shows as both income and a balance bump).
 * When routed to a category, it's a plain income transaction into... nothing
 * cash-bearing, which isn't meaningful, so a transfer target is required.
 */
export function buildEmployerContribution(
  c: EmployerContribution,
  input: PaycheckInput
): NewTransactionInput {
  const amt = Math.round(c.amountCents);
  if (amt <= 0) {
    throw new PaycheckError(`Employer contribution "${c.label || "(unnamed)"}" must be positive.`);
  }
  if (c.target !== "transfer" || !c.accountId) {
    throw new PaycheckError(
      `Employer contribution "${c.label || "(unnamed)"}" must target a tracked account (e.g. a 401(k)).`
    );
  }
  // Money enters the target account. Attribute it to an income category via a
  // single inline category income transaction (to = target account).
  return {
    date: input.date,
    payee: input.employer.trim() || null,
    memo: c.label.trim() || "Employer contribution",
    amountCents: amt,
    fromAccountId: null,
    toAccountId: c.accountId,
    categoryId: c.sourceCategoryId ?? null,
  };
}

/** A minimal split-leg shape both stored splits and draft legs satisfy. */
interface LegLike {
  amountCents: number;
  categoryId?: string | null;
  transferAccountId?: string | null;
  memo?: string | null;
}

/**
 * A split is "paycheck-shaped" when its legs contain BOTH a positive (income)
 * leg and a negative (deduction) leg — the mixed-sign signature that only the
 * paycheck builder produces. Ordinary splits and loan splits are single-signed.
 */
export function isPaycheckSplit(legs: LegLike[] | undefined | null): boolean {
  if (!legs || legs.length < 2) return false;
  let hasPos = false;
  let hasNeg = false;
  for (const l of legs) {
    if (l.amountCents > 0) hasPos = true;
    else if (l.amountCents < 0) hasNeg = true;
    if (hasPos && hasNeg) return true;
  }
  return false;
}

/**
 * Reconstruct a PaycheckInput from a stored paycheck split so it can be reopened
 * in the Paycheck dialog. Positive legs are gross income (summed; the first
 * positive category leg supplies grossCategoryId); negative legs become
 * deductions routed to their category or transfer account, labeled by memo.
 *
 * Employer contributions are separate transactions and cannot be recovered from
 * a single deposit split, so the reconstruction omits them.
 */
export function reconstructPaycheckInput(
  legs: LegLike[],
  meta: { date: string; employer: string; depositAccountId: string; memo?: string | null }
): PaycheckInput {
  let grossCents = 0;
  let grossCategoryId = "";
  const deductions: PaycheckDeduction[] = [];

  for (const l of legs) {
    if (l.amountCents > 0) {
      grossCents += l.amountCents;
      if (!grossCategoryId && l.categoryId) grossCategoryId = l.categoryId;
    } else if (l.amountCents < 0) {
      const magnitude = -l.amountCents;
      if (l.transferAccountId) {
        deductions.push({
          label: l.memo ?? "",
          amountCents: magnitude,
          target: "transfer",
          accountId: l.transferAccountId,
        });
      } else {
        deductions.push({
          label: l.memo ?? "",
          amountCents: magnitude,
          target: "category",
          categoryId: l.categoryId ?? null,
        });
      }
    }
  }

  return {
    date: meta.date,
    employer: meta.employer,
    memo: meta.memo ?? null,
    depositAccountId: meta.depositAccountId,
    grossCents,
    grossCategoryId,
    deductions,
    employerContributions: [],
  };
}

/** A learned routing target for a deduction label. */
export interface LearnedTarget {
  target: "category" | "transfer";
  categoryId?: string | null;
  accountId?: string | null;
}

/** Result of learning from prior paychecks of the same employer. */
export interface LearnedPaycheck {
  /** normalized-label -> most-recent target seen for that deduction. */
  labelToTarget: Map<string, LearnedTarget>;
  /** Distinct prior deduction line items (original label + target), newest first. */
  priorDeductions: Array<{ label: string; target: LearnedTarget }>;
  /** The gross income category most recently used, if any. */
  grossCategoryId: string | null;
  /** How many prior paychecks were examined. */
  sampleCount: number;
}

/** Normalize a deduction label for matching (lowercase, collapse spaces/punct). */
export function normalizeLabel(label: string): string {
  return label.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

/**
 * Learn deduction routing from the most recent paychecks of the same employer.
 *
 * Scans `data` for transactions whose payee matches `employer` (case-insensitive)
 * that are paycheck-shaped splits (mixed-sign legs) and deposit into
 * `depositAccountId`, newest first, up to `maxPaychecks`. From their negative
 * (deduction) legs it builds a normalized-label -> target map (most recent wins)
 * and a de-duplicated list of prior deduction line items. Also captures the most
 * recent gross income category. Pure/framework-agnostic.
 */
export function learnPaycheckTargets(
  data: Pick<AggregateData, "transactions" | "splits">,
  employer: string,
  depositAccountId: string,
  maxPaychecks = 5
): LearnedPaycheck {
  const empKey = employer.trim().toLowerCase();
  const empty: LearnedPaycheck = {
    labelToTarget: new Map(),
    priorDeductions: [],
    grossCategoryId: null,
    sampleCount: 0,
  };
  if (!empKey) return empty;

  const splitsByTx = new Map<string, TransactionSplit[]>();
  for (const s of data.splits) {
    if (s.deletedAt != null) continue;
    const arr = splitsByTx.get(s.transactionId) ?? [];
    arr.push(s);
    splitsByTx.set(s.transactionId, arr);
  }

  // Candidate paycheck transactions for this employer + deposit account.
  const candidates = data.transactions
    .filter((tx: Transaction) => {
      if (tx.deletedAt != null) return false;
      if ((tx.payee ?? "").trim().toLowerCase() !== empKey) return false;
      if (tx.toAccountId !== depositAccountId) return false;
      const legs = splitsByTx.get(tx.id);
      return isPaycheckSplit(legs);
    })
    // Newest first (by date, then createdAt for ties).
    .sort((a, b) => (a.date !== b.date ? (a.date < b.date ? 1 : -1) : a.createdAt < b.createdAt ? 1 : -1))
    .slice(0, maxPaychecks);

  const labelToTarget = new Map<string, LearnedTarget>();
  const priorDeductions: Array<{ label: string; target: LearnedTarget }> = [];
  const seenPrior = new Set<string>();
  let grossCategoryId: string | null = null;

  for (const tx of candidates) {
    const legs = splitsByTx.get(tx.id) ?? [];
    for (const leg of legs) {
      if (leg.amountCents > 0) {
        // Gross income leg — remember the most recent (candidates are newest-first).
        if (grossCategoryId == null && leg.categoryId) grossCategoryId = leg.categoryId;
        continue;
      }
      if (leg.amountCents >= 0) continue; // skip zero
      const label = leg.memo ?? "";
      const key = normalizeLabel(label);
      if (!key) continue;
      const target: LearnedTarget = leg.transferAccountId
        ? { target: "transfer", accountId: leg.transferAccountId }
        : { target: "category", categoryId: leg.categoryId ?? null };
      // Most-recent wins (candidates newest-first, so only set once).
      if (!labelToTarget.has(key)) labelToTarget.set(key, target);
      if (!seenPrior.has(key)) {
        seenPrior.add(key);
        priorDeductions.push({ label, target });
      }
    }
  }

  return { labelToTarget, priorDeductions, grossCategoryId, sampleCount: candidates.length };
}
