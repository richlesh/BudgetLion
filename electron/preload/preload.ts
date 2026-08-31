// Preload: exposes a typed, minimal API on window.ledger via contextBridge.

import { contextBridge, ipcRenderer } from "electron";
import { IPC } from "../../src/shared/ipc.js";
import type { AppSettings, LedgerApi, OpenedFile } from "../../src/shared/ipc.js";
import type { DataBundle } from "../../src/shared/ipc.js";
import type {
  NewAccountInput,
  NewCategoryInput,
  NewTransactionInput,
  ParsedRow,
  UpdateTransactionInput,
  UpdateAccountInput,
} from "../../src/shared/types.js";

const api: LedgerApi = {
  listAccounts: () => ipcRenderer.invoke(IPC.listAccounts),
  createAccount: (input: NewAccountInput) => ipcRenderer.invoke(IPC.createAccount, input),
  updateAccount: (input: UpdateAccountInput) => ipcRenderer.invoke(IPC.updateAccount, input),
  getAllBalances: () => ipcRenderer.invoke(IPC.getAllBalances),
  listCategories: () => ipcRenderer.invoke(IPC.listCategories),
  createCategory: (input: NewCategoryInput) => ipcRenderer.invoke(IPC.createCategory, input),
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

  // Accounts/Categories JSON data exchange
  openJsonFile: (): Promise<OpenedFile | null> => ipcRenderer.invoke(IPC.openJsonFile),
  getData: (): Promise<DataBundle> => ipcRenderer.invoke(IPC.getData),
  importData: (data: DataBundle) => ipcRenderer.invoke(IPC.importData, data),

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
};

contextBridge.exposeInMainWorld("ledger", api);
