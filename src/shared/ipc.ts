// Contract for the IPC bridge exposed on window.ledger by the preload script.
// Shared so both preload (implementation) and renderer (consumer) stay in sync.

import type {
  Account,
  AccountBalance,
  AggregateData,
  Category,
  ForecastPoint,
  LedgerRow,
  NewAccountInput,
  NewCategoryInput,
  NewRecurringRuleInput,
  NewTransactionInput,
  ProjectionRow,
  RecurringRule,
  UpdateCategoryInput,
  UpdateRecurringRuleInput,
  UpdateTransactionInput,
  UpdateAccountInput,
  ParsedRow,
  Asset,
  NewAssetInput,
  UpdateAssetInput,
  AssetValuation,
  NewValuationInput,
  AssetHolding,
  AccountWorth,
  InvestmentTransaction,
  NewTradeInput,
  SecurityHolding,
  InvestmentImportRow,
  LoanPaymentSplitResult,
} from "./types";

export interface AppSettings {
  theme: "light" | "dark";
  defaultCurrency: string;
  licenseKey?: string;
  userName?: string;
  windowBounds?: { width: number; height: number; x?: number; y?: number };
  ledgerColumnWidths?: Record<string, number>;
  // Forecast (projection) ledger column widths (colKey -> px).
  forecastColumnWidths?: Record<string, number>;
  // Width (px) of the accounts sidebar (draggable divider).
  sidebarWidth?: number;
  // Fonts (empty string = system default)
  ledgerFont?: string;
  ledgerFontSize?: number;
  printFont?: string;
  printFontSize?: number;
  // Phase 2: automated price fetching (opt-in, off by default).
  priceFetchEnabled?: boolean;
  priceSource?: "yahoo";
}

/** Result of attempting to fetch a price for one security symbol. */
export interface PriceFetchResult {
  assetId: string;
  symbol: string;
  resolved: boolean;
  priceCents?: number;
  asOfDate?: string;
  error?: string;
}

/** Result of the main-process file open used by the Import dialog. */
export interface OpenedFile {
  fileName: string;
  text: string;
}

/** Result of backfilling monthly historical prices for a tickered asset. */
export interface BackfillHistoryResult {
  resolved: boolean;
  /** Number of month rows added (existing/manual dates are preserved). */
  added: number;
  error?: string;
}

/** One symbol-search match from a name→ticker lookup. */
export interface SymbolMatch {
  symbol: string;
  name: string;
  exchange: string;
  /** Yahoo quoteType, e.g. EQUITY, ETF, MUTUALFUND, INDEX. */
  type: string;
}

/** Result of a name→symbol lookup. */
export interface SymbolLookupResult {
  resolved: boolean;
  results: SymbolMatch[];
  error?: string;
}

/** One parsed deduction line from a paycheck stub (positive magnitude in cents). */
export interface ParsedPaycheckDeduction {
  label: string;
  amountCents: number;
}

/** Result of importing + parsing a paycheck-stub PDF (Phase 2). */
export interface ParsedPaycheckResult {
  fileName: string;
  /** Employer / company name, or null if not confidently found. */
  employer: string | null;
  /** Pay date as ISO (YYYY-MM-DD), or null if not found. */
  date: string | null;
  grossCents: number | null;
  netCents: number | null;
  deductions: ParsedPaycheckDeduction[];
  /** Recognized labels with no parseable amount (shown as a hint). */
  unresolvedLabels: string[];
  /**
   * The raw extracted PDF text, so the renderer can match against employers the
   * user has used before (which the main process doesn't have on hand).
   */
  rawText: string;
}

/** Accounts + categories (+ recurring rules) bundle exchanged as JSON. */
export interface DataBundle {
  accounts: Account[];
  categories: Category[];
  /** Recurring rules (optional for backward compatibility with older files). */
  recurringRules?: RecurringRule[];
}

/** Result of a database lifecycle operation (New/Open/Save As/Backup/Restore). */
export interface DbOpResult {
  ok: boolean;
  /** Display name (folder basename) of the now-current database. */
  name?: string;
  /** True when the user cancelled a dialog (not an error). */
  canceled?: boolean;
  error?: string;
}

/** Projected ledger + monthly balance forecast for one account (M4). */
export interface AccountProjection {
  rows: ProjectionRow[];
  forecast: ForecastPoint[];
}

/** Undo/redo availability + labels for the next actions. */
export interface UndoState {
  canUndo: boolean;
  canRedo: boolean;
  undoLabel: string | null;
  redoLabel: string | null;
}

export interface LedgerApi {
  // Accounts
  listAccounts(): Promise<Account[]>;
  createAccount(input: NewAccountInput): Promise<Account>;
  updateAccount(input: UpdateAccountInput): Promise<void>;
  getAllBalances(): Promise<AccountBalance[]>;
  /** Net worth per account (cash + asset holdings). */
  getAllWorth(): Promise<AccountWorth[]>;

