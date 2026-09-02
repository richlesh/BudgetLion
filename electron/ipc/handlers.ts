// Registers IPC handlers that bridge renderer requests to the DB + domain layer.

import { BrowserWindow, dialog, ipcMain } from "electron";
import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { IPC } from "../../src/shared/ipc.js";
import type { AccountProjection, DataBundle } from "../../src/shared/ipc.js";
import type {
  AccountBalance,
  AggregateData,
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
  AccountWorth,
  AssetHolding,
  NewTradeInput,
  SecurityHolding,
  InvestmentImportRow,
} from "../../src/shared/types.js";
import { buildLedger, currentBalance } from "../../src/core/balances.js";
import {
  accountWorth,
  holdingsForAssets,
  securityHolding,
} from "../../src/core/worth.js";
import { refreshPrices } from "../prices/index.js";
import { extractPdfText } from "../paycheck/pdfText.js";
import { parsePaycheckText } from "../../src/core/paycheckParse.js";
import * as undoJournal from "../db/undo.js";
import { validateTransaction } from "../../src/core/validation.js";
import { rowToTransaction } from "../../src/core/import/index.js";
import { balanceForecast, projectLedger, addMonthsISO } from "../../src/core/recurring.js";
import * as repo from "../db/repository.js";
import { arePairSimilar, isAiAvailable } from "../ai/similarity.js";
import {
  currentDbName,
  dbBackup,
  dbNew,
  dbOpen,
  dbOpenDefault,
  dbRestore,
  dbSaveAs,
} from "../db/manage.js";

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

  // Net worth per account: cash balance (opening + transactions) plus, for
  // investment/asset accounts, the sum of asset holding values (latest valuation).
  ipcMain.handle(IPC.getAllWorth, (): AccountWorth[] => {
    const accounts = repo.listAccounts();
    const txns = repo.allTransactions();
    const splitsByTx = repo.splitsForTransactions(txns.map((t) => t.id));
    const assets = repo.listAssets();
    const valuationsByAsset = repo.allValuationsByAsset();
    const lotsByAsset = repo.allInvestmentTxnsByAsset();
    // Group holdings by account id (share counts derived from lots for securities).
    const holdingsByAccount = new Map<string, AssetHolding[]>();
    for (const h of holdingsForAssets(assets, valuationsByAsset, lotsByAsset)) {
      const list = holdingsByAccount.get(h.asset.accountId) ?? [];
      list.push(h);
      holdingsByAccount.set(h.asset.accountId, list);
    }
    return accounts.map((a) =>
      accountWorth(a, txns, splitsByTx, holdingsByAccount.get(a.id) ?? [])
    );
  });

  // ---- Assets & valuations (Phase 1) ----

  ipcMain.handle(IPC.listAssets, (_e, accountId?: string) => repo.listAssets(accountId));
  ipcMain.handle(IPC.createAsset, (_e, input: NewAssetInput) => repo.createAsset(input));
  ipcMain.handle(IPC.updateAsset, (_e, input: UpdateAssetInput) => repo.updateAsset(input));
  ipcMain.handle(IPC.deleteAsset, (_e, id: string) => repo.deleteAsset(id));
  ipcMain.handle(IPC.listValuations, (_e, assetId: string) => repo.valuationsForAsset(assetId));
  ipcMain.handle(IPC.recordValuation, (_e, input: NewValuationInput) =>
    repo.recordValuation(input)
  );
  ipcMain.handle(IPC.deleteValuation, (_e, id: string) => repo.deleteValuation(id));
  ipcMain.handle(IPC.getHoldings, (_e, accountId: string): AssetHolding[] => {
    const assets = repo.listAssets(accountId);
    const valuationsByAsset = repo.allValuationsByAsset();
    const lotsByAsset = repo.allInvestmentTxnsByAsset();
    return holdingsForAssets(assets, valuationsByAsset, lotsByAsset);
  });

  // ---- Investment transactions (Option A) ----

  ipcMain.handle(IPC.recordTrade, (_e, input: NewTradeInput) => repo.recordTrade(input));
  ipcMain.handle(IPC.deleteInvestmentTxn, (_e, id: string) => repo.deleteInvestmentTxn(id));
  ipcMain.handle(IPC.commitInvestmentImport, (_e, accountId: string, rows: InvestmentImportRow[]) =>
    repo.commitInvestmentImport(accountId, rows)
  );
  ipcMain.handle(IPC.listInvestmentTxns, (_e, accountId: string) =>
    repo.investmentTxnsForAccount(accountId)
  );
  // Security holdings for an account: shares, cost basis, market value per security.
  ipcMain.handle(IPC.getSecurityHoldings, (_e, accountId: string): SecurityHolding[] => {
    const assets = repo.listAssets(accountId).filter((a) => a.assetClass === "security");
    const valuationsByAsset = repo.allValuationsByAsset();
    const lotsByAsset = repo.allInvestmentTxnsByAsset();
    return assets.map((a) =>
      securityHolding(a, lotsByAsset.get(a.id) ?? [], valuationsByAsset.get(a.id) ?? [])
    );
  });

  // ---- Phase 2: automated price fetching (opt-in) ----

  ipcMain.handle(IPC.refreshPrices, async (_e, accountId?: string) => {
    // Gather (assetId, symbol) pairs for security assets to price.
    const assets = repo
      .listAssets(accountId)
      .filter((a) => a.assetClass === "security" && a.symbol);
    return refreshPrices(assets.map((a) => ({ assetId: a.id, symbol: a.symbol as string })));
  });

  ipcMain.handle(IPC.listCategories, () => repo.listCategories());
  ipcMain.handle(IPC.createCategory, (_e, input: NewCategoryInput) =>
    repo.createCategory(input)
  );
  ipcMain.handle(IPC.updateCategory, (_e, input: UpdateCategoryInput) =>
    repo.updateCategory(input)
  );
  ipcMain.handle(IPC.deleteCategory, (_e, id: string) => repo.deleteCategory(id));
  ipcMain.handle(IPC.getCategoryUsage, () => repo.categoryUsageCounts());

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
    const tradeByTxn = repo.tradeInfoByTxnId(txns.map((t) => t.id));
    return buildLedger(account, txns, splitsByTx, tradeByTxn);
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

  ipcMain.handle(IPC.buildLoanPaymentSplit, (_e, txId: string) =>
    repo.buildLoanPaymentSplit(txId)
  );

  // Bulk transaction ops (single undo step each).
  ipcMain.handle(IPC.bulkDeleteTransactions, (_e, ids: string[]) =>
    repo.bulkDeleteTransactions(ids)
  );
  ipcMain.handle(IPC.bulkUpdateTransactions, (_e, updates: UpdateTransactionInput[]) =>
    repo.bulkUpdateTransactions(updates)
  );

  // Undo / redo.
  ipcMain.handle(IPC.undo, () => undoJournal.undo());
  ipcMain.handle(IPC.redo, () => undoJournal.redo());
  ipcMain.handle(IPC.getUndoState, () => undoJournal.undoState());

  // ---- Charts (M3) ----

  ipcMain.handle(IPC.getAggregateData, (): AggregateData => {
    return {
      accounts: repo.listAccounts(),
      categories: repo.listCategories(),
      transactions: repo.allTransactions(),
      splits: repo.allSplits(),
    };
  });

  // ---- Recurring rules + projection (M4) ----

  ipcMain.handle(IPC.listRecurringRules, () => repo.listRecurringRules());
  ipcMain.handle(IPC.createRecurringRule, (_e, input: NewRecurringRuleInput) =>
    repo.createRecurringRule(input)
  );
  ipcMain.handle(IPC.updateRecurringRule, (_e, input: UpdateRecurringRuleInput) =>
    repo.updateRecurringRule(input)
  );
  ipcMain.handle(IPC.deleteRecurringRule, (_e, id: string) => repo.deleteRecurringRule(id));

  ipcMain.handle(
    IPC.getProjection,
    (_e, accountId: string, horizonMonths: number): AccountProjection => {
      const account = repo.listAccounts().find((a) => a.id === accountId);
      if (!account) throw new Error(`Account not found: ${accountId}`);
      const actuals = repo.transactionsForAccount(accountId);
      const rules = repo.listRecurringRules();
      const today = new Date().toISOString().slice(0, 10);
      const horizonEnd = addMonthsISO(today, horizonMonths);
      return {
        rows: projectLedger(account, actuals, rules, today, horizonEnd),
        forecast: balanceForecast(account, actuals, rules, today, horizonMonths),
      };
    }
  );

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

  // ---- Paycheck PDF import (Phase 2) ----
  ipcMain.handle(IPC.importPaycheckPdf, async () => {
    const win = BrowserWindow.getFocusedWindow() ?? undefined;
    const { canceled, filePaths } = await dialog.showOpenDialog(win!, {
      title: "Import Paycheck Stub (PDF)",
      properties: ["openFile"],
      filters: [
        { name: "PDF", extensions: ["pdf"] },
        { name: "All Files", extensions: ["*"] },
      ],
    });
    if (canceled || filePaths.length === 0) return null;
    const filePath = filePaths[0];
    const bytes = new Uint8Array(readFileSync(filePath));
    const text = await extractPdfText(bytes);
    const parsed = parsePaycheckText(text);
    return {
      fileName: basename(filePath),
      grossCents: parsed.grossCents,
      netCents: parsed.netCents,
      deductions: parsed.deductions,
      unresolvedLabels: parsed.unresolvedLabels,
    };
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

  // ---- AI: payee similarity for de-duplication ----
  ipcMain.handle(
    IPC.arePairSimilar,
    (
      _e,
      aPayee: string | null,
      aMemo: string | null,
      bPayee: string | null,
      bMemo: string | null,
      useAI?: boolean
    ) => arePairSimilar(aPayee, aMemo, bPayee, bMemo, useAI ?? true)
  );
  ipcMain.handle(IPC.isAiAvailable, () => isAiAvailable());

  // ---- Database management (File menu) ----
  ipcMain.handle(IPC.dbNew, () => dbNew());
  ipcMain.handle(IPC.dbOpen, () => dbOpen());
  ipcMain.handle(IPC.dbOpenDefault, () => dbOpenDefault());
  ipcMain.handle(IPC.dbSaveAs, () => dbSaveAs());
  ipcMain.handle(IPC.dbBackup, () => dbBackup());
  ipcMain.handle(IPC.dbRestore, () => dbRestore());
  ipcMain.handle(IPC.dbCurrentName, () => currentDbName());
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
