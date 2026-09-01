// Preload: exposes a typed, minimal API on window.ledger via contextBridge.

import { contextBridge, ipcRenderer } from "electron";
import { IPC } from "../../src/shared/ipc.js";
import type { AppSettings, LedgerApi, OpenedFile } from "../../src/shared/ipc.js";
import type { DataBundle } from "../../src/shared/ipc.js";
import type {
  NewAccountInput,
  NewCategoryInput,
  NewRecurringRuleInput,
  NewTransactionInput,
  ParsedRow,
  UpdateCategoryInput,
  UpdateRecurringRuleInput,
  UpdateTransactionInput,
  UpdateAccountInput,
  NewAssetInput,
  UpdateAssetInput,
  NewValuationInput,
  NewTradeInput,
} from "../../src/shared/types.js";

const api: LedgerApi = {
  listAccounts: () => ipcRenderer.invoke(IPC.listAccounts),
  createAccount: (input: NewAccountInput) => ipcRenderer.invoke(IPC.createAccount, input),
  updateAccount: (input: UpdateAccountInput) => ipcRenderer.invoke(IPC.updateAccount, input),
  getAllBalances: () => ipcRenderer.invoke(IPC.getAllBalances),
  getAllWorth: () => ipcRenderer.invoke(IPC.getAllWorth),

  // Assets & valuations (Phase 1)
  listAssets: (accountId?: string) => ipcRenderer.invoke(IPC.listAssets, accountId),
  createAsset: (input: NewAssetInput) => ipcRenderer.invoke(IPC.createAsset, input),
  updateAsset: (input: UpdateAssetInput) => ipcRenderer.invoke(IPC.updateAsset, input),
  deleteAsset: (id: string) => ipcRenderer.invoke(IPC.deleteAsset, id),
  listValuations: (assetId: string) => ipcRenderer.invoke(IPC.listValuations, assetId),
  recordValuation: (input: NewValuationInput) =>
    ipcRenderer.invoke(IPC.recordValuation, input),
  deleteValuation: (id: string) => ipcRenderer.invoke(IPC.deleteValuation, id),
  getHoldings: (accountId: string) => ipcRenderer.invoke(IPC.getHoldings, accountId),

  // Investment transactions (Option A)
  recordTrade: (input: NewTradeInput) => ipcRenderer.invoke(IPC.recordTrade, input),
  deleteInvestmentTxn: (id: string) => ipcRenderer.invoke(IPC.deleteInvestmentTxn, id),
  listInvestmentTxns: (accountId: string) =>
    ipcRenderer.invoke(IPC.listInvestmentTxns, accountId),
  getSecurityHoldings: (accountId: string) =>
    ipcRenderer.invoke(IPC.getSecurityHoldings, accountId),

  // Phase 2: automated price fetching
  refreshPrices: (accountId?: string) => ipcRenderer.invoke(IPC.refreshPrices, accountId),
  listCategories: () => ipcRenderer.invoke(IPC.listCategories),
  createCategory: (input: NewCategoryInput) => ipcRenderer.invoke(IPC.createCategory, input),
  updateCategory: (input: UpdateCategoryInput) => ipcRenderer.invoke(IPC.updateCategory, input),
  deleteCategory: (id: string) => ipcRenderer.invoke(IPC.deleteCategory, id),
  getCategoryUsage: () => ipcRenderer.invoke(IPC.getCategoryUsage),
  getLedger: (accountId: string) => ipcRenderer.invoke(IPC.getLedger, accountId),
  createTransaction: (input: NewTransactionInput) =>
    ipcRenderer.invoke(IPC.createTransaction, input),
  updateTransaction: (input: UpdateTransactionInput) =>
    ipcRenderer.invoke(IPC.updateTransaction, input),
  deleteTransaction: (id: string) => ipcRenderer.invoke(IPC.deleteTransaction, id),

  // Import (M5)
  openImportFile: (): Promise<OpenedFile | null> => ipcRenderer.invoke(IPC.openImportFile),
  commitImport: (accountId: string, rows: ParsedRow[]) =>
    ipcRenderer.invoke(IPC.commitImport, accountId, rows),

  // Charts (M3)
  getAggregateData: () => ipcRenderer.invoke(IPC.getAggregateData),

  // Recurring rules + projection (M4)
  listRecurringRules: () => ipcRenderer.invoke(IPC.listRecurringRules),
  createRecurringRule: (input: NewRecurringRuleInput) =>
    ipcRenderer.invoke(IPC.createRecurringRule, input),
  updateRecurringRule: (input: UpdateRecurringRuleInput) =>
    ipcRenderer.invoke(IPC.updateRecurringRule, input),
  deleteRecurringRule: (id: string) => ipcRenderer.invoke(IPC.deleteRecurringRule, id),
  getProjection: (accountId: string, horizonMonths: number) =>
    ipcRenderer.invoke(IPC.getProjection, accountId, horizonMonths),

  // Accounts/Categories JSON data exchange
  openJsonFile: (): Promise<OpenedFile | null> => ipcRenderer.invoke(IPC.openJsonFile),
  getData: (): Promise<DataBundle> => ipcRenderer.invoke(IPC.getData),
  importData: (data: DataBundle) => ipcRenderer.invoke(IPC.importData, data),

  // AI: pair (payee + memo) similarity for de-duplication.
  arePairSimilar: (
    aPayee: string | null,
    aMemo: string | null,
    bPayee: string | null,
    bMemo: string | null,
    useAI?: boolean
  ) => ipcRenderer.invoke(IPC.arePairSimilar, aPayee, aMemo, bPayee, bMemo, useAI),
  isAiAvailable: () => ipcRenderer.invoke(IPC.isAiAvailable),

  // Database management (File menu).
  dbNew: () => ipcRenderer.invoke(IPC.dbNew),
  dbOpen: () => ipcRenderer.invoke(IPC.dbOpen),
  dbOpenDefault: () => ipcRenderer.invoke(IPC.dbOpenDefault),
  dbSaveAs: () => ipcRenderer.invoke(IPC.dbSaveAs),
  dbBackup: () => ipcRenderer.invoke(IPC.dbBackup),
  dbRestore: () => ipcRenderer.invoke(IPC.dbRestore),
  dbCurrentName: () => ipcRenderer.invoke(IPC.dbCurrentName),

  // Export (M6)
  saveTextFile: (defaultName: string, content: string, ext: string) =>
    ipcRenderer.invoke(IPC.saveTextFile, defaultName, content, ext),
  saveDataUrl: (defaultName: string, dataUrl: string, ext: string) =>
    ipcRenderer.invoke(IPC.saveDataUrl, defaultName, dataUrl, ext),
  exportPdf: (defaultName: string, html: string) =>
    ipcRenderer.invoke(IPC.exportPdf, defaultName, html),
  printLedger: (html: string) => ipcRenderer.invoke(IPC.printLedger, html),

  getSettings: () => ipcRenderer.invoke(IPC.getSettings),
  saveSettings: (patch: Partial<AppSettings>) => ipcRenderer.invoke(IPC.saveSettings, patch),
  onSettingsChanged: (cb: (settings: AppSettings) => void) => {
    ipcRenderer.on("settings-changed", (_e, settings: AppSettings) => cb(settings));
  },
  onMenuNewTransaction: (cb: () => void) => {
    ipcRenderer.on("menu-new-transaction", () => cb());
  },
  onMenuNewAccount: (cb: () => void) => {
    ipcRenderer.on("menu-new-account", () => cb());
  },
  onMenuNewCategory: (cb: () => void) => {
    ipcRenderer.on("menu-new-category", () => cb());
  },
  onMenuDedupe: (cb: () => void) => {
    ipcRenderer.on("menu-dedupe", () => cb());
  },
  onMenuImport: (cb: () => void) => {
    ipcRenderer.on("menu-import", () => cb());
  },
  onMenuExport: (cb: () => void) => {
    ipcRenderer.on("menu-export", () => cb());
  },
  onMenuPrint: (cb: () => void) => {
    ipcRenderer.on("menu-print", () => cb());
  },
  onMenuImportData: (cb: () => void) => {
    ipcRenderer.on("menu-import-data", () => cb());
  },
  onMenuExportData: (cb: () => void) => {
    ipcRenderer.on("menu-export-data", () => cb());
  },
  onMenuToggleCharts: (cb: () => void) => {
    ipcRenderer.on("menu-toggle-charts", () => cb());
  },
  onMenuToggleForecast: (cb: () => void) => {
    ipcRenderer.on("menu-toggle-forecast", () => cb());
  },
  onMenuRecurring: (cb: () => void) => {
    ipcRenderer.on("menu-recurring", () => cb());
  },
  onMenuSearch: (cb: () => void) => {
    ipcRenderer.on("menu-search", () => cb());
  },
  onMenuDbNew: (cb: () => void) => {
    ipcRenderer.on("menu-db-new", () => cb());
  },
  onMenuDbOpen: (cb: () => void) => {
    ipcRenderer.on("menu-db-open", () => cb());
  },
  onMenuDbOpenDefault: (cb: () => void) => {
    ipcRenderer.on("menu-db-open-default", () => cb());
  },
  onMenuDbSaveAs: (cb: () => void) => {
    ipcRenderer.on("menu-db-save-as", () => cb());
  },
  onMenuDbBackup: (cb: () => void) => {
    ipcRenderer.on("menu-db-backup", () => cb());
  },
  onMenuDbRestore: (cb: () => void) => {
    ipcRenderer.on("menu-db-restore", () => cb());
  },
};

contextBridge.exposeInMainWorld("ledger", api);