  // Assets & valuations (Phase 1)
  /** Assets, optionally filtered to a single account. */
  listAssets(accountId?: string): Promise<Asset[]>;
  createAsset(input: NewAssetInput): Promise<Asset>;
  updateAsset(input: UpdateAssetInput): Promise<void>;
  /** Soft-delete an asset and its valuations. */
  deleteAsset(id: string): Promise<void>;
  /** Non-deleted valuations for an asset (most recent first). */
  listValuations(assetId: string): Promise<AssetValuation[]>;
  /** Record/replace a valuation for an asset on a date. */
  recordValuation(input: NewValuationInput): Promise<AssetValuation>;
  /** Soft-delete a single valuation. */
  deleteValuation(id: string): Promise<void>;
  /** Assets of an account plus their computed current holding values. */
  getHoldings(accountId: string): Promise<AssetHolding[]>;

  // Investment transactions (Option A)
  /** Record a buy/sell/dividend/reinvest atomically (creates linked cash txn). */
  recordTrade(input: NewTradeInput): Promise<InvestmentTransaction>;
  /** Soft-delete an investment transaction and its linked cash transaction. */
  deleteInvestmentTxn(id: string): Promise<void>;
  /** Investment transactions for an account. */
  listInvestmentTxns(accountId: string): Promise<InvestmentTransaction[]>;
  /** Per-security holdings for an account: shares and market value. */
  getSecurityHoldings(accountId: string): Promise<SecurityHolding[]>;
  /** Import normalized investment-history rows as trades. Returns trade count. */
  commitInvestmentImport(accountId: string, rows: InvestmentImportRow[]): Promise<number>;

  // Phase 2: automated price fetching (opt-in)
  /** Fetch prices for an account's security symbols (or all when omitted). */
  refreshPrices(accountId?: string): Promise<PriceFetchResult[]>;
  /** Backfill monthly historical prices for a tickered asset from first-owned to now. */
  backfillPriceHistory(assetId: string): Promise<BackfillHistoryResult>;
  /** Look up ticker symbols by security/fund name (opt-in; sends the query to Yahoo). */
  lookupSecuritySymbol(query: string): Promise<SymbolLookupResult>;

  // Categories
  listCategories(): Promise<Category[]>;
  createCategory(input: NewCategoryInput): Promise<Category>;
  updateCategory(input: UpdateCategoryInput): Promise<void>;
  /** Soft-delete a category; rejects if the category is in use. */
  deleteCategory(id: string): Promise<void>;
  /** Usage count per category id (only non-zero entries). Used to gate deletion. */
  getCategoryUsage(): Promise<Record<string, number>>;

  // Transactions / ledger
  getLedger(accountId: string): Promise<LedgerRow[]>;
  createTransaction(input: NewTransactionInput): Promise<void>;
  updateTransaction(input: UpdateTransactionInput): Promise<void>;
  deleteTransaction(id: string): Promise<void>;
  /** Auto-compute a principal/interest split for a loan-payment transfer. */
  buildLoanPaymentSplit(txId: string): Promise<LoanPaymentSplitResult>;
  /** Delete many transactions as a single undo step. */
  bulkDeleteTransactions(ids: string[]): Promise<void>;
  /** Apply many transaction updates as a single undo step (e.g. Bulk Category). */
  bulkUpdateTransactions(updates: UpdateTransactionInput[]): Promise<void>;

  // Undo / redo (transaction-level, in-memory, session-scoped)
  undo(): Promise<boolean>;
  redo(): Promise<boolean>;
  getUndoState(): Promise<UndoState>;

  // Import (M5)
  openImportFile(): Promise<OpenedFile | null>;
  commitImport(accountId: string, rows: ParsedRow[]): Promise<number>;

  // Paycheck PDF import (Phase 2): open a stub PDF, extract text, parse it.
  importPaycheckPdf(): Promise<ParsedPaycheckResult | null>;

  // Charts (M3)
  getAggregateData(): Promise<AggregateData>;

  // Recurring rules + projection (M4)
  listRecurringRules(): Promise<RecurringRule[]>;
  createRecurringRule(input: NewRecurringRuleInput): Promise<RecurringRule>;
  updateRecurringRule(input: UpdateRecurringRuleInput): Promise<void>;
  deleteRecurringRule(id: string): Promise<void>;
  getProjection(accountId: string, horizonMonths: number): Promise<AccountProjection>;

  // Accounts/Categories JSON data exchange
  openJsonFile(): Promise<OpenedFile | null>;
  getData(): Promise<DataBundle>;
  importData(
    data: DataBundle
  ): Promise<{ accounts: number; categories: number; recurringRules: number }>;

  // AI: decide whether two transactions are duplicates by comparing payee + memo.
  // Falls back to an exact/null comparison (both fields) when AI is unavailable.
  arePairSimilar(
    aPayee: string | null,
    aMemo: string | null,
    bPayee: string | null,
    bMemo: string | null,
    useAI?: boolean
  ): Promise<boolean>;
  // AI: is a provider configured AND currently responding? (live probe)
  isAiAvailable(): Promise<boolean>;

