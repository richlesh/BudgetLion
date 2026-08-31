import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import "ag-grid-community/styles/ag-grid.css";
import "ag-grid-community/styles/ag-theme-alpine.css";
import type {
  Account,
  AccountBalance,
  Category,
  LedgerRow,
  NewAccountInput,
  NewTransactionInput,
  UpdateAccountInput,
  NewSplitInput,
} from "./shared/types";
import { displaySign, formatCents } from "./core/money";
import { ledgerToHtml } from "./core/export/html";
import { LedgerGrid } from "./components/LedgerGrid";
import type { CategoryChoice } from "./components/CategoryAccountEditor";
import { NewAccountDialog } from "./components/NewAccountDialog";
import { SplitEditorDialog } from "./components/SplitEditorDialog";
import { NewTransactionDialog } from "./components/NewTransactionDialog";
import { CategoriesDialog } from "./components/CategoriesDialog";
import { ConfirmDialog } from "./components/ConfirmDialog";
import { ImportDialog } from "./components/ImportDialog";
import { ExportDialog } from "./components/ExportDialog";
import { ContextMenu } from "./components/ContextMenu";
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
  const [showCategoriesDialog, setShowCategoriesDialog] = useState(false);
  const [showImportDialog, setShowImportDialog] = useState(false);
  const [showExportDialog, setShowExportDialog] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [dark, setDark] = useState(false);
  // Persisted ledger column widths (colId -> px), loaded from settings.
  const [columnWidths, setColumnWidths] = useState<Record<string, number>>({});
  // Transaction id staged for deletion, pending user confirmation.
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);
  // Right-click account context menu + view/edit account dialogs.
  const [accountMenu, setAccountMenu] = useState<{ x: number; y: number; account: Account } | null>(
    null
  );
  const [viewAccount, setViewAccount] = useState<Account | null>(null);
  const [editAccount, setEditAccount] = useState<Account | null>(null);
  // Split editor: transaction id + its signed total on the selected account + seed legs.
  const [splitEditor, setSplitEditor] = useState<{
    txId: string;
    signedTotalCents: number;
    initialSplits: NewSplitInput[];
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
    const html = ledgerToHtml(acct, ledgerRef.current, categoriesRef.current);
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
          `Exported ${bundle.accounts.length} account(s) and ${bundle.categories.length} category(ies).`
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
      };
      const bundle = {
        accounts: parsed.accounts ?? [],
        categories: parsed.categories ?? [],
      };
      const counts = await window.ledger.importData(bundle);
      await refreshAccounts();
      await refreshCategories();
      if (selectedRef.current) await refreshLedger(selectedRef.current.id);
      setToast(
        `Imported ${counts.accounts} account(s) and ${counts.categories} category(ies).`
      );
    } catch (e) {
      setToast(`Import failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }, [refreshAccounts, refreshCategories, refreshLedger]);

  // Initial load + theme + menu wiring. Menu listeners are registered ONCE.
  useEffect(() => {
    void refreshAccounts();
    void refreshCategories();
    void window.ledger.getSettings().then((s) => {
      const isDark = s.theme === "dark";
      document.body.classList.toggle("dark", isDark);
      setDark(isDark);
      if (s.ledgerColumnWidths) setColumnWidths(s.ledgerColumnWidths);
    });
    window.ledger.onSettingsChanged((s) => {
      const isDark = s.theme === "dark";
      document.body.classList.toggle("dark", isDark);
      setDark(isDark);
    });
    window.ledger.onMenuNewTransaction(() => {
      if (selectedRef.current) setShowTxDialog(true);
    });
    window.ledger.onMenuImport(() => {
      if (selectedRef.current) setShowImportDialog(true);
    });
    window.ledger.onMenuExport(() => {
      if (selectedRef.current) setShowExportDialog(true);
    });
    window.ledger.onMenuPrint(() => doPrint());
    window.ledger.onMenuImportData(() => void doImportData());
    window.ledger.onMenuExportData(() => void doExportData());
  }, [refreshAccounts, refreshCategories, doPrint, doImportData, doExportData]);

  // Persist ledger column widths to settings when the user resizes columns.
  const handleColumnWidthsChange = useCallback((widths: Record<string, number>) => {
    setColumnWidths(widths);
    void window.ledger.saveSettings({ ledgerColumnWidths: widths });
  }, []);

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

  const addCategory = useCallback(
    async (name: string) => {
      await window.ledger.createCategory({ name });
      await refreshCategories();
    },
    [refreshCategories]
  );

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
        const signedTotalCents = row!.signedAmountCents; // stored sign (owning account)
        let initialSplits: NewSplitInput[];
        if (row!.isSplit && row!.splits && row!.splits.length > 0) {
          initialSplits = row!.splits.map((s) => ({
            amountCents: s.amountCents,
            categoryId: s.categoryId,
            transferAccountId: s.transferAccountId,
            memo: s.memo,
          }));
        } else {
          // Seed from the single category/transfer as one leg (editor adds a blank second leg).
          const otherId =
            t.fromAccountId && t.toAccountId
              ? t.fromAccountId === selected.id
                ? t.toAccountId
                : t.fromAccountId
              : null;
          initialSplits = [
            {
              amountCents: signedTotalCents,
              categoryId: otherId ? null : t.categoryId,
              transferAccountId: otherId,
              memo: null,
            },
          ];
        }
        setSplitEditor({ txId: id, signedTotalCents, initialSplits });
        return;
      }
      // Which side is the viewed account on? Keep that; change the other side.
      const accountIsFrom = t.fromAccountId === selected.id;
      if (choice.kind === "transfer") {
        await window.ledger.updateTransaction({
          id,
          categoryId: null,
          fromAccountId: accountIsFrom ? selected.id : choice.accountId,
          toAccountId: accountIsFrom ? choice.accountId : selected.id,
        });
      } else {
        // Category or none: clear the counterparty side so it's single-entry.
        await window.ledger.updateTransaction({
          id,
          categoryId: choice.kind === "category" ? choice.categoryId : null,
          fromAccountId: accountIsFrom ? selected.id : null,
          toAccountId: accountIsFrom ? null : selected.id,
        });
      }
      await refreshLedger(selected.id);
      await refreshAccounts();
    },
    [selected, ledger, refreshLedger, refreshAccounts]
  );

  // Persist split legs from the split editor.
  const saveSplit = useCallback(
    async (splits: NewSplitInput[]) => {
      if (!selected || !splitEditor) return;
      await window.ledger.updateTransaction({ id: splitEditor.txId, splits });
      setSplitEditor(null);
      await refreshLedger(selected.id);
      await refreshAccounts();
    },
    [selected, splitEditor, refreshLedger, refreshAccounts]
  );

  // Stage a delete: the grid's trash button asks for confirmation first.
  const handleDelete = useCallback((id: string) => {
    setPendingDeleteId(id);
  }, []);

  const confirmDelete = useCallback(async () => {
    if (!selected || !pendingDeleteId) return;
    await window.ledger.deleteTransaction(pendingDeleteId);
    setPendingDeleteId(null);
    await refreshLedger(selected.id);
    await refreshAccounts();
  }, [selected, pendingDeleteId, refreshLedger, refreshAccounts]);

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
    <div className="app">
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
        </div>
      </aside>

      <main className="main">
        {selected ? (
          <>
            <div className="toolbar">
              <h2>{selected.name}</h2>
              <button className="secondary" onClick={() => setShowImportDialog(true)}>
                Import…
              </button>
              <button className="secondary" onClick={() => setShowExportDialog(true)}>
                Export…
              </button>
              <button className="secondary" onClick={doPrint}>
                Print…
              </button>
              <button onClick={() => setShowTxDialog(true)}>+ New Transaction</button>
            </div>
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
                columnWidths={columnWidths}
                onColumnWidthsChange={handleColumnWidthsChange}
              />
            )}
          </>
        ) : (
          <div className="empty">Create an account to begin.</div>
        )}
      </main>

      {showAccountDialog && (
        <NewAccountDialog
          onCancel={() => setShowAccountDialog(false)}
          onCreate={createAccount}
        />
      )}
      {showTxDialog && selected && (
        <NewTransactionDialog
          account={selected}
          accounts={accounts}
          categories={categories}
          onCancel={() => setShowTxDialog(false)}
          onCreate={createTransaction}
        />
      )}
      {showCategoriesDialog && (
        <CategoriesDialog
          categories={categories}
          onCancel={() => setShowCategoriesDialog(false)}
          onAdd={addCategory}
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
      {showExportDialog && selected && (
        <ExportDialog
          account={selected}
          rows={ledger}
          categories={categories}
          accounts={accounts}
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
          onCancel={() => setEditAccount(null)}
          onSave={saveAccount}
        />
      )}
      {splitEditor && selected && (
        <SplitEditorDialog
          account={selected}
          accounts={accounts}
          categories={categories}
          signedTotalCents={splitEditor.signedTotalCents}
          initialSplits={splitEditor.initialSplits}
          onCancel={() => setSplitEditor(null)}
          onSave={saveSplit}
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
