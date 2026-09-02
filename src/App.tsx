import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import "ag-grid-community/styles/ag-grid.css";
import "ag-grid-community/styles/ag-theme-alpine.css";
import type {
  Account,
  AccountBalance,
  Category,
  LedgerRow,
  NewAccountInput,
  NewCategoryInput,
  NewRecurringRuleInput,
  RecurringRule,
  NewTransactionInput,
  UpdateAccountInput,
  NewSplitInput,
  Transaction,
  TransactionSplit,
  NewTradeInput,
} from "./shared/types";
import { displaySign, formatCents } from "./core/money";
import { ledgerToHtml } from "./core/export/html";
import { LedgerGrid } from "./components/LedgerGrid";
import type { CategoryChoice } from "./components/CategoryAccountEditor";
import { NewAccountDialog } from "./components/NewAccountDialog";
import { SplitEditorDialog } from "./components/SplitEditorDialog";
import { NewTransactionDialog } from "./components/NewTransactionDialog";
import { NewInvestmentDialog } from "./components/NewInvestmentDialog";
import { HoldingsPanel } from "./components/HoldingsPanel";
import { CategoriesDialog } from "./components/CategoriesDialog";
import { ConfirmDialog } from "./components/ConfirmDialog";
import { DedupeDialog } from "./components/DedupeDialog";
import { resolveDuplicatePairs, type DuplicatePair } from "./core/dedupe";
import { SearchDialog } from "./components/SearchDialog";
import { SearchResults } from "./components/SearchResults";
import type { SearchCriteria } from "./core/search";
import type { AggregateData } from "./shared/types";
import { ImportDialog } from "./components/ImportDialog";
import { InvestmentImportDialog } from "./components/InvestmentImportDialog";
import { ExportDialog } from "./components/ExportDialog";
import { ChartsPanel } from "./components/ChartsPanel";
import { ProjectionPanel } from "./components/ProjectionPanel";
import { RecurringRulesDialog } from "./components/RecurringRulesDialog";
import { ContextMenu } from "./components/ContextMenu";
import type { ContextMenuItem } from "./components/ContextMenu";
import { categoryOptions } from "./core/categories";
import { ViewAccountDialog } from "./components/ViewAccountDialog";
import { EditAccountDialog } from "./components/EditAccountDialog";

