import { useCallback, useEffect, useMemo, useRef } from "react";
import { AgGridReact } from "ag-grid-react";
import {
  AllCommunityModule,
  ModuleRegistry,
  type CellContextMenuEvent,
  type CellDoubleClickedEvent,
  type CellValueChangedEvent,
  type ColDef,
  type ColumnResizedEvent,
  type GridReadyEvent,
  type ValueFormatterParams,
  type ValueParserParams,
} from "ag-grid-community";
import type { Account, Category, LedgerRow } from "../shared/types";
import { displaySign, formatCents, parseCents } from "../core/money";
import { categoryDisplayName } from "../core/categories";
import { CategoryAccountEditor, type CategoryChoice } from "./CategoryAccountEditor";
import { TrashIcon } from "./TrashIcon";
import { AutocompleteCellEditor } from "./AutocompleteCellEditor";

// Register all community modules. v33 is tree-shakeable, so this pulls in the
// client-side row model, cell editors (text/date/select), and cell styling that
// the column definitions below rely on. Registering only the row-model module
// caused AG Grid error #200 for the editor/style features.
ModuleRegistry.registerModules([AllCommunityModule]);

interface Props {
  account: Account;
  rows: LedgerRow[];
  categories: Category[];
  accounts: Account[];
  dark: boolean;
  onEdit: (
    id: string,
    field: "date" | "payee" | "memo" | "amountCents" | "categoryId",
    value: unknown
  ) => void;
  // Edits to the synthetic opening-balance row update the account, not a transaction.
  onEditOpening: (field: "date" | "openingBalanceCents", value: unknown) => void;
  // The Category column can set a category, clear it, or turn the row into a
  // transfer by choosing another account. Handled distinctly from plain edits.
  onSetCategoryOrTransfer: (id: string, choice: CategoryChoice) => void;
  onDelete: (id: string) => void;
  // Right-click on a cell: report position, the column's header + displayed value,
  // and the row id so the container can show Copy / Add-to-Recurring actions.
  onCellContext?: (info: {
    x: number;
    y: number;
    field: string;
    headerName: string;
    displayValue: string;
    transactionId: string;
    isOpening: boolean;
    /** Ids of all currently selected transaction rows (excludes the opening row). */
    selectedTransactionIds: string[];
  }) => void;
  // Persisted ledger column widths (colId -> px) and a callback to save changes.
  columnWidths?: Record<string, number>;
  onColumnWidthsChange?: (widths: Record<string, number>) => void;
  /** Prior payees in this account, for inline Payee autocomplete. */
  payeeSuggestions?: string[];
  /** Prior memos in this account, for inline Memo autocomplete. */
  memoSuggestions?: string[];
}

// Flat row shape fed to AG Grid.
interface GridRow {
  id: string;
  date: string;
  payee: string;
  memo: string;
  categoryName: string; // display value for the category dropdown
  signedAmountCents: number;
  runningBalanceCents: number;
  isTransfer: boolean;
  isOpening: boolean;
  isSplit: boolean;
  // True when this is a split the current account does NOT own (it appears here
  // only as a transfer-leg counterparty — the "TO side"). Such rows are view-only.
  isForeignSplit: boolean;
  splitTooltip: string;
  /** True when this row is an investment trade leg (memo is derived, read-only). */
  isTrade: boolean;
}

const NO_CATEGORY = "—";

// Sentinel id for the synthetic, read-only opening-balance row pinned to the top.
const OPENING_ROW_ID = "__opening__";

// Editable guard: true for real transaction rows (i.e. not the opening row).
function isTxRow(p: { data?: { isOpening?: boolean } }): boolean {
  return !p.data?.isOpening;
}

