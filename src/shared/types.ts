// Shared domain types used by both the Electron main process and the React renderer.
// Framework-agnostic: no imports from Electron, React, or the DB driver.
// Money is always represented as integer cents (minor currency units) to avoid float errors.

export type AccountType =
  | "checking"
  | "savings"
  | "credit_card"
  | "loan"
  | "investment"
  | "asset";

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

// ---- Assets & valuations (Phase 1) ----

/** Broad classification of an owned asset. */
export type AssetClass =
  | "security" // stocks, mutual funds, ETFs (market-priceable)
  | "real_estate"
  | "vehicle"
  | "collectible"
  | "cash"
  | "other";

/** Micro-unit scale factor (x1e6) used for asset quantities and per-unit values. */
export const MICRO = 1_000_000;

/**
 * A thing you own whose value changes over time independently of transactions.
 * Belongs to an 'investment' or 'asset' account. `quantityMicro` is in micro-units
 * (x1e6): a single indivisible asset is 1_000_000 (= 1.0); a security holds a share
 * count. Its worth in cents is derived from the latest valuation (see AssetHolding).
 */
export interface Asset {
  id: string; // UUID
  accountId: string;
  name: string;
  assetClass: AssetClass;
  symbol: string | null; // ticker for market-priced assets (nullable)
  quantityMicro: number; // shares/units x1e6
  metadata: string | null; // JSON blob (address, VIN, purchase info, notes, ...)
  currency: string;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

/**
 * A point-in-time per-unit valuation of an asset. `valueMicros` is the per-unit
 * value in MICRO-CENTS (cents-per-unit x 1e6 == dollars-per-unit x 100 x 1e6);
 * use the worth-module converters at the UI boundary. The most recent (max
 * asOfDate) valuation is "current".
 */
export interface AssetValuation {
  id: string; // UUID
  assetId: string;
  asOfDate: string; // ISO 8601 date
  valueMicros: number; // per-unit value in micro-cents (see above)
  source: string | null; // 'manual' | 'appraisal' | 'stooq' | ...
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

/** Input shape for creating an asset (server fills id/timestamps). */
export interface NewAssetInput {
  accountId: string;
  name: string;
  assetClass?: AssetClass;
  symbol?: string | null;
  quantityMicro?: number; // defaults to 1_000_000 (1.0)
  metadata?: string | null;
  currency?: string;
}

/** Partial update for an asset (id required). Only provided fields change. */
export interface UpdateAssetInput {
  id: string;
  name?: string;
  assetClass?: AssetClass;
  symbol?: string | null;
  quantityMicro?: number;
  metadata?: string | null;
  currency?: string;
}

/** Input for recording/replacing a valuation for an asset on a given date. */
export interface NewValuationInput {
  assetId: string;
  asOfDate: string; // ISO date
  valueMicros: number; // per-unit value in micro-cents (dollars x 100 x 1e6)
  source?: string | null;
}

/**
 * An asset plus its computed current holding value. `valueCents` =
 * round(quantityMicro * latestValueMicros / 1e12); null latest valuation => 0.
 */
export interface AssetHolding {
  asset: Asset;
  latestValuation: AssetValuation | null;
  valueCents: number;
}

/** Kind of investment transaction (Option A lots). */
export type InvestmentAction = "buy" | "sell" | "div" | "reinvest" | "grant";

/**
 * An investment transaction (lot). Changes an asset's share count and/or moves
 * cash. `quantityMicro` is signed shares x1e6 (buy/reinvest +, sell -, div 0);
 * `priceMicros` is per-share micro-cents; `feesCents` and `cashCents` are cents
 * (cashCents is the signed effect on the account, computed at creation).
 */
export interface InvestmentTransaction {
  id: string;
  assetId: string;
  accountId: string;
  date: string; // ISO date
  action: InvestmentAction;
  quantityMicro: number; // signed shares x1e6
  priceMicros: number; // per-share micro-cents
  feesCents: number;
  cashCents: number; // signed cash effect on the account
  cashTxnId: string | null; // linked cash (trade) leg transaction id
  incomeTxnId: string | null; // linked categorized income leg (grant/reinvest)
  memo: string | null;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

/**
 * Input for recording a trade. Quantities/prices are given in human units and
 * converted to micro-units by the repository. For 'div' (cash dividend), pass
 * `cashCents` (the dividend amount) and 0 shares/price. For buy/sell/reinvest,
 * pass `units` (shares) and `pricePerUnitCents` (per-share, in cents). For 'grant'
 * (salary/RSU stock grant), pass `units` + `pricePerUnitCents`: the grant value
 * (units*price) is recorded as categorized income and the shares are acquired at
 * that cost basis, so net cash change is just -fees.
 */
export interface NewTradeInput {
  accountId: string;
  /** Existing asset to trade. Provide this OR `newAsset` to create one inline. */
  assetId?: string;
  /** Inline security creation (used when assetId is not given). */
  newAsset?: { name: string; symbol: string; assetClass?: AssetClass };
  date: string;
  action: InvestmentAction;
  /** Share count in human units (e.g. 12.5). Ignored/zero for cash 'div'. */
  units?: number;
  /** Per-share price in cents (e.g. 8840 = $88.40). Ignored/zero for cash 'div'. */
  pricePerUnitCents?: number;
  /** Commission/fees in cents (>= 0). */
  feesCents?: number;
  /** For 'div': the cash dividend amount in cents (before fees). */
  cashCents?: number;
  /**
   * Income category for the income leg of grant/div/reinvest (Salary, Dividend,
   * etc.). Null/omitted leaves the income transaction uncategorized. Ignored for
   * buy/sell (they carry no income).
   */
  categoryId?: string | null;
  memo?: string | null;
}

/**
 * Computed holding for a security, derived from its investment-transaction lots:
 * total shares, average cost basis, and market value at the latest valuation.
 */
export interface SecurityHolding {
  asset: Asset;
  sharesMicro: number; // net shares x1e6 from all lots
  costBasisCents: number; // total cost of shares still held (avg-cost method)
  latestValuation: AssetValuation | null;
  marketValueCents: number; // sharesMicro * latest price
}

/**
 * Net worth of a single account. For cash-style accounts (checking/savings/
 * credit_card/loan) worth == balanceCents. For investment/asset accounts,
 * worth == cash balance (opening + transactions) + sum of holding values.
 */
export interface AccountWorth {
  accountId: string;
  cashCents: number; // balance from opening + transactions
  holdingsCents: number; // sum of asset holding values (0 for cash accounts)
  worthCents: number; // cashCents + holdingsCents
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
  /**
   * Investment-trade details when this transaction is the cash/income leg of an
   * investment lot (buy/sell/dividend/reinvest/grant). Present only for such rows
   * so the ledger can show the security ticker/name, shares, and price per share.
   */
  trade?: LedgerTradeInfo;
}

/** Compact investment-trade description attached to a ledger row for display. */
export interface LedgerTradeInfo {
  action: InvestmentAction;
  symbol: string | null;
  assetName: string;
  /** Shares in human units (e.g. 12.5); 0 for a cash dividend. */
  units: number;
  /** Price per share in cents (e.g. 8840 = $88.40); 0 for a cash dividend. */
  pricePerUnitCents: number;
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
