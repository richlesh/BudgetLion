import { useCallback, useEffect, useMemo, useRef } from "react";
import { AgGridReact } from "ag-grid-react";
import {
  AllCommunityModule,
  ModuleRegistry,
  type CellValueChangedEvent,
  type ColDef,
  type ColumnResizedEvent,
  type GridReadyEvent,
  type ValueFormatterParams,
  type ValueParserParams,
} from "ag-grid-community";
import type { Account, Category, LedgerRow, Transaction } from "../shared/types";
import { displaySign, formatCents, parseCents } from "../core/money";
import { CategoryAccountEditor, type CategoryChoice } from "./CategoryAccountEditor";

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
  // Persisted ledger column widths (colId -> px) and a callback to save changes.
  columnWidths?: Record<string, number>;
  onColumnWidthsChange?: (widths: Record<string, number>) => void;
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
  splitTooltip: string;
}

const NO_CATEGORY = "—";

// Sentinel id for the synthetic, read-only opening-balance row pinned to the top.
const OPENING_ROW_ID = "__opening__";

// Inline trash-can icon (no external icon dependency). Inherits color via
// currentColor and sizes to the surrounding font/button.
function TrashIcon() {
  return (
    <svg
      width="15"
      height="15"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M3 6h18" />
      <path d="M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2" />
      <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
      <path d="M10 11v6" />
      <path d="M14 11v6" />
    </svg>
  );
}

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
  columnWidths,
  onColumnWidthsChange,
}: Props) {
  // Keep the latest callbacks/data in refs so `columnDefs` can be built once and
  // stay referentially stable. If columnDefs changed identity on every edit (e.g.
  // because onSetCategoryOrTransfer depends on the ledger), AG Grid would re-apply
  // the definitions and reset user column widths (flex columns snap back).
  const onDeleteRef = useRef(onDelete);
  const onSetChoiceRef = useRef(onSetCategoryOrTransfer);
  const categoriesRef = useRef(categories);
  const otherAccountsRef = useRef<Account[]>([]);
  onDeleteRef.current = onDelete;
  onSetChoiceRef.current = onSetCategoryOrTransfer;
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

  // Build the display payee for a row. Transfers ignore any stored payee and show
  // the counterparty account with direction relative to the account being viewed:
  //   money leaving this account  -> "To <other account>"
  //   money entering this account -> "From <other account>"
  const payeeFor = useCallback(
    (t: Transaction): string => {
      const isTransfer = !!(t.fromAccountId && t.toAccountId);
      if (!isTransfer) return t.payee ?? "";
      if (t.fromAccountId === account.id) {
        const other = t.toAccountId ? accountNameById.get(t.toAccountId) : undefined;
        return `To ${other ?? "account"}`;
      }
      const other = t.fromAccountId ? accountNameById.get(t.fromAccountId) : undefined;
      return `From ${other ?? "account"}`;
    },
    [account.id, accountNameById]
  );
  const nameById = useMemo(() => {
    const m = new Map<string, string>();
    categories.forEach((c) => m.set(c.id, c.name));
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

  // Tooltip text listing a split's legs, e.g. "Interest $80.00, → Loan $420.00".
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
        .join(", ");
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
            splitTooltip: "",
          };
        }
        const t = r.transaction!;
        return {
          id: t.id,
          date: t.date,
          payee: payeeFor(t),
          memo: t.memo ?? "",
          categoryName: categoryFor(r),
          signedAmountCents: r.signedAmountCents * sign,
          runningBalanceCents: r.runningBalanceCents * sign,
          isTransfer: !!(t.fromAccountId && t.toAccountId),
          isOpening: false,
          isSplit: !!r.isSplit,
          splitTooltip: splitTooltipFor(r),
        };
      }),
    [rows, categoryFor, splitTooltipFor, sign, payeeFor, account.openingBalanceDate, account.createdAt]
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
        // Payee is auto-generated for transfers ("From/To <account>") and therefore
        // not editable; it stays editable for ordinary transactions.
        editable: (p) => isTxRow(p) && !p.data?.isTransfer,
        flex: 1,
        minWidth: 130,
      },
      { field: "memo", headerName: "Memo", editable: isTxRow, flex: 1, minWidth: 130 },
      {
        field: "categoryName",
        headerName: "Category",
        editable: isTxRow,
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
          onChoose: (choice: CategoryChoice) => onSetChoiceRef.current(p.data.id, choice),
        }),
        cellEditorPopup: true,
      },
      {
        field: "signedAmountCents",
        headerName: "Amount",
        // Editable for transactions and for the opening-balance row.
        editable: true,
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

  return (
    <div className={"grid-wrap " + (dark ? "ag-theme-alpine-dark" : "ag-theme-alpine")}>
      <AgGridReact<GridRow>
        theme="legacy"
        rowData={rowData}
        columnDefs={columnDefs}
        onCellValueChanged={onCellValueChanged}
        onGridReady={onGridReady}
        onColumnResized={onColumnResized}
        getRowId={(p) => p.data.id}
        enableBrowserTooltips
        stopEditingWhenCellsLoseFocus
      />
    </div>
  );
}
