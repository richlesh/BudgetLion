// Shared domain types used by both the Electron main process and the React renderer.
// Framework-agnostic: no imports from Electron, React, or the DB driver.
// Money is always represented as integer cents (minor currency units) to avoid float errors.

export type AccountType = "checking" | "savings" | "credit_card" | "loan";

/** Clearance state of a transaction. */
export enum ClearedState {
  Uncleared = 0,
  Cleared = 1,
  Reconciled = 2,
}

export interface Account {
  id: string; // UUID
  name: string;
  type: AccountType;
  currency: string; // ISO 4217, e.g. "USD"
  accountCode: string | null; // user-specifiable Account ID (external/bank id)
  openingBalanceCents: number;
  openingBalanceDate: string | null; // ISO 8601 date for the opening balance (nullable)
  // Loan/mortgage fields (null for non-loan accounts)
  interestRateBps: number | null; // annual rate in basis points (e.g. 4.25% => 425)
  principalCents: number | null;
  termMonths: number | null;
  createdAt: string; // ISO 8601
  updatedAt: string; // ISO 8601
  deletedAt: string | null; // soft delete
}

/** Whether a category applies to income, expense, or both directions. */
export type CategoryApplicability = "income" | "expense" | "both";

export interface Category {
  id: string; // UUID
  name: string;
  parentId: string | null;
  applicability: CategoryApplicability;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

/**
 * Hybrid double-entry transaction (Option B).
 * - amountCents is always POSITIVE; direction is implied by from/to.
 * - Transfer:  fromAccountId + toAccountId set, categoryId null.
 * - Expense:   fromAccountId set, toAccountId null, categoryId set (spending category).
 * - Income:    toAccountId set, fromAccountId null, categoryId set (income category).
 * Invariant: at least one of fromAccountId / toAccountId must be set.
 */
export interface Transaction {
  id: string; // UUID
  date: string; // ISO 8601 date
  payee: string | null;
  memo: string | null;
  amountCents: number; // always >= 0
  fromAccountId: string | null;
  toAccountId: string | null;
  categoryId: string | null;
  cleared: ClearedState;
  importId: string | null; // bank FITID etc., for dedupe
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

/**
 * A split line item of a transaction. `amountCents` is SIGNED relative to the
 * owning account (the transaction's from/to perspective). Each split is EITHER a
 * category leg (categoryId set) OR a transfer leg (transferAccountId set).
 */
export interface TransactionSplit {
  id: string;
  transactionId: string;
  amountCents: number; // signed
  categoryId: string | null;
  transferAccountId: string | null;
  memo: string | null;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

/** Input for one split leg when creating/updating a split transaction. */
export interface NewSplitInput {
  amountCents: number; // signed (owning-account perspective)
  categoryId?: string | null;
  transferAccountId?: string | null;
  memo?: string | null;
}

/** Input shape for creating an account (server fills id/timestamps). */
export interface NewAccountInput {
  name: string;
  type: AccountType;
  currency?: string;
  accountCode?: string | null;
  openingBalanceCents?: number;
  openingBalanceDate?: string | null;
  interestRateBps?: number | null;
  principalCents?: number | null;
  termMonths?: number | null;
}

/** Partial update for an account (id required). Only provided fields change. */
export interface UpdateAccountInput {
  id: string;
  name?: string;
  type?: AccountType;
  currency?: string;
  accountCode?: string | null;
  openingBalanceCents?: number;
  openingBalanceDate?: string | null;
  interestRateBps?: number | null;
}

/** Input shape for creating a transaction. */
export interface NewTransactionInput {
  date: string;
  payee?: string | null;
  memo?: string | null;
  amountCents: number;
  fromAccountId?: string | null;
  toAccountId?: string | null;
  categoryId?: string | null;
  cleared?: ClearedState;
  importId?: string | null;
  /**
   * Optional split legs. When provided with 2+ legs, the transaction is stored as
   * a split: inline categoryId/from-to counterparty are cleared and these legs are
   * written. Legs must sum to the transaction's signed effect on the owning account.
   */
  splits?: NewSplitInput[] | null;
}

/** Partial update for a transaction (id required). */
export interface UpdateTransactionInput {
  id: string;
  date?: string;
  payee?: string | null;
  memo?: string | null;
  amountCents?: number;
  fromAccountId?: string | null;
  toAccountId?: string | null;
  categoryId?: string | null;
  cleared?: ClearedState;
  /** Replace the transaction's split legs. Empty array or null clears splits. */
  splits?: NewSplitInput[] | null;
}

/** Input shape for creating a category. */
export interface NewCategoryInput {
  name: string;
  parentId?: string | null;
  applicability?: CategoryApplicability;
}

/** Partial update for a category (id required). */
export interface UpdateCategoryInput {
  id: string;
  name?: string;
  parentId?: string | null;
  applicability?: CategoryApplicability;
}

/** Current balance of an account, in cents. */
export interface AccountBalance {
  accountId: string;
  balanceCents: number;
}

/** A ledger row for a specific account: the transaction plus a computed running balance. */
export interface LedgerRow {
  /**
   * Row kind. "opening" is a synthetic row derived from the account's opening
   * balance/date (editable in the ledger, sortable by date); "transaction" is a
   * real transaction row.
   */
  kind: "opening" | "transaction";
  /** The transaction for "transaction" rows; null for the synthetic opening row. */
  transaction: Transaction | null;
  /** Signed effect on THIS account, in cents (inflow positive, outflow negative). */
  signedAmountCents: number;
  /** Running balance of THIS account after this transaction, in cents. */
  runningBalanceCents: number;
  /** True when this transaction has stored split legs (derived from split rows). */
  isSplit?: boolean;
  /** The transaction's split legs (empty for unsplit rows). */
  splits?: TransactionSplit[];
}

// ---- Import / Export (M5 / M6) ----

export type ImportFormat = "csv" | "ofx" | "qif";
export type ExportFormat = "csv" | "qif" | "pdf" | "png";

/**
 * A normalized row parsed from a bank file, before it is turned into a
 * Transaction. `amountCents` is SIGNED (negative = outflow from the account,
 * positive = inflow), which is how bank files express amounts.
 */
export interface ParsedRow {
  date: string; // ISO 8601 (YYYY-MM-DD)
  payee: string | null;
  memo: string | null;
  amountCents: number; // signed
  importId: string | null; // bank FITID or synthesized dedupe key
  /**
   * Parsed transfer counterparty reference from a "Transfer Account ID" field,
   * e.g. {dir:"to", code:"1234"}. Direction is relative to the imported account.
   * Null when the row is not a transfer or no such field was present.
   */
  transferAccountRef?: { dir: "to" | "from"; code: string } | null;
  /**
   * Resolved counterparty account PK (set by the UI after matching the code to an
   * existing account, or via the manual resolve dialog). Null/undefined = external.
   */
  resolvedTransferAccountId?: string | null;
}

/** Column-index mapping for CSV import (0-based column indices, or null if unused). */
export interface CsvColumnMapping {
  date: number;
  payee: number | null;
  memo: number | null;
  amount: number | null; // single signed amount column
  debit: number | null; // OR separate debit column (positive = outflow)
  credit: number | null; // OR separate credit column (positive = inflow)
  transferAccountId: number | null; // "Transfer Account ID" column (TO:/FROM:<code>)
  hasHeaderRow: boolean;
  dateFormat: "iso" | "us" | "eu"; // YYYY-MM-DD | MM/DD/YYYY | DD/MM/YYYY
  /**
   * When true, negate parsed amounts. Bank/statement CSVs (esp. credit cards)
   * often use positive = outgoing / negative = incoming, the opposite of the
   * internal convention (negative = outflow, positive = inflow).
   */
  invertAmounts?: boolean;
}

/** A previewed import row plus whether it is a duplicate of an existing transaction. */
export interface ImportPreviewRow {
  row: ParsedRow;
  duplicate: boolean;
}

export interface ImportPreview {
  format: ImportFormat;
  rows: ImportPreviewRow[];
  totalParsed: number;
  duplicateCount: number;
}

// ---- Charts / Aggregation (M3) ----

/** Scope for chart aggregation: a specific account, or all accounts combined. */
export type ChartScope = { kind: "account"; accountId: string } | { kind: "all" };

/** Inclusive ISO date range (either bound may be null = unbounded). */
export interface DateRange {
  start: string | null; // YYYY-MM-DD
  end: string | null; // YYYY-MM-DD
}

/** One slice of the spending-by-category pie. */
export interface CategorySpend {
  categoryId: string | null; // null = uncategorized
  categoryName: string;
  amountCents: number; // positive magnitude of spending
}

/** One bar of the spending-by-month chart. */
export interface MonthSpend {
  month: string; // YYYY-MM
  spendingCents: number; // positive magnitude of outflow
  incomeCents: number; // positive magnitude of inflow
}

/**
 * Raw data needed by the charts panel. The renderer runs the (pure) aggregation
 * so date-range/scope changes are instant without extra IPC round-trips.
 */
export interface AggregateData {
  accounts: Account[];
  categories: Category[];
  transactions: Transaction[];
  splits: TransactionSplit[];
}

// ---- Recurring rules & projection (M4) ----

export type Frequency = "weekly" | "biweekly" | "monthly" | "yearly";
export type EstimateMode = "fixed" | "average" | "last";

export interface RecurringRule {
  id: string;
  name: string;
  amountCents: number | null; // required for 'fixed'; ignored for average/last
  estimateMode: EstimateMode;
  fromAccountId: string | null;
  toAccountId: string | null;
  categoryId: string | null;
  frequency: Frequency;
  intervalCount: number; // every N periods (>=1)
  startDate: string; // ISO date
  endDate: string | null; // ISO date or null = indefinite
  dayOfMonth: number | null; // for monthly/yearly anchoring (1-31)
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

export interface NewRecurringRuleInput {
  name: string;
  amountCents?: number | null;
  estimateMode?: EstimateMode;
  fromAccountId?: string | null;
  toAccountId?: string | null;
  categoryId?: string | null;
  frequency: Frequency;
  intervalCount?: number;
  startDate: string;
  endDate?: string | null;
  dayOfMonth?: number | null;
}

export interface UpdateRecurringRuleInput extends Partial<NewRecurringRuleInput> {
  id: string;
}

/** A single projected (not-yet-real) occurrence produced by a recurring rule. */
export interface ProjectedOccurrence {
  ruleId: string;
  ruleName: string;
  date: string; // ISO date
  /** Signed effect on the projected account, in cents (inflow +, outflow -). */
  signedAmountCents: number;
  fromAccountId: string | null;
  toAccountId: string | null;
  categoryId: string | null;
  /** For loan rules: principal/interest split of a payment (magnitudes). */
  principalCents?: number;
  interestCents?: number;
}

/** A projected ledger row for an account: occurrence + running projected balance. */
export interface ProjectionRow {
  occurrence: ProjectedOccurrence;
  runningBalanceCents: number;
}

/** A point on the balance-forecast chart. */
export interface ForecastPoint {
  date: string; // YYYY-MM-DD
  balanceCents: number;
}
