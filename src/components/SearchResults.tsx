import { useCallback, useMemo, useState } from "react";
import type { Account, AggregateData, Category, LedgerRow, Transaction, TransactionSplit } from "../shared/types";
import { buildLedger } from "../core/balances";
import { LedgerGrid } from "./LedgerGrid";
import type { CategoryChoice } from "./CategoryAccountEditor";
import { ContextMenu, type ContextMenuItem } from "./ContextMenu";
import { categoryOptions } from "../core/categories";
import type { SearchCriteria } from "../core/search";
import { searchTransactionIds, accountsWithMatches } from "../core/search";

interface Props {
  data: AggregateData;
  criteria: SearchCriteria;
  dark: boolean;
  onClose: () => void;
  /** Re-fetch aggregate data (after an edit) so results stay current. */
  onReload: () => void;
  onToast: (msg: string) => void;
  /**
   * Open the split editor for a result. Delegated to the app (which owns the
   * split editor + loan auto-split), scoped to the result's owning account.
   */
  onEditSplit: (
    tx: Transaction,
    account: Account,
    isSplit: boolean,
    splits: TransactionSplit[] | undefined,
    signedTotalCents: number
  ) => void;
}

/**
 * A modal ledger view of search results. Because the ledger grid is
 * single-account (signs/perspective are per account), results are grouped by
 * account and each group renders its own LedgerGrid — reusing the exact same
 * table and inline-edit mechanisms as the main ledger. Edits are account-scoped
 * and reload the search data on success.
 */
