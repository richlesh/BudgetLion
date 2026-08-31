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

export interface Category {
  id: string; // UUID
  name: string;
  parentId: string | null;
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
}

/** Input shape for creating a category. */
export interface NewCategoryInput {
  name: string;
  parentId?: string | null;
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