  // Database management (File menu). Each returns the now-current DB name.
  dbNew(): Promise<DbOpResult>;
  dbOpen(): Promise<DbOpResult>;
  /** Open the database at the OS default location (userData). */
  dbOpenDefault(): Promise<DbOpResult>;
  dbSaveAs(): Promise<DbOpResult>;
  dbBackup(): Promise<DbOpResult>;
  dbRestore(): Promise<DbOpResult>;
  /** Current database display name (folder basename). */
  dbCurrentName(): Promise<string>;

  // Export (M6)
  saveTextFile(defaultName: string, content: string, ext: string): Promise<boolean>;
  saveDataUrl(defaultName: string, dataUrl: string, ext: string): Promise<boolean>;
  exportPdf(defaultName: string, html: string): Promise<boolean>;
  printLedger(html: string): Promise<void>;

  // Settings
  getSettings(): Promise<AppSettings>;
  // Persist a partial settings patch (no UI side effects). Returns the merged settings.
  saveSettings(patch: Partial<AppSettings>): Promise<AppSettings>;
  onSettingsChanged(cb: (settings: AppSettings) => void): void;

  // Menu events
  onMenuNewTransaction(cb: () => void): void;
  onMenuNewPaycheck(cb: () => void): void;
  onMenuNewAccount(cb: () => void): void;
  onMenuNewCategory(cb: () => void): void;
  onMenuDedupe(cb: () => void): void;
  onMenuImport(cb: () => void): void;
  onMenuExport(cb: () => void): void;
  onMenuPrint(cb: () => void): void;
  onMenuImportData(cb: () => void): void;
  onMenuExportData(cb: () => void): void;
  onMenuToggleCharts(cb: () => void): void;
  onMenuToggleForecast(cb: () => void): void;
  onMenuRecurring(cb: () => void): void;
  onMenuSearch(cb: () => void): void;
  onMenuUndo(cb: () => void): void;
  onMenuRedo(cb: () => void): void;
  // Database management menu events.
  onMenuDbNew(cb: () => void): void;
  onMenuDbOpen(cb: () => void): void;
  onMenuDbOpenDefault(cb: () => void): void;
  onMenuDbSaveAs(cb: () => void): void;
  onMenuDbBackup(cb: () => void): void;
  onMenuDbRestore(cb: () => void): void;
}

// IPC channel names, centralized to avoid typos across main/preload.
export const IPC = {
  listAccounts: "accounts:list",
  createAccount: "accounts:create",
  updateAccount: "accounts:update",
  getAllBalances: "accounts:balances",
  getAllWorth: "accounts:worth",
  listAssets: "assets:list",
  createAsset: "assets:create",
  updateAsset: "assets:update",
  deleteAsset: "assets:delete",
  listValuations: "assets:valuations:list",
  recordValuation: "assets:valuations:record",
  deleteValuation: "assets:valuations:delete",
  getHoldings: "assets:holdings",
  recordTrade: "invtx:record",
  deleteInvestmentTxn: "invtx:delete",
  listInvestmentTxns: "invtx:list",
  getSecurityHoldings: "invtx:holdings",
  commitInvestmentImport: "invtx:import",
  refreshPrices: "prices:refresh",
  backfillPriceHistory: "prices:backfill-history",
  lookupSecuritySymbol: "prices:lookup-symbol",
  listCategories: "categories:list",
  createCategory: "categories:create",
  updateCategory: "categories:update",
  deleteCategory: "categories:delete",
  getCategoryUsage: "categories:usage",
  getLedger: "ledger:get",
  createTransaction: "tx:create",
  updateTransaction: "tx:update",
  deleteTransaction: "tx:delete",
  buildLoanPaymentSplit: "tx:loan-split",
  bulkDeleteTransactions: "tx:bulk-delete",
  bulkUpdateTransactions: "tx:bulk-update",
  undo: "undo:do",
  redo: "undo:redo",
  getUndoState: "undo:state",
  openImportFile: "import:open",
  commitImport: "import:commit",
  importPaycheckPdf: "paycheck:import-pdf",
  getAggregateData: "charts:aggregate",
  listRecurringRules: "recurring:list",
  createRecurringRule: "recurring:create",
  updateRecurringRule: "recurring:update",
  deleteRecurringRule: "recurring:delete",
  getProjection: "recurring:projection",
  saveTextFile: "export:text",
  saveDataUrl: "export:dataurl",
  exportPdf: "export:pdf",
  printLedger: "export:print",
  getSettings: "settings-get",
  saveSettings: "settings-patch",
  openJsonFile: "data:open-json",
  getData: "data:get",
  importData: "data:import",
  arePairSimilar: "ai:pair-similar",
  isAiAvailable: "ai:available",
  dbNew: "db:new",
  dbOpen: "db:open",
  dbOpenDefault: "db:open-default",
  dbSaveAs: "db:save-as",
  dbBackup: "db:backup",
  dbRestore: "db:restore",
  dbCurrentName: "db:current-name",
} as const;