export function SearchResults({ data, criteria, dark, onClose, onReload, onToast, onEditSplit }: Props) {
  const matchingIds = useMemo(() => searchTransactionIds(data, criteria), [data, criteria]);
  const groupAccountIds = useMemo(
    () => accountsWithMatches(data, matchingIds, criteria.accountId),
    [data, matchingIds, criteria.accountId]
  );

  const accountById = useMemo(() => {
    const m = new Map<string, Account>();
    data.accounts.forEach((a) => m.set(a.id, a));
    return m;
  }, [data.accounts]);

  const splitsByTx = useMemo(() => {
    const m = new Map<string, TransactionSplit[]>();
    for (const s of data.splits) {
      if (s.deletedAt != null) continue;
      const arr = m.get(s.transactionId) ?? [];
      arr.push(s);
      m.set(s.transactionId, arr);
    }
    return m;
  }, [data.splits]);

  // Build the matching ledger rows for one account (real transaction rows only;
  // the synthetic opening row is never a search result).
  const rowsForAccount = useCallback(
    (account: Account): LedgerRow[] => {
      const rows = buildLedger(account, data.transactions, splitsByTx);
      return rows.filter(
        (r) => r.kind === "transaction" && r.transaction && matchingIds.has(r.transaction.id)
      );
    },
    [data.transactions, splitsByTx, matchingIds]
  );

  // Account-scoped edit handlers (mirror the main ledger, minus opening-row edits
  // which don't occur here). Each reloads the search data afterward.
  const editFor = useCallback(
    (account: Account) =>
      async (
        id: string,
        field: "date" | "payee" | "memo" | "amountCents" | "categoryId",
        value: unknown
      ) => {
        try {
          if (field === "amountCents") {
            await window.ledger.updateTransaction({ id, amountCents: Math.abs(Number(value)) });
          } else if (field === "categoryId") {
            await window.ledger.updateTransaction({ id, categoryId: (value as string) ?? null });
          } else {
            await window.ledger.updateTransaction({ id, [field]: value } as never);
          }
          onReload();
        } catch (e) {
          onToast(e instanceof Error ? e.message : "Edit failed.");
        }
        void account;
      },
    [onReload, onToast]
  );

  const setCategoryFor = useCallback(
    (account: Account) => async (id: string, choice: CategoryChoice) => {
      if (choice.kind === "split") {
        // Delegate to the app's split editor (which handles the loan auto-split),
        // scoped to this result's owning account. Look up the row for its
        // owning-signed total and current split state.
        const row = rowsForAccount(account).find((r) => r.transaction?.id === id);
        const tx = row?.transaction ?? data.transactions.find((t) => t.id === id) ?? null;
        if (!tx) return;
        onEditSplit(
          tx,
          account,
          !!row?.isSplit,
          row?.splits,
          row?.signedAmountCents ?? 0
        );
        return;
      }
      const tx = data.transactions.find((t) => t.id === id);
      if (!tx) return;
      const accountIsFrom = tx.fromAccountId === account.id;
      try {
        if (choice.kind === "transfer") {
          const target = data.accounts.find((a) => a.id === choice.accountId);
          const row = rowsForAccount(account).find((r) => r.transaction?.id === id);
          // Fire the loan auto-split for any NON-SPLIT outflow changed to a loan
          // transfer (uncategorized or categorized); only existing splits are exempt.
          const notSplit = !row?.isSplit;
          const outflow = accountIsFrom || (row?.signedAmountCents ?? 0) < 0;
          const autoLoanSplit = target?.type === "loan" && notSplit && outflow;

          await window.ledger.updateTransaction({
            id,
            categoryId: null,
            fromAccountId: accountIsFrom ? account.id : choice.accountId,
            toAccountId: accountIsFrom ? choice.accountId : account.id,
            splits: [],
          });
          onReload();

          if (autoLoanSplit) {
            // The transaction is now a transfer to the loan; open the split editor
            // with the auto principal/interest split. Refetch its signed total.
            const updated = (await window.ledger.getLedger(account.id)).find(
              (r) => r.transaction?.id === id
            );
            if (updated?.transaction) {
              onEditSplit(updated.transaction, account, false, undefined, updated.signedAmountCents);
            }
          }
          return;
        }
        await window.ledger.updateTransaction({
          id,
          categoryId: choice.kind === "category" ? choice.categoryId : null,
          fromAccountId: accountIsFrom ? account.id : null,
          toAccountId: accountIsFrom ? null : account.id,
          splits: [],
        });
        onReload();
      } catch (e) {
        onToast(e instanceof Error ? e.message : "Change failed.");
      }
    },
    [data.transactions, data.accounts, onReload, onToast, rowsForAccount, onEditSplit]
  );

  const deleteFor = useCallback(
    () => async (id: string) => {
      await window.ledger.deleteTransaction(id);
      onReload();
    },
    [onReload]
  );

  // Context menu (right-click) state for the search grids.
  const [menu, setMenu] = useState<{ x: number; y: number; items: ContextMenuItem[] } | null>(
    null
  );

  // Bulk-apply a category/uncategorized/transfer to the given rows in an account.
  const bulkSetCategory = useCallback(
    async (account: Account, ids: string[], choice: CategoryChoice) => {
      if (choice.kind === "split") return;
      try {
        const updates = ids.flatMap((id) => {
          const t = data.transactions.find((tx) => tx.id === id);
          if (!t) return [];
          const accountIsFrom = t.fromAccountId === account.id;
          if (choice.kind === "transfer") {
            return [
              {
                id,
                categoryId: null,
                fromAccountId: accountIsFrom ? account.id : choice.accountId,
                toAccountId: accountIsFrom ? choice.accountId : account.id,
                splits: [],
              },
            ];
          }
          return [
            {
              id,
              categoryId: choice.kind === "category" ? choice.categoryId : null,
              fromAccountId: accountIsFrom ? account.id : null,
              toAccountId: accountIsFrom ? null : account.id,
              splits: [],
            },
          ];
        });
        await window.ledger.bulkUpdateTransactions(updates);
        onReload();
        onToast(`Updated ${ids.length} transaction(s).`);
      } catch (e) {
        onToast(e instanceof Error ? e.message : "Bulk category change failed.");
      }
    },
    [data.transactions, onReload, onToast]
  );

  const bulkDelete = useCallback(
    async (ids: string[]) => {
      await window.ledger.bulkDeleteTransactions(ids);
      onReload();
      onToast(`Deleted ${ids.length} transaction(s).`);
    },
    [onReload, onToast]
  );

  // Build the Bulk Category submenu (Uncategorized, disabled Split, categories,
  // transfer accounts) for an account + selected ids.
  const bulkCategorySubmenu = useCallback(
    (account: Account, ids: string[]): ContextMenuItem[] => {
      const cats: ContextMenuItem[] = categoryOptions(data.categories as Category[]).map((o) => ({
        label: o.display,
        onClick: () =>
          void bulkSetCategory(account, ids, {
            kind: "category",
            categoryId: o.category.id,
            label: o.display,
          }),
      }));
      const accts: ContextMenuItem[] = data.accounts
        .filter((a) => a.id !== account.id)
        .map((a) => ({
          label: `→ ${a.name}`,
          onClick: () =>
            void bulkSetCategory(account, ids, { kind: "transfer", accountId: a.id, label: a.name }),
        }));
      return [
        {
          label: "— Uncategorized —",
          onClick: () => void bulkSetCategory(account, ids, { kind: "none" }),
        },
        { label: "Split… (not available in bulk)", disabled: true },
        ...cats,
        ...accts,
      ];
    },
    [data.categories, data.accounts, bulkSetCategory]
  );

  // Right-click handler for a grid: Copy, Bulk Category, Bulk Delete.
  const cellContextFor = useCallback(
    (account: Account) =>
      (info: {
        x: number;
        y: number;
        headerName: string;
        displayValue: string;
        isOpening: boolean;
        selectedTransactionIds: string[];
      }) => {
        const items: ContextMenuItem[] = [];
        if (info.displayValue) {
          items.push({
            label: `Copy ${info.headerName || "field"}`,
            onClick: () => void navigator.clipboard.writeText(info.displayValue),
          });
        }
        const ids = info.selectedTransactionIds;
        if (ids.length > 1) {
          items.push({
            label: `Bulk Category (${ids.length})`,
            submenu: bulkCategorySubmenu(account, ids),
          });
          items.push({ label: `Bulk Delete (${ids.length})`, onClick: () => void bulkDelete(ids) });
        }
        if (items.length === 0) return;
        setMenu({ x: info.x, y: info.y, items });
      },
    [bulkCategorySubmenu, bulkDelete]
  );

  const total = groupAccountIds.reduce(
    (n, aid) => n + rowsForAccount(accountById.get(aid)!).length,
    0
  );

  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <div
        className="dialog search-results"
        style={{ width: "min(1100px, 94vw)", minHeight: "50vh", maxHeight: "90vh" }}
        onClick={(e) => e.stopPropagation()}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <h3 style={{ margin: 0 }}>Search Results</h3>
          <span className="account-type">{total} match{total === 1 ? "" : "es"}</span>
          <span style={{ flex: 1 }} />
          <button className="secondary" onClick={onClose}>
            Close
          </button>
        </div>

        {total === 0 ? (
          <div className="empty">No transactions match your search.</div>
        ) : (
          <div style={{ overflow: "auto", display: "flex", flexDirection: "column", gap: 16 }}>
            {groupAccountIds.map((aid) => {
              const account = accountById.get(aid)!;
              const rows = rowsForAccount(account);
              if (rows.length === 0) return null;
              return (
                <div key={aid}>
                  <div className="account-type" style={{ marginBottom: 4 }}>
                    {account.name} · {rows.length} match{rows.length === 1 ? "" : "es"}
                  </div>
                  <div
                    className="search-grid-box"
                    style={{ height: Math.min(360, 84 + rows.length * 34) }}
                  >
                    <LedgerGrid
                      account={account}
                      rows={rows}
                      categories={data.categories as Category[]}
                      accounts={data.accounts}
                      dark={dark}
                      onEdit={editFor(account)}
                      onEditOpening={() => {}}
                      onSetCategoryOrTransfer={setCategoryFor(account)}
                      onDelete={deleteFor()}
                      onCellContext={cellContextFor(account)}
                    />
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
      {menu && (
        <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />
      )}
    </div>
  );
}
