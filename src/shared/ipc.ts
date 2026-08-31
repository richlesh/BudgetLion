// Contract for the IPC bridge exposed on window.ledger by the preload script.
// Shared so both preload (implementation) and renderer (consumer) stay in sync.

import type {
  Account,
  AccountBalance,
  Category,
  LedgerRow,
  NewAccountInput,
  NewCategoryInput,
  NewTransactionInput,
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

/** Accounts + categories bundle exchanged as JSON. */
export interface DataBundle {
  accounts: Account[];
  categories: Category[];
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

  // Transactions / ledger
  getLedger(accountId: string): Promise<LedgerRow[]>;
  createTransaction(input: NewTransactionInput): Promise<void>;
  updateTransaction(input: UpdateTransactionInput): Promise<void>;
  deleteTransaction(id: string): Promise<void>;

  // Import (M5)
  openImportFile(): Promise<OpenedFile | null>;
  commitImport(accountId: string, rows: ParsedRow[]): Promise<number>;

  // Accounts/Categories JSON data exchange
  openJsonFile(): Promise<OpenedFile | null>;
  getData(): Promise<DataBundle>;
  importData(data: DataBundle): Promise<{ accounts: number; categories: number }>;

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
  onMenuImport(cb: () => void): void;
  onMenuExport(cb: () => void): void;
  onMenuPrint(cb: () => void): void;
  onMenuImportData(cb: () => void): void;
  onMenuExportData(cb: () => void): void;
}

// IPC channel names, centralized to avoid typos across main/preload.
export const IPC = {
  listAccounts: "accounts:list",
  createAccount: "accounts:create",
  updateAccount: "accounts:update",
  getAllBalances: "accounts:balances",
  listCategories: "categories:list",
  createCategory: "categories:create",
  getLedger: "ledger:get",
  createTransaction: "tx:create",
  updateTransaction: "tx:update",
  deleteTransaction: "tx:delete",
  openImportFile: "import:open",
  commitImport: "import:commit",
  saveTextFile: "export:text",
  saveDataUrl: "export:dataurl",
  exportPdf: "export:pdf",
  printLedger: "export:print",
  getSettings: "settings-get",
  saveSettings: "settings-patch",
  openJsonFile: "data:open-json",
  getData: "data:get",
  importData: "data:import",
} as const;