export function LedgerGrid({
  account,
  rows,
  categories,
  accounts,
  dark,
  onEdit,
  onEditOpening,
  onSetCategoryOrTransfer,
  onDelete,
  onCellContext,
  columnWidths,
  onColumnWidthsChange,
  payeeSuggestions,
  memoSuggestions,
}: Props) {
  // Keep the latest callbacks/data in refs so `columnDefs` can be built once and
  // stay referentially stable. If columnDefs changed identity on every edit (e.g.
  // because onSetCategoryOrTransfer depends on the ledger), AG Grid would re-apply
  // the definitions and reset user column widths (flex columns snap back).
  const onDeleteRef = useRef(onDelete);
  const onSetChoiceRef = useRef(onSetCategoryOrTransfer);
  const onCellContextRef = useRef(onCellContext);
  const categoriesRef = useRef(categories);
  const otherAccountsRef = useRef<Account[]>([]);
  // Suggestion lists kept in refs so the (stable) columnDefs read current values.
  const payeeSuggestionsRef = useRef<string[]>([]);
  const memoSuggestionsRef = useRef<string[]>([]);
  payeeSuggestionsRef.current = payeeSuggestions ?? [];
  memoSuggestionsRef.current = memoSuggestions ?? [];
  onDeleteRef.current = onDelete;
  onSetChoiceRef.current = onSetCategoryOrTransfer;
  onCellContextRef.current = onCellContext;
  categoriesRef.current = categories;
  // For liability accounts (credit card / loan) we flip the sign of displayed
  // amounts and balances so the ledger reads like a statement (charges positive,
  // payments negative). Stored data is unaffected; only display values change,
  // and edits persist the magnitude regardless of shown sign.
  const sign = displaySign(account.type);
  const accountNameById = useMemo(() => {
    const m = new Map<string, string>();
    accounts.forEach((a) => m.set(a.id, a.name));
    return m;
  }, [accounts]);

  // Accounts other than the one being viewed (candidate transfer counterparties).
  const otherAccounts = useMemo(
    () => accounts.filter((a) => a.id !== account.id),
    [accounts, account.id]
  );
  otherAccountsRef.current = otherAccounts;

  // Lookup of ledger rows by transaction id, so the category editor can open with
  // the row's current selection preselected. Kept in a ref because
  // cellEditorParams is a stable function that reads current data at edit time.
  const rowByIdRef = useRef<Map<string, LedgerRow>>(new Map());
  rowByIdRef.current = useMemo(() => {
    const m = new Map<string, LedgerRow>();
    for (const r of rows) if (r.transaction) m.set(r.transaction.id, r);
    return m;
  }, [rows]);

  // Encode a ledger row's current category/transfer selection for the editor:
  //   split -> "split"; transfer -> "acct:<other>"; category -> "cat:<id>"; else "none".
  const initialEditorValue = useCallback(
    (rowId: string): string => {
      const r = rowByIdRef.current.get(rowId);
      const t = r?.transaction;
      if (!t) return "none";
      if (r?.isSplit) return "split";
      const isTransfer = !!(t.fromAccountId && t.toAccountId);
      if (isTransfer) {
        const otherId = t.fromAccountId === account.id ? t.toAccountId : t.fromAccountId;
        return otherId ? `acct:${otherId}` : "none";
      }
      return t.categoryId ? `cat:${t.categoryId}` : "none";
    },
    [account.id]
  );

  // Build the display payee for a row. Transfers ignore any stored payee and show
  // the counterparty account with direction relative to the account being viewed:
  //   money leaving this account  -> "To <other account>"
  //   money entering this account -> "From <other account>"
  const payeeFor = useCallback(
    (r: LedgerRow): string => {
      const t = r.transaction!;
      const isTransfer = !!(t.fromAccountId && t.toAccountId);
      if (isTransfer) {
        if (t.fromAccountId === account.id) {
          const other = t.toAccountId ? accountNameById.get(t.toAccountId) : undefined;
          return `To ${other ?? "account"}`;
        }
        const other = t.fromAccountId ? accountNameById.get(t.fromAccountId) : undefined;
        return `From ${other ?? "account"}`;
      }
      // TO side of a split: the current account is a transfer-leg counterparty
      // (not the transaction's owner). Like a plain transfer, show the owning
      // account the money came FROM instead of the stored payee.
      const isForeignSplit =
        r.isSplit && t.fromAccountId !== account.id && t.toAccountId !== account.id;
      if (isForeignSplit) {
        const ownerId = t.fromAccountId ?? t.toAccountId ?? null;
        const other = ownerId ? accountNameById.get(ownerId) : undefined;
        return `From ${other ?? "account"}`;
      }
      return t.payee ?? "";
    },
    [account.id, accountNameById]
  );

  // Memo display: for a split, derive from the legs' memos (the transaction-level
  // memo isn't meaningful for splits). For an investment trade, show the security
  // (ticker/name) plus shares and price per share. Otherwise use the tx memo.
  const memoFor = useCallback((r: LedgerRow): string => {
    if (r.isSplit && r.splits && r.splits.length > 0) {
      const legMemos = r.splits.map((s) => (s.memo ?? "").trim()).filter((m) => m.length > 0);
      return legMemos.join(", ");
    }
    if (r.trade) {
      const t = r.trade;
      const security = t.symbol ? `${t.symbol} ${t.assetName}` : t.assetName;
      // Sells store negative shares; display the magnitude (direction is shown by
      // the "Sell" payee and the negative Amount). Cash dividends have no shares.
      const shareCount = Math.abs(t.units);
      if (shareCount > 0 && t.pricePerUnitCents > 0) {
        const shares = Number(shareCount.toFixed(6)).toString();
        const price = formatCents(t.pricePerUnitCents, account.currency);
        return `${security} — ${shares} sh @ ${price}`;
      }
      return security;
    }
    return r.transaction?.memo ?? "";
  }, [account.currency]);
  const nameById = useMemo(() => {
    const m = new Map<string, string>();
    categories.forEach((c) => m.set(c.id, categoryDisplayName(c, categories)));
    return m;
  }, [categories]);

  // Category-column display value:
  //   split       -> "Split"
  //   transfer    -> the OTHER account
  //   otherwise   -> the income/expense category
  const categoryFor = useCallback(
    (r: LedgerRow): string => {
      if (r.isSplit) return "Split";
      const t = r.transaction!;
      const isTransfer = !!(t.fromAccountId && t.toAccountId);
      if (isTransfer) {
        const otherId = t.fromAccountId === account.id ? t.toAccountId : t.fromAccountId;
        return (otherId && accountNameById.get(otherId)) || "";
      }
      return t.categoryId ? nameById.get(t.categoryId) ?? NO_CATEGORY : NO_CATEGORY;
    },
    [account.id, accountNameById, nameById]
  );

  // Tooltip text listing a split's legs, one per line, e.g.
  //   "Interest $80.00\n→ Loan $420.00".
  const splitTooltipFor = useCallback(
    (r: LedgerRow): string => {
      if (!r.isSplit || !r.splits) return "";
      return r.splits
        .map((s) => {
          const label = s.categoryId
            ? nameById.get(s.categoryId) ?? "Category"
            : `→ ${(s.transferAccountId && accountNameById.get(s.transferAccountId)) || "account"}`;
          return `${label} ${formatCents(Math.abs(s.amountCents), account.currency)}`;
        })
        .join("\n");
    },
    [nameById, accountNameById, account.currency]
  );

  const rowData: GridRow[] = useMemo(
    () =>
      rows.map((r) => {
        if (r.kind === "opening") {
          return {
            id: OPENING_ROW_ID,
            date: account.openingBalanceDate ?? account.createdAt.slice(0, 10),
            payee: "Opening balance",
            memo: "",
            categoryName: "",
          signedAmountCents: r.signedAmountCents * sign,
          runningBalanceCents: r.runningBalanceCents * sign,
            isTransfer: false,
            isOpening: true,
            isSplit: false,
            isForeignSplit: false,
            splitTooltip: "",
            isTrade: false,
          };
        }
        const t = r.transaction!;
        return {
          id: t.id,
          date: t.date,
          payee: payeeFor(r),
          memo: memoFor(r),
          categoryName: categoryFor(r),
          signedAmountCents: r.signedAmountCents * sign,
          runningBalanceCents: r.runningBalanceCents * sign,
          isTransfer: !!(t.fromAccountId && t.toAccountId),
          isOpening: false,
          isSplit: !!r.isSplit,
          // A split the current account doesn't own (appears only via a transfer
          // leg) is view-only — its amount/fields must be edited from the owner.
          isForeignSplit:
            !!r.isSplit && t.fromAccountId !== account.id && t.toAccountId !== account.id,
          splitTooltip: splitTooltipFor(r),
          isTrade: !!r.trade,
        };
      }),
    [rows, categoryFor, splitTooltipFor, sign, payeeFor, memoFor, account.openingBalanceDate, account.createdAt]
  );

  const money = useCallback(
    (p: ValueFormatterParams) =>
      p.value == null ? "" : formatCents(p.value as number, account.currency),
    [account.currency]
  );

  const columnDefs = useMemo<ColDef<GridRow>[]>(
    () => [
      // Date is editable for transactions and for the opening row (both sortable).
      { field: "date", headerName: "Date", editable: true, width: 120, sort: "asc" },
      {
        field: "payee",
        headerName: "Payee",
        // Payee is auto-generated for transfers ("From/To <account>"), derived for
        // splits, and set to the action (Buy/Sell/…) for trades, so it's editable
        // only for ordinary transactions.
        editable: (p) =>
          isTxRow(p) && !p.data?.isTransfer && !p.data?.isSplit && !p.data?.isTrade,
        cellEditor: AutocompleteCellEditor,
        cellEditorParams: () => ({ suggestions: payeeSuggestionsRef.current }),
        flex: 1,
        minWidth: 130,
      },
      {
        field: "memo",
        headerName: "Memo",
        // A split's memo is derived from its legs, and a trade's memo shows the
        // security/shares/price, so both are read-only.
        editable: (p) => isTxRow(p) && !p.data?.isSplit && !p.data?.isTrade,
        cellEditor: AutocompleteCellEditor,
        cellEditorParams: () => ({ suggestions: memoSuggestionsRef.current }),
        flex: 1,
        minWidth: 130,
      },
      {
        field: "categoryName",
        headerName: "Category",
        // Not editable for a split viewed on its TO side; double-clicking instead
        // opens the read-only split viewer (see onCellDoubleClicked).
        editable: (p) => isTxRow(p) && !p.data?.isForeignSplit,
        width: 150,
        // Hovering a split row's Category cell lists the legs.
        tooltipValueGetter: (p) => (p.data?.isSplit ? p.data.splitTooltip : undefined),
        // Custom editor: categories on top, a divider, then accounts (transfers).
        cellEditor: CategoryAccountEditor,
        // Function form so we can capture the row id and commit the choice directly
        // (AG Grid's value plumbing can't round-trip our object choice reliably).
        cellEditorParams: (p: { data: GridRow }) => ({
          categories: categoriesRef.current,
          accounts: otherAccountsRef.current,
          // Preselect the row's current category/transfer/split in the list.
          initialValue: initialEditorValue(p.data.id),
          // Which categories are offered is driven by the NORMALIZED (stored)
          // sign, not the display sign: a stored positive => income/both, a
          // stored negative => expense/both. For liability accounts the display
          // sign is flipped, so we read the raw row value (via rowByIdRef) rather
          // than p.data.signedAmountCents (which is display-signed).
          direction: ((rowByIdRef.current.get(p.data.id)?.signedAmountCents ?? 0) >= 0
            ? "income"
            : "expense") as "income" | "expense",
          onChoose: (choice: CategoryChoice) => onSetChoiceRef.current(p.data.id, choice),
        }),
        cellEditorPopup: true,
      },
      {
        field: "signedAmountCents",
        headerName: "Amount",
        // Editable for transactions and the opening-balance row, but NOT for a
        // split viewed on its TO side (counterparty) — edit it from the owner.
        editable: (p: { data?: GridRow }) => !p.data?.isForeignSplit,
        width: 130,
        type: "rightAligned",
        valueFormatter: money,
        // Show the formatted dollars.cents value in the editor instead of the raw
        // integer cents; valueParser converts the typed string back to cents.
        cellEditor: "agTextCellEditor",
        cellEditorParams: { useFormatter: true },
        valueParser: (p: ValueParserParams) => {
          const cents = parseCents(String(p.newValue));
          return cents == null ? p.oldValue : cents;
        },
        cellClassRules: { neg: (p) => (p.value as number) < 0 },
      },
      {
        field: "runningBalanceCents",
        headerName: "Balance",
        editable: false,
        width: 140,
        type: "rightAligned",
        valueFormatter: money,
        cellClassRules: { neg: (p) => (p.value as number) < 0 },
      },
      {
        headerName: "",
        width: 90,
        // Must return a React node (not a raw DOM element): returning an
        // HTMLElement here triggered React error #31 and blanked the window.
        cellRenderer: (p: { data: GridRow }) =>
          // No Delete action on the synthetic opening-balance row.
          p.data.isOpening ? null : (
            <button
              className="secondary icon-btn"
              title="Delete transaction"
              aria-label="Delete transaction"
              onClick={() => onDeleteRef.current(p.data.id)}
            >
              <TrashIcon />
            </button>
          ),
      },
    ],
    // Built once (stable): volatile callbacks/data are read via refs so edits
    // don't recreate the column definitions and reset user column widths.
    [money]
  );

  const onCellValueChanged = useCallback(
    (e: CellValueChangedEvent<GridRow>) => {
      const field = e.colDef.field as keyof GridRow;
      const id = e.data.id;
      // Opening-balance row edits update the account, not a transaction.
      if (e.data.isOpening) {
        if (field === "signedAmountCents") {
          // Convert the displayed (sign-flipped) amount back to the stored value.
          onEditOpening("openingBalanceCents", Number(e.newValue) * sign);
        } else if (field === "date") {
          onEditOpening("date", e.newValue);
        }
        return;
      }
      if (field === "signedAmountCents") {
        onEdit(id, "amountCents", e.newValue);
      } else if (field === "date" || field === "payee" || field === "memo") {
        onEdit(id, field, e.newValue);
      }
    },
    [onEdit, onEditOpening, sign]
  );

  // AG Grid API + saved-width application. Applying explicit widths overrides the
  // flex sizing, which is also what stops columns snapping back after an edit.
  const gridApiRef = useRef<GridReadyEvent["api"] | null>(null);

  const applySavedWidths = useCallback(() => {
    const api = gridApiRef.current;
    if (!api || !columnWidths) return;
    const state = Object.entries(columnWidths).map(([colId, width]) => ({
      colId,
      width,
      flex: null, // clear flex so the explicit width sticks
    }));
    if (state.length > 0) {
      api.applyColumnState({ state });
    }
  }, [columnWidths]);

  const onGridReady = useCallback(
    (e: GridReadyEvent) => {
      gridApiRef.current = e.api;
      applySavedWidths();
    },
    [applySavedWidths]
  );

  // Saved widths may arrive after the grid is ready (settings load asynchronously),
  // so re-apply whenever they change and the grid exists.
  useEffect(() => {
    applySavedWidths();
  }, [applySavedWidths]);

  const onColumnResized = useCallback(
    (e: ColumnResizedEvent) => {
      // Only persist when the user finished a manual drag (avoids autosize/flex noise).
      if (!e.finished || e.source !== "uiColumnResized") return;
      const api = gridApiRef.current;
      if (!api || !onColumnWidthsChange) return;
      const widths: Record<string, number> = {};
      for (const c of api.getColumnState()) {
        if (c.colId && typeof c.width === "number") widths[c.colId] = c.width;
      }
      onColumnWidthsChange(widths);
    },
    [onColumnWidthsChange]
  );

  // Right-click on a cell: translate the AG Grid event into a container callback.
  // The "value" fields are formatted for money columns so Copy yields what the
  // user sees ("$1,200.00") rather than raw integer cents.
  const onCellContextMenu = useCallback(
    (e: CellContextMenuEvent<GridRow>) => {
      const cb = onCellContextRef.current;
      const me = e.event as MouseEvent | undefined;
      if (!cb || !me || !e.data) return;
      me.preventDefault();
      const field = (e.colDef.field as string) ?? "";
      const isMoney = field === "signedAmountCents" || field === "runningBalanceCents";
      const displayValue = isMoney
        ? formatCents(Number(e.value ?? 0), account.currency)
        : String(e.value ?? "");
      // Ids of the currently selected transaction rows (exclude the opening row).
      const selectedTransactionIds: string[] = [];
      gridApiRef.current?.getSelectedNodes().forEach((n) => {
        const d = n.data as GridRow | undefined;
        if (d && !d.isOpening) selectedTransactionIds.push(d.id);
      });
      cb({
        x: me.clientX,
        y: me.clientY,
        field,
        headerName: (e.colDef.headerName as string) || field,
        displayValue,
        transactionId: e.data.id,
        isOpening: !!e.data.isOpening,
        selectedTransactionIds,
      });
    },
    [account.currency]
  );

  // Double-clicking the Category of a TO-side (foreign) split can't edit it (the
  // cell is non-editable); open the read-only split viewer instead.
  const onCellDoubleClicked = useCallback((e: CellDoubleClickedEvent<GridRow>) => {
    if (!e.data) return;
    if (e.colDef.field === "categoryName" && e.data.isForeignSplit) {
      onSetChoiceRef.current(e.data.id, { kind: "split" });
    }
  }, []);

  return (
    <div className={"grid-wrap " + (dark ? "ag-theme-alpine-dark" : "ag-theme-alpine")}>
      <AgGridReact<GridRow>
        theme="legacy"
        rowData={rowData}
        columnDefs={columnDefs}
        onCellValueChanged={onCellValueChanged}
        onCellContextMenu={onCellContextMenu}
        onCellDoubleClicked={onCellDoubleClicked}
        preventDefaultOnContextMenu
        onGridReady={onGridReady}
        onColumnResized={onColumnResized}
        getRowId={(p) => p.data.id}
        rowSelection="multiple"
        isRowSelectable={(node) => !node.data?.isOpening}
        suppressRowClickSelection={false}
        enableBrowserTooltips
        stopEditingWhenCellsLoseFocus
      />
    </div>
  );
}