export function App() {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [balances, setBalances] = useState<AccountBalance[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [ledger, setLedger] = useState<LedgerRow[]>([]);
  const [showAccountDialog, setShowAccountDialog] = useState(false);
  const [showTxDialog, setShowTxDialog] = useState(false);
  const [holdingsReloadKey, setHoldingsReloadKey] = useState(0);
  // For investment accounts, which entry form to show: a chooser first, then
  // either the trade dialog or the regular cash/transfer transaction dialog.
  const [invTxMode, setInvTxMode] = useState<"choose" | "trade" | "cash">("choose");
  const [showCategoriesDialog, setShowCategoriesDialog] = useState(false);
  // Usage counts per category id (only non-zero). Categories with no usage can be
  // deleted from the Categories editor. Loaded when the editor opens.
  const [categoryUsage, setCategoryUsage] = useState<Record<string, number>>({});
  const [showImportDialog, setShowImportDialog] = useState(false);
  const [showInvestmentImport, setShowInvestmentImport] = useState(false);
  const [showExportDialog, setShowExportDialog] = useState(false);
  const [showCharts, setShowCharts] = useState(false);
  const [showProjection, setShowProjection] = useState(false);
  // Transaction search: dialog visibility, and the results snapshot (whole-DB
  // aggregate data) + criteria driving the results modal.
  const [showSearchDialog, setShowSearchDialog] = useState(false);
  const [searchData, setSearchData] = useState<AggregateData | null>(null);
  const [searchCriteria, setSearchCriteria] = useState<SearchCriteria | null>(null);
  const [showRecurring, setShowRecurring] = useState(false);
  const [recurringSeed, setRecurringSeed] = useState<Partial<NewRecurringRuleInput> | null>(null);
  // Right-click context menu over a ledger cell.
  const [ledgerMenu, setLedgerMenu] = useState<{
    x: number;
    y: number;
    items: ContextMenuItem[];
  } | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [dark, setDark] = useState(false);
  // Persisted ledger column widths (colId -> px), loaded from settings.
  const [columnWidths, setColumnWidths] = useState<Record<string, number>>({});
  // Persisted forecast (projection) ledger column widths (colKey -> px).
  const [forecastColumnWidths, setForecastColumnWidths] = useState<Record<string, number>>({});
  // Width (px) of the accounts sidebar, adjustable via the draggable divider.
  const [sidebarWidth, setSidebarWidth] = useState<number>(260);
  // Print/PDF font options, kept in a ref for the once-registered print handler.
  const printFontRef = useRef<{ font?: string; size?: number }>({});
  // Transaction id staged for deletion, pending user confirmation.
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);
  // Transaction ids staged for bulk deletion (from a multi-row selection),
  // pending user confirmation. Null = no bulk-delete prompt showing.
  const [pendingBulkDelete, setPendingBulkDelete] = useState<string[] | null>(null);
  // De-duplication review: confirmed duplicate pairs + the current index, plus a
  // "scanning…" flag while the (possibly AI-backed) similarity check runs.
  const [dedupePairs, setDedupePairs] = useState<DuplicatePair[]>([]);
  const [dedupeIndex, setDedupeIndex] = useState(0);
  const [dedupeScanning, setDedupeScanning] = useState(false);
  // When AI is available and responding, we first ask the user whether to use it
  // for this de-dupe pass. Null = no prompt showing.
  const [dedupeAskAI, setDedupeAskAI] = useState(false);
  // Right-click account context menu + view/edit account dialogs.
  const [accountMenu, setAccountMenu] = useState<{ x: number; y: number; account: Account } | null>(
    null
  );
  const [viewAccount, setViewAccount] = useState<Account | null>(null);
  const [editAccount, setEditAccount] = useState<Account | null>(null);
  // Split editor: transaction id + its signed total on the selected account + seed legs.
  const [splitEditor, setSplitEditor] = useState<{
    txId: string;
    account: Account; // the account the split is owned by (may differ from `selected`)
    signedTotalCents: number;
    initialSplits: NewSplitInput[];
    readOnly: boolean;
    fromAccountName?: string;
    /** Called after a successful save (refresh ledger/search as appropriate). */
    onSaved?: () => void | Promise<void>;
  } | null>(null);
  // A pending category/transfer change on a SPLIT row, awaiting confirmation
  // (applying it discards the split legs).
  const [pendingSplitChange, setPendingSplitChange] = useState<{
    id: string;
    choice: CategoryChoice;
  } | null>(null);

  const selected = useMemo(
    () => accounts.find((a) => a.id === selectedId) ?? null,
    [accounts, selectedId]
  );

  const balanceMap = useMemo(() => {
    const m = new Map<string, number>();
    balances.forEach((b) => m.set(b.accountId, b.balanceCents));
    return m;
  }, [balances]);

  // Distinct prior payees and memos from the current account's ledger, most
  // recent first, for the New Transaction autocomplete. Sourced from the loaded
  // ledger rows (transactions in the selected account).
  const payeeSuggestions = useMemo(() => {
    const seen = new Set<string>();
    const out: string[] = [];
    for (let i = ledger.length - 1; i >= 0; i--) {
      const p = ledger[i].transaction?.payee?.trim();
      if (p && !seen.has(p.toLowerCase())) {
        seen.add(p.toLowerCase());
        out.push(p);
      }
    }
    return out;
  }, [ledger]);

  const memoSuggestions = useMemo(() => {
    const seen = new Set<string>();
    const out: string[] = [];
    for (let i = ledger.length - 1; i >= 0; i--) {
      const m = ledger[i].transaction?.memo?.trim();
      if (m && !seen.has(m.toLowerCase())) {
        seen.add(m.toLowerCase());
        out.push(m);
      }
    }
    return out;
  }, [ledger]);

  const refreshAccounts = useCallback(async () => {
    const [list, bals] = await Promise.all([
      window.ledger.listAccounts(),
      window.ledger.getAllBalances(),
    ]);
    setAccounts(list);
    setBalances(bals);
    setSelectedId((cur) => cur ?? list[0]?.id ?? null);
  }, []);

  const refreshCategories = useCallback(async () => {
    setCategories(await window.ledger.listCategories());
  }, []);

  const refreshLedger = useCallback(async (accountId: string) => {
    setLedger(await window.ledger.getLedger(accountId));
  }, []);

  // Scan the selected account for duplicate transactions and open the review
  // dialog on the first confirmed pair. `useAI` chooses AI-backed payee matching
  // vs. the deterministic exact/null fallback.
  const startDedupeScan = useCallback(async (useAI: boolean) => {
    const acct = selectedRef.current;
    if (!acct) return;
    setDedupeScanning(true);
    try {
      const rows = await window.ledger.getLedger(acct.id);
      const txns = rows
        .filter((r) => r.kind === "transaction" && r.transaction)
        .map((r) => r.transaction!);
      const pairs = await resolveDuplicatePairs(txns, (a, b) =>
        window.ledger.arePairSimilar(
          a.payee ?? null,
          a.memo ?? null,
          b.payee ?? null,
          b.memo ?? null,
          useAI
        )
      );
      if (pairs.length === 0) {
        setToast("No duplicate transactions found.");
        return;
      }
      setDedupePairs(pairs);
      setDedupeIndex(0);
    } finally {
      setDedupeScanning(false);
    }
  }, []);

  // Entry point from the File menu: if AI is configured AND currently responding,
  // ask the user whether to use it; otherwise scan straight away with the
  // deterministic fallback (no prompt).
  const runDedupe = useCallback(async () => {
    const acct = selectedRef.current;
    if (!acct) return;
    setDedupeScanning(true);
    let available = false;
    try {
      available = await window.ledger.isAiAvailable();
    } finally {
      setDedupeScanning(false);
    }
    if (available) {
      setDedupeAskAI(true); // show the "Use AI?" prompt; scan starts on choice
    } else {
      void startDedupeScan(false);
    }
  }, [startDedupeScan]);

  // Delete the chosen duplicate, refresh, and advance to the next pair.
  const handleDedupeDelete = useCallback(
    async (id: string) => {
      await window.ledger.deleteTransaction(id);
      await refreshAccounts();
      if (selectedRef.current) await refreshLedger(selectedRef.current.id);
      setDedupeIndex((i) => i + 1);
    },
    [refreshAccounts, refreshLedger]
  );

  const handleDedupeSkip = useCallback(() => setDedupeIndex((i) => i + 1), []);

  const closeDedupe = useCallback(() => {
    setDedupePairs([]);
    setDedupeIndex(0);
  }, []);

  // When every duplicate pair has been reviewed, end the pass with a summary.
  useEffect(() => {
    if (dedupePairs.length > 0 && dedupeIndex >= dedupePairs.length) {
      setToast("Finished reviewing duplicates.");
      setDedupePairs([]);
      setDedupeIndex(0);
    }
  }, [dedupeIndex, dedupePairs.length]);

  // Refs hold the latest values so the once-registered menu listeners can read them.
  const selectedRef = useRef<Account | null>(null);
  const ledgerRef = useRef<LedgerRow[]>([]);
  const categoriesRef = useRef<Category[]>([]);
  useEffect(() => {
    selectedRef.current = selected;
  }, [selected]);
  useEffect(() => {
    ledgerRef.current = ledger;
  }, [ledger]);
  useEffect(() => {
    categoriesRef.current = categories;
  }, [categories]);

  const doPrint = useCallback(() => {
    const acct = selectedRef.current;
    if (!acct) return;
    const html = ledgerToHtml(acct, ledgerRef.current, categoriesRef.current, {
      font: printFontRef.current.font,
      sizePx: printFontRef.current.size,
    });
    void window.ledger.printLedger(html);
  }, []);

  // Export all accounts + categories to a JSON file.
  const doExportData = useCallback(async () => {
    try {
      const bundle = await window.ledger.getData();
      const json = JSON.stringify(bundle, null, 2);
      const ok = await window.ledger.saveTextFile("budgetlion-accounts-categories", json, "json");
      if (ok) {
        setToast(
          `Exported ${bundle.accounts.length} account(s), ${bundle.categories.length} category(ies), and ${bundle.recurringRules?.length ?? 0} recurring rule(s).`
        );
      }
    } catch (e) {
      setToast(`Export failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }, []);

  // Import accounts + categories from a JSON file (upsert by id).
  const doImportData = useCallback(async () => {
    try {
      const opened = await window.ledger.openJsonFile();
      if (!opened) return;
      const parsed = JSON.parse(opened.text) as {
        accounts?: Account[];
        categories?: Category[];
        recurringRules?: RecurringRule[];
      };
      const bundle = {
        accounts: parsed.accounts ?? [],
        categories: parsed.categories ?? [],
        recurringRules: parsed.recurringRules ?? [],
      };
      const counts = await window.ledger.importData(bundle);
      await refreshAccounts();
      await refreshCategories();
      if (selectedRef.current) await refreshLedger(selectedRef.current.id);
      setToast(
        `Imported ${counts.accounts} account(s), ${counts.categories} category(ies), and ${counts.recurringRules} recurring rule(s).`
      );
    } catch (e) {
      setToast(`Import failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }, [refreshAccounts, refreshCategories, refreshLedger]);

  // Run a database lifecycle operation (New/Open/Save As/Restore) and, on
  // success, reload everything so the UI reflects the now-current database.
  const handleDbSwitch = useCallback(
    async (op: () => Promise<import("./shared/ipc").DbOpResult>, verb: string) => {
      const res = await op();
      if (res.canceled) return;
      if (!res.ok) {
        setToast(res.error ? `${verb} failed: ${res.error}` : `${verb} failed.`);
        return;
      }
      // The working database changed: reset selection and reload from scratch.
      setSelectedId(null);
      setLedger([]);
      await refreshAccounts();
      await refreshCategories();
      setToast(`${verb}: ${res.name ?? "database"}.`);
    },
    [refreshAccounts, refreshCategories]
  );

  // Backup keeps the same database open; just report success/failure.
  const handleDbBackup = useCallback(async () => {
    const res = await window.ledger.dbBackup();
    if (res.canceled) return;
    setToast(res.ok ? "Backup created." : `Backup failed: ${res.error ?? "unknown error"}`);
  }, []);

  // Apply the chosen ledger font/size to the grid via CSS variables, and remember
  // the print font/size for PDF/print export.
  function applyFontSettings(s: {
    ledgerFont?: string;
    ledgerFontSize?: number;
    printFont?: string;
    printFontSize?: number;
  }) {
    const root = document.documentElement;
    root.style.setProperty("--ledger-font", s.ledgerFont ? `"${s.ledgerFont}"` : "");
    root.style.setProperty("--ledger-font-size", s.ledgerFontSize ? `${s.ledgerFontSize}px` : "");
    printFontRef.current = { font: s.printFont, size: s.printFontSize };
  }

  // Initial load + theme + menu wiring. Menu listeners are registered ONCE.
  useEffect(() => {
    void refreshAccounts();
    void refreshCategories();
    void window.ledger.getSettings().then((s) => {
      const isDark = s.theme === "dark";
      document.body.classList.toggle("dark", isDark);
      setDark(isDark);
      if (s.ledgerColumnWidths) setColumnWidths(s.ledgerColumnWidths);
      if (s.forecastColumnWidths) setForecastColumnWidths(s.forecastColumnWidths);
      if (typeof s.sidebarWidth === "number" && s.sidebarWidth > 0) {
        setSidebarWidth(s.sidebarWidth);
      }
      applyFontSettings(s);
    });
    window.ledger.onSettingsChanged((s) => {
      const isDark = s.theme === "dark";
      document.body.classList.toggle("dark", isDark);
      setDark(isDark);
      applyFontSettings(s);
    });
    window.ledger.onMenuNewTransaction(() => {
      if (selectedRef.current) {
        setInvTxMode("choose");
        setShowTxDialog(true);
      }
    });
    window.ledger.onMenuNewAccount(() => setShowAccountDialog(true));
    window.ledger.onMenuNewCategory(() => setShowCategoriesDialog(true));
    window.ledger.onMenuDedupe(() => {
      if (selectedRef.current) void runDedupe();
    });
    window.ledger.onMenuImport(() => {
      const acct = selectedRef.current;
      if (!acct) return;
      if (acct.type === "investment") setShowInvestmentImport(true);
      else setShowImportDialog(true);
    });
    window.ledger.onMenuExport(() => {
      if (selectedRef.current) setShowExportDialog(true);
    });
    window.ledger.onMenuPrint(() => doPrint());
    window.ledger.onMenuToggleCharts(() => setShowCharts((v) => !v));
    window.ledger.onMenuToggleForecast(() => setShowProjection((v) => !v));
    window.ledger.onMenuRecurring(() => {
      setRecurringSeed(null);
      setShowRecurring(true);
    });
    window.ledger.onMenuSearch(() => setShowSearchDialog(true));
    window.ledger.onMenuImportData(() => void doImportData());
    window.ledger.onMenuExportData(() => void doExportData());
    window.ledger.onMenuDbNew(() => void handleDbSwitch(() => window.ledger.dbNew(), "New database"));
    window.ledger.onMenuDbOpen(() => void handleDbSwitch(() => window.ledger.dbOpen(), "Opened"));
    window.ledger.onMenuDbOpenDefault(() =>
      void handleDbSwitch(() => window.ledger.dbOpenDefault(), "Opened")
    );
    window.ledger.onMenuDbSaveAs(() =>
      void handleDbSwitch(() => window.ledger.dbSaveAs(), "Saved as")
    );
    window.ledger.onMenuDbRestore(() =>
      void handleDbSwitch(() => window.ledger.dbRestore(), "Restored")
    );
    window.ledger.onMenuDbBackup(() => void handleDbBackup());
  }, [refreshAccounts, refreshCategories, doPrint, doImportData, doExportData]);

  // Persist ledger column widths to settings when the user resizes columns.
  const handleColumnWidthsChange = useCallback((widths: Record<string, number>) => {
    setColumnWidths(widths);
    void window.ledger.saveSettings({ ledgerColumnWidths: widths });
  }, []);

  // Persist forecast ledger column widths to settings.
  const handleForecastColumnWidthsChange = useCallback((widths: Record<string, number>) => {
    setForecastColumnWidths(widths);
    void window.ledger.saveSettings({ forecastColumnWidths: widths });
  }, []);

  // Run a search: snapshot the whole-DB aggregate data and open the results.
  const runSearch = useCallback(async (criteria: SearchCriteria) => {
    const data = await window.ledger.getAggregateData();
    setSearchData(data);
    setSearchCriteria(criteria);
    setShowSearchDialog(false);
  }, []);

  // After an edit in the results view, re-snapshot data and refresh the main UI.
  const reloadSearch = useCallback(async () => {
    setSearchData(await window.ledger.getAggregateData());
    await refreshAccounts();
    await refreshCategories();
    if (selectedRef.current) await refreshLedger(selectedRef.current.id);
  }, [refreshAccounts, refreshCategories, refreshLedger]);

  // Draggable divider between the accounts sidebar and the ledger panel.
  const SIDEBAR_MIN = 160;
  const SIDEBAR_MAX = 640;
  const sidebarDrag = useRef<{ startX: number; startWidth: number } | null>(null);

  const onSidebarDragMove = useCallback((e: MouseEvent) => {
    const d = sidebarDrag.current;
    if (!d) return;
    const next = Math.min(
      SIDEBAR_MAX,
      Math.max(SIDEBAR_MIN, d.startWidth + (e.clientX - d.startX))
    );
    setSidebarWidth(next);
  }, []);

  const onSidebarDragEnd = useCallback(() => {
    sidebarDrag.current = null;
    document.body.style.cursor = "";
    document.body.style.userSelect = "";
    window.removeEventListener("mousemove", onSidebarDragMove);
    window.removeEventListener("mouseup", onSidebarDragEnd);
    // Persist the final width.
    setSidebarWidth((w) => {
      void window.ledger.saveSettings({ sidebarWidth: w });
      return w;
    });
  }, [onSidebarDragMove]);

  const startSidebarDrag = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      sidebarDrag.current = { startX: e.clientX, startWidth: sidebarWidth };
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
      window.addEventListener("mousemove", onSidebarDragMove);
      window.addEventListener("mouseup", onSidebarDragEnd);
    },
    [sidebarWidth, onSidebarDragMove, onSidebarDragEnd]
  );

  // Clean up drag listeners if the app unmounts mid-drag.
  useEffect(() => onSidebarDragEnd, [onSidebarDragEnd]);

  useEffect(() => {
    if (selectedId) void refreshLedger(selectedId);
    else setLedger([]);
  }, [selectedId, refreshLedger]);

  const createAccount = useCallback(
    async (input: NewAccountInput) => {
      const created = await window.ledger.createAccount(input);
      setShowAccountDialog(false);
      await refreshAccounts();
      setSelectedId(created.id);
    },
    [refreshAccounts]
  );

  const createTransaction = useCallback(
    async (input: NewTransactionInput) => {
      await window.ledger.createTransaction(input);
      setShowTxDialog(false);
      if (selectedId) await refreshLedger(selectedId);
      await refreshAccounts(); // balances change
    },
    [selectedId, refreshLedger, refreshAccounts]
  );

  // Record an investment trade (buy/sell/dividend/reinvest). Creates the linked
  // cash transaction in the main process; refresh ledger + balances afterward.
  const recordTrade = useCallback(
    async (input: NewTradeInput) => {
      await window.ledger.recordTrade(input);
      setShowTxDialog(false);
      if (selectedId) await refreshLedger(selectedId);
      await refreshAccounts(); // cash balance + holdings change
      setHoldingsReloadKey((k) => k + 1); // refresh the holdings panel
    },
    [selectedId, refreshLedger, refreshAccounts]
  );

  const addCategory = useCallback(
    async (input: NewCategoryInput) => {
      await window.ledger.createCategory(input);
      await refreshCategories();
    },
    [refreshCategories]
  );

  const updateCategoryFields = useCallback(
    async (id: string, patch: Partial<NewCategoryInput>) => {
      await window.ledger.updateCategory({ id, ...patch });
      await refreshCategories();
      // Categories affect ledger category display, so refresh the current ledger too.
      if (selectedId) await refreshLedger(selectedId);
    },
    [refreshCategories, refreshLedger, selectedId]
  );

  const refreshCategoryUsage = useCallback(async () => {
    setCategoryUsage(await window.ledger.getCategoryUsage());
  }, []);

  const deleteCategory = useCallback(
    async (id: string) => {
      try {
        await window.ledger.deleteCategory(id);
        await refreshCategories();
        await refreshCategoryUsage();
        if (selectedId) await refreshLedger(selectedId);
      } catch (e) {
        setToast(e instanceof Error ? e.message : "Could not delete category.");
      }
    },
    [refreshCategories, refreshCategoryUsage, refreshLedger, selectedId]
  );

  // Refresh usage counts each time the Categories editor opens so the trash
  // buttons reflect the current state.
  useEffect(() => {
    if (showCategoriesDialog) void refreshCategoryUsage();
  }, [showCategoriesDialog, refreshCategoryUsage]);

  // Persist edits from the Edit Account dialog.
  const saveAccount = useCallback(
    async (update: UpdateAccountInput) => {
      await window.ledger.updateAccount(update);
      setEditAccount(null);
      await refreshAccounts();
      if (selectedId) await refreshLedger(selectedId);
    },
    [refreshAccounts, refreshLedger, selectedId]
  );

  const handleEdit = useCallback(
    async (
      id: string,
      field: "date" | "payee" | "memo" | "amountCents" | "categoryId",
      value: unknown
    ) => {
      if (!selected) return;
      if (field === "amountCents") {
        // Grid provides the account-signed amount; persist the magnitude.
        // Direction (from/to) is preserved, so transfers are editable too (M2).
        await window.ledger.updateTransaction({ id, amountCents: Math.abs(Number(value)) });
      } else if (field === "categoryId") {
        await window.ledger.updateTransaction({ id, categoryId: (value as string) ?? null });
      } else {
        await window.ledger.updateTransaction({ id, [field]: value } as never);
      }
      await refreshLedger(selected.id);
      await refreshAccounts();
    },
    [selected, refreshLedger, refreshAccounts]
  );

  // Edits to the opening-balance ledger row update the account (not a transaction).
  const handleEditOpening = useCallback(
    async (field: "date" | "openingBalanceCents", value: unknown) => {
      if (!selected) return;
      if (field === "date") {
        await window.ledger.updateAccount({
          id: selected.id,
          openingBalanceDate: (value as string) || null,
        });
      } else {
        await window.ledger.updateAccount({
          id: selected.id,
          openingBalanceCents: Number(value),
        });
      }
      await refreshLedger(selected.id);
      await refreshAccounts();
    },
    [selected, refreshLedger, refreshAccounts]
  );

  // Open the split editor for a transaction viewed from `account`, seeding the
  // legs from existing splits, or (for a loan paydown transfer) an auto-computed
  // principal/interest split, else a single seed leg. `onSaved` refreshes the
  // caller's view. Shared by the main ledger and the Search results view.
  const openSplitEditor = useCallback(
    async (
      tx: Transaction,
      account: Account,
      isSplit: boolean,
      existingSplits: TransactionSplit[] | undefined,
      signedTotalCents: number,
      onSaved: () => void | Promise<void>
    ) => {
      const isOwner = tx.fromAccountId === account.id || tx.toAccountId === account.id;
      const ownerFromId =
        tx.fromAccountId && tx.fromAccountId !== account.id
          ? tx.fromAccountId
          : tx.toAccountId && tx.toAccountId !== account.id
            ? tx.toAccountId
            : null;
      const fromAccountName = ownerFromId
        ? accounts.find((a) => a.id === ownerFromId)?.name
        : undefined;

      let initialSplits: NewSplitInput[];
      if (isSplit && existingSplits && existingSplits.length > 0) {
        initialSplits = existingSplits.map((s) => ({
          amountCents: s.amountCents,
          categoryId: s.categoryId,
          transferAccountId: s.transferAccountId,
          memo: s.memo,
        }));
      } else {
        const otherId =
          tx.fromAccountId && tx.toAccountId
            ? tx.fromAccountId === account.id
              ? tx.toAccountId
              : tx.fromAccountId
            : null;
        const otherAcct = otherId ? accounts.find((a) => a.id === otherId) : undefined;
        const paysDownLoan = otherAcct?.type === "loan" && signedTotalCents < 0;
        let autoSplits: NewSplitInput[] | null = null;
        if (isOwner && paysDownLoan) {
          try {
            const result = await window.ledger.buildLoanPaymentSplit(tx.id);
            autoSplits = result.splits;
            await refreshCategories();
          } catch {
            autoSplits = null;
          }
        }
        initialSplits =
          autoSplits ??
          [
            {
              amountCents: signedTotalCents,
              categoryId: otherId ? null : tx.categoryId,
              transferAccountId: otherId,
              memo: null,
            },
          ];
      }
      setSplitEditor({
        txId: tx.id,
        account,
        signedTotalCents,
        initialSplits,
        readOnly: !isOwner,
        fromAccountName,
        onSaved,
      });
    },
    [accounts, refreshCategories]
  );

  // Apply a category/none/transfer change to a transaction. Always clears any
  // existing split legs (splits:[]) so a former split becomes a single entry.
  const applyCategoryChange = useCallback(
    async (id: string, choice: CategoryChoice) => {
      if (!selected) return;
      const row = ledger.find((r) => r.transaction?.id === id);
      const t = row?.transaction;
      if (!t) return;
      // Which side is the viewed account on? Keep that; change the other side.
      const accountIsFrom = t.fromAccountId === selected.id;
      if (choice.kind === "transfer") {
        const target = accounts.find((a) => a.id === choice.accountId);
        // When a NON-SPLIT outflow is pointed at a LOAN account, treat it as a
        // loan payment: apply the transfer, then open the split editor pre-seeded
        // with the auto principal/interest split. Fires from any prior category
        // state (uncategorized or categorized) — only an existing split is exempt.
        const notSplit = !row!.isSplit;
        const outflow = accountIsFrom || row!.signedAmountCents < 0;
        const autoLoanSplit = target?.type === "loan" && notSplit && outflow;

        await window.ledger.updateTransaction({
          id,
          categoryId: null,
          fromAccountId: accountIsFrom ? selected.id : choice.accountId,
          toAccountId: accountIsFrom ? choice.accountId : selected.id,
          // Discard any split legs when switching to a plain transfer.
          splits: [],
        });
        await refreshLedger(selected.id);
        await refreshAccounts();

        if (autoLoanSplit) {
          // Re-fetch the updated transaction (now a transfer) and open the split
          // editor with the auto-computed principal/interest legs.
          const rows = await window.ledger.getLedger(selected.id);
          const updated = rows.find((r) => r.transaction?.id === id);
          if (updated?.transaction) {
            await openSplitEditor(
              updated.transaction,
              selected,
              false,
              undefined,
              updated.signedAmountCents,
              async () => {
                await refreshLedger(selected.id);
                await refreshAccounts();
              }
            );
          }
        }
        return;
      }
      // Category or none: clear the counterparty side so it's single-entry.
      await window.ledger.updateTransaction({
        id,
        categoryId: choice.kind === "category" ? choice.categoryId : null,
        fromAccountId: accountIsFrom ? selected.id : null,
        toAccountId: accountIsFrom ? null : selected.id,
        // Discard any split legs when switching to a plain category/none.
        splits: [],
      });
      await refreshLedger(selected.id);
      await refreshAccounts();
    },
    [selected, ledger, accounts, refreshLedger, refreshAccounts, openSplitEditor]
  );

  // The Category column can set a category, clear it, or convert the row into a
  // transfer (choosing another account). We preserve the viewed account's side of
  // the entry (determined by the current from/to) and set/clear the other side.
  const handleSetCategoryOrTransfer = useCallback(
    async (id: string, choice: CategoryChoice) => {
      if (!selected) return;
      const row = ledger.find((r) => r.transaction?.id === id);
      const t = row?.transaction;
      if (!t) return;
      // "Split…" opens the split editor, seeded from the transaction's current state.
      if (choice.kind === "split") {
        await openSplitEditor(
          t,
          selected,
          !!row!.isSplit,
          row!.splits,
          row!.signedAmountCents,
          async () => {
            await refreshLedger(selected.id);
            await refreshAccounts();
          }
        );
        return;
      }
      // Changing a SPLIT transaction to a plain category/transfer discards its
      // split legs. Confirm first; the actual change (and split removal) happens
      // in applyCategoryChange after the user clicks "Change".
      if (row!.isSplit) {
        setPendingSplitChange({ id, choice });
        return;
      }
      await applyCategoryChange(id, choice);
    },
    [selected, ledger, accounts, applyCategoryChange, openSplitEditor, refreshLedger, refreshAccounts]
  );

  // Persist split legs from the split editor.
  const saveSplit = useCallback(
    async (splits: NewSplitInput[]) => {
      if (!splitEditor) return;
      const owner = splitEditor.account;
      try {
        // A split is owned by a single account; its counterparties live in
        // transfer legs. Normalize the transaction's from/to to just the owning
        // side so the leg sum matches the stored owning-signed total (avoids
        // "splits don't sum" when converting a transfer into a split).
        const signedTotal = splitEditor.signedTotalCents;
        const owningFrom = signedTotal < 0 ? owner.id : null;
        const owningTo = signedTotal < 0 ? null : owner.id;
        await window.ledger.updateTransaction({
          id: splitEditor.txId,
          amountCents: Math.abs(signedTotal),
          fromAccountId: owningFrom,
          toAccountId: owningTo,
          splits,
        });
        const onSaved = splitEditor.onSaved;
        setSplitEditor(null);
        if (onSaved) await onSaved();
      } catch (e) {
        setToast(e instanceof Error ? e.message : "Could not save split.");
      }
    },
    [splitEditor]
  );

  // Stage a delete: the grid's trash button asks for confirmation first.
  const handleDelete = useCallback((id: string) => {
    setPendingDeleteId(id);
  }, []);

  // Build a recurring-rule seed from a transaction (used by "Add to Recurring").
  const seedFromTransaction = useCallback(
    (t: Transaction): Partial<NewRecurringRuleInput> => ({
      name: t.payee?.trim() || "Recurring",
      amountCents: t.amountCents,
      estimateMode: "fixed",
      fromAccountId: t.fromAccountId,
      toAccountId: t.toAccountId,
      categoryId: t.categoryId,
      frequency: "monthly",
      intervalCount: 1,
      startDate: t.date,
      // Anchor monthly rules to the transaction's day-of-month.
      dayOfMonth: Number(t.date.slice(8, 10)) || null,
    }),
    []
  );

  // Apply a category / uncategorized / transfer choice to MANY selected rows at
  // once (Bulk Category). Each row keeps the viewed account's side; the other
  // side is set/cleared. No loan auto-split in bulk. Split legs are discarded.
  const bulkSetCategory = useCallback(
    async (ids: string[], choice: CategoryChoice) => {
      if (!selected || ids.length === 0) return;
      if (choice.kind === "split") return; // not supported in bulk
      try {
        for (const id of ids) {
          const t = ledger.find((r) => r.transaction?.id === id)?.transaction;
          if (!t) continue;
          const accountIsFrom = t.fromAccountId === selected.id;
          if (choice.kind === "transfer") {
            await window.ledger.updateTransaction({
              id,
              categoryId: null,
              fromAccountId: accountIsFrom ? selected.id : choice.accountId,
              toAccountId: accountIsFrom ? choice.accountId : selected.id,
              splits: [],
            });
          } else {
            await window.ledger.updateTransaction({
              id,
              categoryId: choice.kind === "category" ? choice.categoryId : null,
              fromAccountId: accountIsFrom ? selected.id : null,
              toAccountId: accountIsFrom ? null : selected.id,
              splits: [],
            });
          }
        }
        await refreshLedger(selected.id);
        await refreshAccounts();
        setToast(`Updated ${ids.length} transaction(s).`);
      } catch (e) {
        setToast(e instanceof Error ? e.message : "Bulk category change failed.");
      }
    },
    [selected, ledger, refreshLedger, refreshAccounts]
  );

  // Build the "Bulk Category" submenu: Uncategorized, a disabled Split, then
  // categories, then transfer accounts — applied to the given selected ids.
  const buildBulkCategorySubmenu = useCallback(
    (ids: string[]): ContextMenuItem[] => {
      const catItems: ContextMenuItem[] = categoryOptions(categories).map((o) => ({
        label: o.display,
        onClick: () =>
          void bulkSetCategory(ids, {
            kind: "category",
            categoryId: o.category.id,
            label: o.display,
          }),
      }));
      const acctItems: ContextMenuItem[] = accounts
        .filter((a) => a.id !== selected?.id)
        .map((a) => ({
          label: `→ ${a.name}`,
          onClick: () =>
            void bulkSetCategory(ids, { kind: "transfer", accountId: a.id, label: a.name }),
        }));
      return [
        { label: "— Uncategorized —", onClick: () => void bulkSetCategory(ids, { kind: "none" }) },
        { label: "Split… (not available in bulk)", disabled: true },
        ...catItems,
        ...acctItems,
      ];
    },
    [categories, accounts, selected, bulkSetCategory]
  );

  // Right-click on a ledger cell: offer Copy <field> and Add to Recurring.
  const handleCellContext = useCallback(
    (info: {
      x: number;
      y: number;
      field: string;
      headerName: string;
      displayValue: string;
      transactionId: string;
      isOpening: boolean;
      selectedTransactionIds: string[];
    }) => {
      const items: ContextMenuItem[] = [];
      if (info.displayValue) {
        items.push({
          label: `Copy ${info.headerName || "field"}`,
          onClick: () => {
            void navigator.clipboard.writeText(info.displayValue);
            setToast(`Copied ${info.headerName || "field"}.`);
          },
        });
      }
      // "Add to Recurring" applies to real transactions only (not the opening row).
      if (!info.isOpening) {
        const row = ledger.find((r) => r.transaction?.id === info.transactionId);
        const t = row?.transaction;
        if (t) {
          items.push({
            label: "Add to Recurring…",
            onClick: () => {
              setRecurringSeed(seedFromTransaction(t));
              setShowRecurring(true);
            },
          });
        }
      }
      // Bulk actions when more than one transaction row is selected.
      if (info.selectedTransactionIds.length > 1) {
        const ids = info.selectedTransactionIds;
        items.push({
          label: `Bulk Category (${ids.length})`,
          submenu: buildBulkCategorySubmenu(ids),
        });
        items.push({
          label: `Bulk Delete (${ids.length})`,
          onClick: () => setPendingBulkDelete(ids),
        });
      }
      if (items.length === 0) return;
      setLedgerMenu({ x: info.x, y: info.y, items });
    },
    [ledger, seedFromTransaction, buildBulkCategorySubmenu]
  );

  const confirmDelete = useCallback(async () => {
    if (!selected || !pendingDeleteId) return;
    await window.ledger.deleteTransaction(pendingDeleteId);
    setPendingDeleteId(null);
    await refreshLedger(selected.id);
    await refreshAccounts();
    setHoldingsReloadKey((k) => k + 1); // trade legs may have been removed
  }, [selected, pendingDeleteId, refreshLedger, refreshAccounts]);

  // Delete all transactions staged for bulk deletion, then refresh.
  const confirmBulkDelete = useCallback(async () => {
    if (!selected || !pendingBulkDelete || pendingBulkDelete.length === 0) return;
    const ids = pendingBulkDelete;
    setPendingBulkDelete(null);
    for (const id of ids) {
      await window.ledger.deleteTransaction(id);
    }
    await refreshLedger(selected.id);
    await refreshAccounts();
    setHoldingsReloadKey((k) => k + 1);
    setToast(`Deleted ${ids.length} transaction(s).`);
  }, [selected, pendingBulkDelete, refreshLedger, refreshAccounts]);

  // Human-readable description of the transaction pending deletion.
  const pendingDeleteLabel = useMemo(() => {
    if (!pendingDeleteId || !selected) return "";
    const row = ledger.find((r) => r.transaction?.id === pendingDeleteId);
    if (!row || !row.transaction) return "this transaction";
    const payee = row.transaction.payee?.trim();
    const amount = formatCents(
      Math.abs(row.signedAmountCents),
      selected.currency
    );
    return payee ? `“${payee}” (${amount})` : `this transaction (${amount})`;
  }, [pendingDeleteId, ledger, selected]);

  return (
    <div
      className="app"
      style={{ gridTemplateColumns: `${sidebarWidth}px 6px 1fr` }}
    >
      <aside className="sidebar">
        <h1>BudgetLion</h1>
        {accounts.map((a) => {
          const bal = balanceMap.get(a.id);
          return (
            <div
              key={a.id}
              className={"account-item" + (a.id === selectedId ? " active" : "")}
              onClick={() => setSelectedId(a.id)}
              onContextMenu={(e) => {
                e.preventDefault();
                setSelectedId(a.id);
                setAccountMenu({ x: e.clientX, y: e.clientY, account: a });
              }}
            >
              <div className="account-main">
                <div className="account-name">{a.name}</div>
                {a.accountCode && (
                  <div className="account-number">{a.accountCode}</div>
                )}
              </div>
              <div className="account-side">
                {bal != null && (
                  <div className="bal">{formatCents(bal * displaySign(a.type), a.currency)}</div>
                )}
                <div className="account-type">{a.type.replace("_", " ")}</div>
              </div>
            </div>
          );
        })}
        <div style={{ marginTop: 12, display: "flex", flexDirection: "column", gap: 8 }}>
          <button className="secondary" onClick={() => setShowAccountDialog(true)}>
            + Add Account
          </button>
          <button className="secondary" onClick={() => setShowCategoriesDialog(true)}>
            Categories…
          </button>
          <button className="secondary" onClick={() => setShowSearchDialog(true)}>
            Search…
          </button>
        </div>
      </aside>

      <div
        className="app-divider"
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize accounts panel"
        title="Drag to resize the accounts panel"
        onMouseDown={startSidebarDrag}
      />

      <main className="main">
        {selected ? (
          <>
            <div className="toolbar">
              <h2>{selected.name}</h2>
              <button
                className={"secondary" + (showCharts ? " active-toggle" : "")}
                onClick={() => setShowCharts((v) => !v)}
              >
                Charts
              </button>
              <button
                className={"secondary" + (showProjection ? " active-toggle" : "")}
                onClick={() => setShowProjection((v) => !v)}
              >
                Forecast
              </button>
              <button
                className="secondary"
                onClick={() =>
                  selected.type === "investment"
                    ? setShowInvestmentImport(true)
                    : setShowImportDialog(true)
                }
              >
                Import…
              </button>
              <button className="secondary" onClick={() => setShowExportDialog(true)}>
                Export…
              </button>
              <button className="secondary" onClick={doPrint}>
                Print…
              </button>
              <button
                onClick={() => {
                  setInvTxMode("choose");
                  setShowTxDialog(true);
                }}
              >
                + New Transaction
              </button>
            </div>
            {selected.type === "investment" && (
              <HoldingsPanel account={selected} reloadKey={holdingsReloadKey} />
            )}
            {showCharts && (
              <ChartsPanel
                account={selected}
                dark={dark}
                onClose={() => setShowCharts(false)}
                onToast={setToast}
              />
            )}
            {showProjection && (
              <ProjectionPanel
                account={selected}
                dark={dark}
                onClose={() => setShowProjection(false)}
                initialColumnWidths={forecastColumnWidths}
                onColumnWidthsChange={handleForecastColumnWidthsChange}
              />
            )}
            {ledger.length === 0 ? (
              <div className="empty">No transactions yet. Add one to get started.</div>
            ) : (
              <LedgerGrid
                account={selected}
                rows={ledger}
                categories={categories}
                accounts={accounts}
                dark={dark}
                onEdit={handleEdit}
                onEditOpening={handleEditOpening}
                onSetCategoryOrTransfer={handleSetCategoryOrTransfer}
                onDelete={handleDelete}
                onCellContext={handleCellContext}
                columnWidths={columnWidths}
                onColumnWidthsChange={handleColumnWidthsChange}
                payeeSuggestions={payeeSuggestions}
                memoSuggestions={memoSuggestions}
              />
            )}
          </>
        ) : (
          <div className="empty">Create an account to begin.</div>
        )}
      </main>

      {showAccountDialog && (
        <NewAccountDialog
          categories={categories}
          accounts={accounts}
          onCancel={() => setShowAccountDialog(false)}
          onCreate={createAccount}
        />
      )}
      {showTxDialog && selected && selected.type === "investment" && invTxMode === "choose" && (
        <div className="dialog-backdrop" onClick={() => setShowTxDialog(false)}>
          <div className="dialog" onClick={(e) => e.stopPropagation()}>
            <h3>New Transaction</h3>
            <p className="muted">What would you like to record in {selected.name}?</p>
            <div className="dialog-actions" style={{ justifyContent: "flex-start", gap: 10 }}>
              <button onClick={() => setInvTxMode("trade")}>Trade (buy / sell / dividend / grant)</button>
              <button className="secondary" onClick={() => setInvTxMode("cash")}>
                Transfer / cash transaction
              </button>
            </div>
            <div className="dialog-actions">
              <button className="secondary" onClick={() => setShowTxDialog(false)}>
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}
      {showTxDialog && selected && selected.type === "investment" && invTxMode === "trade" && (
        <NewInvestmentDialog
          account={selected}
          categories={categories}
          onCancel={() => setShowTxDialog(false)}
          onSubmit={recordTrade}
        />
      )}
      {showTxDialog &&
        selected &&
        (selected.type !== "investment" || invTxMode === "cash") && (
          <NewTransactionDialog
            account={selected}
            accounts={accounts}
            categories={categories}
            payeeSuggestions={payeeSuggestions}
            memoSuggestions={memoSuggestions}
            onCancel={() => setShowTxDialog(false)}
            onCreate={createTransaction}
          />
        )}
      {showCategoriesDialog && (
        <CategoriesDialog
          categories={categories}
          usedCategoryIds={new Set(Object.keys(categoryUsage))}
          onClose={() => setShowCategoriesDialog(false)}
          onAdd={addCategory}
          onUpdate={updateCategoryFields}
          onDelete={deleteCategory}
        />
      )}
      {pendingDeleteId && (
        <ConfirmDialog
          title="Delete transaction?"
          message={`Are you sure you want to delete ${pendingDeleteLabel}? This can’t be undone.`}
          confirmLabel="Delete"
          onConfirm={confirmDelete}
          onCancel={() => setPendingDeleteId(null)}
        />
      )}
      {pendingBulkDelete && pendingBulkDelete.length > 0 && (
        <ConfirmDialog
          title="Delete transactions?"
          message={`Are you sure you want to delete ${pendingBulkDelete.length} selected transaction(s)? This can’t be undone.`}
          confirmLabel="Delete"
          onConfirm={() => void confirmBulkDelete()}
          onCancel={() => setPendingBulkDelete(null)}
        />
      )}
      {showImportDialog && selected && (
        <ImportDialog
          account={selected}
          accounts={accounts}
          onCancel={() => setShowImportDialog(false)}
          onDone={async (count) => {
            setShowImportDialog(false);
            if (selected) await refreshLedger(selected.id);
            await refreshAccounts();
            setToast(
              count === 0
                ? "No new transactions imported (all were duplicates)."
                : `Imported ${count} transaction(s) into ${selected.name}.`
            );
          }}
        />
      )}
      {showInvestmentImport && selected && selected.type === "investment" && (
        <InvestmentImportDialog
          account={selected}
          onCancel={() => setShowInvestmentImport(false)}
          onDone={async (count) => {
            setShowInvestmentImport(false);
            if (selected) await refreshLedger(selected.id);
            await refreshAccounts();
            setHoldingsReloadKey((k) => k + 1);
            setToast(
              count === 0
                ? "No trades imported."
                : `Imported ${count} trade(s) into ${selected.name}.`
            );
          }}
        />
      )}
      {showExportDialog && selected && (
        <ExportDialog
          account={selected}
          rows={ledger}
          categories={categories}
          accounts={accounts}
          printFont={{ font: printFontRef.current.font, sizePx: printFontRef.current.size }}
          onCancel={() => setShowExportDialog(false)}
          onDone={(message) => {
            setShowExportDialog(false);
            setToast(message);
          }}
        />
      )}
      {toast && <Toast message={toast} onDone={() => setToast(null)} />}

      {accountMenu && (
        <ContextMenu
          x={accountMenu.x}
          y={accountMenu.y}
          items={[
            { label: "View", onClick: () => setViewAccount(accountMenu.account) },
            { label: "Edit", onClick: () => setEditAccount(accountMenu.account) },
          ]}
          onClose={() => setAccountMenu(null)}
        />
      )}
      {viewAccount && (
        <ViewAccountDialog account={viewAccount} onClose={() => setViewAccount(null)} />
      )}
      {editAccount && (
        <EditAccountDialog
          account={editAccount}
          categories={categories}
          accounts={accounts}
          onCancel={() => setEditAccount(null)}
          onSave={saveAccount}
        />
      )}
      {splitEditor && (
        <SplitEditorDialog
          account={splitEditor.account}
          accounts={accounts}
          categories={categories}
          signedTotalCents={splitEditor.signedTotalCents}
          initialSplits={splitEditor.initialSplits}
          readOnly={splitEditor.readOnly}
          currentAccountId={splitEditor.account.id}
          fromAccountName={splitEditor.fromAccountName}
          onCancel={() => setSplitEditor(null)}
          onSave={saveSplit}
        />
      )}
      {pendingSplitChange && (
        <ConfirmDialog
          title="Change category?"
          message="This transaction is split. Changing it to a single category or transfer will delete its split legs. Continue?"
          confirmLabel="Change"
          cancelLabel="Cancel"
          onConfirm={() => {
            const pending = pendingSplitChange;
            setPendingSplitChange(null);
            void applyCategoryChange(pending.id, pending.choice);
          }}
          onCancel={() => setPendingSplitChange(null)}
        />
      )}
      {showRecurring && (
        <RecurringRulesDialog
          accounts={accounts}
          categories={categories}
          initialSeed={recurringSeed}
          onClose={() => {
            setShowRecurring(false);
            setRecurringSeed(null);
          }}
          onChanged={() => setToast("Recurring rules updated.")}
        />
      )}
      {ledgerMenu && (
        <ContextMenu
          x={ledgerMenu.x}
          y={ledgerMenu.y}
          items={ledgerMenu.items}
          onClose={() => setLedgerMenu(null)}
        />
      )}
      {dedupeScanning && <Toast message="Scanning for duplicates…" onDone={() => {}} />}
      {dedupeAskAI && (
        <ConfirmDialog
          title="Use AI for de-duplication?"
          message="An AI provider is configured and responding. Use it to judge whether payee names refer to the same payee? Choosing “No” uses basic exact-match comparison."
          confirmLabel="Yes, use AI"
          cancelLabel="No, basic match"
          destructive={false}
          onConfirm={() => {
            setDedupeAskAI(false);
            void startDedupeScan(true);
          }}
          onCancel={() => {
            setDedupeAskAI(false);
            void startDedupeScan(false);
          }}
        />
      )}
      {dedupePairs.length > 0 &&
        dedupeIndex < dedupePairs.length &&
        (() => {
          const pair = dedupePairs[dedupeIndex];
          return (
            <DedupeDialog
              a={pair.a}
              b={pair.b}
              currency={selected?.currency ?? "USD"}
              accounts={accounts}
              progressLabel={`${dedupeIndex + 1} of ${dedupePairs.length}`}
              onDelete={(id) => void handleDedupeDelete(id)}
              onSkip={handleDedupeSkip}
              onClose={closeDedupe}
            />
          );
        })()}
      {showSearchDialog && (
        <SearchDialog
          accounts={accounts}
          categories={categories}
          initialAccountId={selectedId}
          onCancel={() => setShowSearchDialog(false)}
          onSearch={(criteria) => void runSearch(criteria)}
        />
      )}
      {searchData && searchCriteria && (
        <SearchResults
          data={searchData}
          criteria={searchCriteria}
          dark={dark}
          onClose={() => {
            setSearchData(null);
            setSearchCriteria(null);
          }}
          onReload={() => void reloadSearch()}
          onToast={setToast}
          onEditSplit={(tx, account, isSplit, splits, signedTotalCents) =>
            void openSplitEditor(tx, account, isSplit, splits, signedTotalCents, () =>
              reloadSearch()
            )
          }
        />
      )}
    </div>
  );
}

/** Small auto-dismissing status message. */
function Toast({ message, onDone }: { message: string; onDone: () => void }) {
  useEffect(() => {
    const t = setTimeout(onDone, 4000);
    return () => clearTimeout(t);
  }, [onDone]);
  return <div className="toast">{message}</div>;
}
