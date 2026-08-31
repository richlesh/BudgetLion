// Registers IPC handlers that bridge renderer requests to the DB + domain layer.

import { BrowserWindow, dialog, ipcMain } from "electron";
import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { IPC } from "../../src/shared/ipc.js";
import type { DataBundle } from "../../src/shared/ipc.js";
import type {
  AccountBalance,
  NewAccountInput,
  NewCategoryInput,
  NewTransactionInput,
  ParsedRow,
  UpdateTransactionInput,
  UpdateAccountInput,
} from "../../src/shared/types.js";
import { buildLedger, currentBalance } from "../../src/core/balances.js";
import { validateTransaction } from "../../src/core/validation.js";
import { rowToTransaction } from "../../src/core/import/index.js";
import * as repo from "../db/repository.js";

export function registerIpcHandlers(): void {
  ipcMain.handle(IPC.listAccounts, () => repo.listAccounts());

  ipcMain.handle(IPC.createAccount, (_e, input: NewAccountInput) =>
    repo.createAccount(input)
  );

  ipcMain.handle(IPC.updateAccount, (_e, input: UpdateAccountInput) =>
    repo.updateAccount(input)
  );

  ipcMain.handle(IPC.getAllBalances, (): AccountBalance[] => {
    const accounts = repo.listAccounts();
    const txns = repo.allTransactions();
    const splitsByTx = repo.splitsForTransactions(txns.map((t) => t.id));
    return accounts.map((a) => ({
      accountId: a.id,
      balanceCents: currentBalance(a, txns, splitsByTx),
    }));
  });

  ipcMain.handle(IPC.listCategories, () => repo.listCategories());
  ipcMain.handle(IPC.createCategory, (_e, input: NewCategoryInput) =>
    repo.createCategory(input)
  );

  ipcMain.handle(IPC.getLedger, (_e, accountId: string) => {
    const accounts = repo.listAccounts();
    const account = accounts.find((a) => a.id === accountId);
    if (!account) throw new Error(`Account not found: ${accountId}`);
    // Transactions where this account is the owning side, PLUS transactions whose
    // transfer-leg splits reference this account (e.g. the loan side of a split
    // loan payment owned by checking).
    const owned = repo.transactionsForAccount(accountId);
    const counterpartyIds = repo.transactionIdsWithTransferSplitTo(accountId);
    const ownedIds = new Set(owned.map((t) => t.id));
    const extra = repo.transactionsByIds(counterpartyIds.filter((id) => !ownedIds.has(id)));
    const txns = [...owned, ...extra];
    const splitsByTx = repo.splitsForTransactions(txns.map((t) => t.id));
    return buildLedger(account, txns, splitsByTx);
  });

  ipcMain.handle(IPC.createTransaction, (_e, input: NewTransactionInput) => {
    const result = validateTransaction(input);
    if (!result.ok) throw new Error(result.errors.join(" "));
    repo.createTransaction(input);
  });

  ipcMain.handle(IPC.updateTransaction, (_e, input: UpdateTransactionInput) => {
    repo.updateTransaction(input);
  });

  ipcMain.handle(IPC.deleteTransaction, (_e, id: string) => {
    repo.deleteTransaction(id);
  });

  // ---- Import (M5) ----

  ipcMain.handle(IPC.openImportFile, async () => {
    const win = BrowserWindow.getFocusedWindow() ?? undefined;
    const { canceled, filePaths } = await dialog.showOpenDialog(win!, {
      title: "Import Transactions",
      properties: ["openFile"],
      filters: [
        { name: "Bank Files", extensions: ["csv", "ofx", "qfx", "qif"] },
        { name: "CSV", extensions: ["csv"] },
        { name: "OFX", extensions: ["ofx", "qfx"] },
        { name: "QIF", extensions: ["qif"] },
        { name: "All Files", extensions: ["*"] },
      ],
    });
    if (canceled || filePaths.length === 0) return null;
    const filePath = filePaths[0];
    const text = readFileSync(filePath, "utf8");
    return { fileName: basename(filePath), text };
  });

  ipcMain.handle(IPC.commitImport, (_e, accountId: string, rows: ParsedRow[]) => {
    // Dedupe against what's already in the account, then bulk insert.
    const existing = repo.importIdsForAccount(accountId);
    const inputs: NewTransactionInput[] = [];
    for (const row of rows) {
      const tx = rowToTransaction(row, accountId);
      if (tx.importId && existing.has(tx.importId)) continue;
      inputs.push(tx);
    }
    return repo.createTransactionsBulk(inputs);
  });

  // ---- Export (M6) ----

  const documents = () => join(homedir(), "Documents");

  ipcMain.handle(
    IPC.saveTextFile,
    async (_e, defaultName: string, content: string, ext: string) => {
      const win = BrowserWindow.getFocusedWindow() ?? undefined;
      const { canceled, filePath } = await dialog.showSaveDialog(win!, {
        title: "Export",
        defaultPath: join(documents(), `${defaultName}.${ext}`),
        filters: [{ name: ext.toUpperCase(), extensions: [ext] }],
      });
      if (canceled || !filePath) return false;
      writeFileSync(filePath, content, "utf8");
      return true;
    }
  );

  ipcMain.handle(
    IPC.saveDataUrl,
    async (_e, defaultName: string, dataUrl: string, ext: string) => {
      const win = BrowserWindow.getFocusedWindow() ?? undefined;
      const { canceled, filePath } = await dialog.showSaveDialog(win!, {
        title: "Export Chart",
        defaultPath: join(documents(), `${defaultName}.${ext}`),
        filters: [{ name: ext.toUpperCase(), extensions: [ext] }],
      });
      if (canceled || !filePath) return false;
      const base64 = dataUrl.replace(/^data:.*;base64,/, "");
      writeFileSync(filePath, Buffer.from(base64, "base64"));
      return true;
    }
  );

  ipcMain.handle(IPC.exportPdf, async (_e, defaultName: string, html: string) => {
    const win = BrowserWindow.getFocusedWindow() ?? undefined;
    const { canceled, filePath } = await dialog.showSaveDialog(win!, {
      title: "Export as PDF",
      defaultPath: join(documents(), `${defaultName}.pdf`),
      filters: [{ name: "PDF", extensions: ["pdf"] }],
    });
    if (canceled || !filePath) return false;
    const pdf = await renderHtmlToPdf(html);
    writeFileSync(filePath, pdf);
    return true;
  });

  ipcMain.handle(IPC.printLedger, async (_e, html: string) => {
    await printHtml(html);
  });

  // ---- Accounts/Categories JSON data exchange ----

  ipcMain.handle(IPC.openJsonFile, async () => {
    const win = BrowserWindow.getFocusedWindow() ?? undefined;
    const { canceled, filePaths } = await dialog.showOpenDialog(win!, {
      title: "Import Accounts / Categories",
      properties: ["openFile"],
      filters: [
        { name: "JSON", extensions: ["json"] },
        { name: "All Files", extensions: ["*"] },
      ],
    });
    if (canceled || filePaths.length === 0) return null;
    const filePath = filePaths[0];
    return { fileName: basename(filePath), text: readFileSync(filePath, "utf8") };
  });

  ipcMain.handle(IPC.getData, () => repo.exportData());

  ipcMain.handle(IPC.importData, (_e, data: DataBundle) => repo.importData(data));
}

/** Render standalone HTML to a PDF buffer using an offscreen window. */
async function renderHtmlToPdf(html: string): Promise<Buffer> {
  const win = new BrowserWindow({ show: false, webPreferences: { offscreen: true } });
  try {
    await win.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(html));
    const data = await win.webContents.printToPDF({
      printBackground: true,
      margins: { marginType: "default" },
      pageSize: "Letter",
    });
    return data;
  } finally {
    win.destroy();
  }
}

/** Load HTML into a hidden window and invoke the system print dialog. */
async function printHtml(html: string): Promise<void> {
  const win = new BrowserWindow({ show: false });
  await win.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(html));
  win.webContents.print({ silent: false, printBackground: true }, () => {
    win.destroy();
  });
}
