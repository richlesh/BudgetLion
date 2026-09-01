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
}

/** Result of the main-process file open used by the Import dialog. */
export interface OpenedFile {
  fileName: string;
  text: string;
}

/** Accounts + categories (+ recurring rules) bundle exchanged as JSON. */
export interface DataBundle {
  accounts: Account[];
  categories: Category[];
  /** Recurring rules (optional for backward compatibility with older files). */
  recurringRules?: RecurringRule[];
}

/** Projected ledger + monthly balance forecast for one account (M4). */
export interface AccountProjection {
  rows: ProjectionRow[];
  forecast: ForecastPoint[];
}

export interface LedgerApi {
  // Accounts
  listAccounts(): Promise<Account[]>;
  createAccount(input: NewAccountInput): Promise<Account>;
  updateAccount(input: UpdateAccountInput): Promise<void>;
  getAllBalances(): Promise<AccountBalance[]>;

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

  // Import (M5)
  openImportFile(): Promise<OpenedFile | null>;
  commitImport(accountId: string, rows: ParsedRow[]): Promise<number>;

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
  onMenuDedupe(cb: () => void): void;
  onMenuImport(cb: () => void): void;
  onMenuExport(cb: () => void): void;
  onMenuPrint(cb: () => void): void;
  onMenuImportData(cb: () => void): void;
  onMenuExportData(cb: () => void): void;
  onMenuToggleCharts(cb: () => void): void;
  onMenuRecurring(cb: () => void): void;
}

// IPC channel names, centralized to avoid typos across main/preload.
export const IPC = {
  listAccounts: "accounts:list",
  createAccount: "accounts:create",
  updateAccount: "accounts:update",
  getAllBalances: "accounts:balances",
  listCategories: "categories:list",
  createCategory: "categories:create",
  updateCategory: "categories:update",
  deleteCategory: "categories:delete",
  getCategoryUsage: "categories:usage",
  getLedger: "ledger:get",
  createTransaction: "tx:create",
  updateTransaction: "tx:update",
  deleteTransaction: "tx:delete",
  openImportFile: "import:open",
  commitImport: "import:commit",
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
} as const;
