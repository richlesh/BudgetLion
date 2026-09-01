import {
  forwardRef,
  useEffect,
  useRef,
  useImperativeHandle,
  useMemo,
  useState,
} from "react";
import type { Account, Category } from "../shared/types";
import { categoriesForDirection, categoryDisplayName } from "../core/categories";

/**
 * The committed value of the Category/Account editor, encoding the user's choice:
 *  - none:     uncategorized single-entry
 *  - category: an income/expense category
 *  - transfer: the counterparty account of a transfer
 */
export type CategoryChoice =
  | { kind: "none" }
  | { kind: "category"; categoryId: string; label: string }
  | { kind: "transfer"; accountId: string; label: string }
  | { kind: "split" };

interface EditorParams {
  categories: Category[];
  accounts: Account[]; // should already exclude the current account
  // The cell's current selection, encoded as "none" | "cat:<id>" | "acct:<id>" |
  // "split", so the list box opens with the existing value selected.
  initialValue?: string;
  // Direction of the row from the account's perspective, used to filter which
  // categories are offered (income vs expense). Undefined = show all.
  direction?: "income" | "expense";
  stopEditing: (cancel?: boolean) => void;
  // Called with the user's choice. The editor performs the mutation via this
  // callback and then cancels the edit, so it does not rely on AG Grid writing
  // an object value back into the string-typed cell.
  onChoose: (choice: CategoryChoice) => void;
}

/**
 * AG Grid React cell editor. Renders a single dropdown with categories at the
 * top, a divider, then the available accounts. Categories set the transaction's
 * income/expense category; accounts turn it into a transfer to/from that account.
 */
export const CategoryAccountEditor = forwardRef(function CategoryAccountEditor(
  props: EditorParams,
  ref
) {
  const { categories, accounts, direction, initialValue, stopEditing, onChoose } = props;

  // Stable option value encoding: "none" | "cat:<id>" | "acct:<id>".
  const [value, setValue] = useState<string>(initialValue ?? "none");
  const selectRef = useRef<HTMLSelectElement>(null);
  // Guard so a choice is committed only once (onClick and onChange can both fire).
  const committedRef = useRef(false);

  // A list-box <select size> doesn't always reflect a React-controlled `value`
  // as the highlighted row on first mount (it can appear to select the first
  // option). Force the DOM selection to the initial value and scroll it into
  // view once mounted.
  useEffect(() => {
    const el = selectRef.current;
    if (!el) return;
    el.value = initialValue ?? "none";
    const selected = el.selectedOptions[0];
    if (selected && typeof selected.scrollIntoView === "function") {
      selected.scrollIntoView({ block: "nearest" });
    }
    // Run once on mount for this editor instance.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Categories filtered by row direction (if known), with Parent:Child labels.
  const catOptions = useMemo(() => {
    const list = direction ? categoriesForDirection(categories, direction) : categories;
    return list
      .map((c) => ({ id: c.id, label: categoryDisplayName(c, categories) }))
      .sort((a, b) => a.label.localeCompare(b.label));
  }, [categories, direction]);

  const decode = (v: string): CategoryChoice => {
    if (v === "split") return { kind: "split" };
    if (v.startsWith("cat:")) {
      const id = v.slice(4);
      const cat = categories.find((c) => c.id === id);
      const label = cat ? categoryDisplayName(cat, categories) : "";
      return { kind: "category", categoryId: id, label };
    }
    if (v.startsWith("acct:")) {
      const id = v.slice(5);
      const label = accounts.find((a) => a.id === id)?.name ?? "";
      return { kind: "transfer", accountId: id, label };
    }
    return { kind: "none" };
  };

  useImperativeHandle(ref, () => ({
    // We commit via onChoose and cancel the edit, so the cell value is unchanged.
    getValue: () => undefined,
  }));

  const commit = (v: string) => {
    if (committedRef.current) return;
    committedRef.current = true;
    setValue(v);
    onChoose(decode(v));
    // Cancel so AG Grid doesn't overwrite the (string) cell value; the grid will
    // refresh from fresh data after the mutation persists.
    stopEditing(true);
  };

  const dividerLabel = useMemo(() => "──────────", []);

  // Show as an open list box (size > 1) so it's tall and easy to use inside the
  // grid cell, instead of the tiny native dropdown. Height tracks the number of
  // rows, capped so it never gets unwieldy.
  const rowCount =
    2 /* Split + Uncategorized */ +
    catOptions.length +
    1 /* divider */ +
    accounts.length;
  const listSize = Math.min(Math.max(rowCount, 6), 16);

  return (
    <select
      className="cat-acct-editor"
      ref={selectRef}
      size={listSize}
      value={value}
      autoFocus
      onChange={(e) => commit(e.target.value)}
      onClick={(e) => {
        // In a list box, clicking an option that is already selected does NOT
        // fire onChange. Commit on click of any enabled option so choices like
        // "Split" work even when they're the current selection.
        const target = e.target as HTMLElement;
        if (target instanceof HTMLOptionElement && !target.disabled) {
          commit(target.value);
        }
      }}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          // Block any later commit and cancel the edit (no category change).
          committedRef.current = true;
          stopEditing(true);
        }
        else if (e.key === "Enter") {
          e.preventDefault();
          commit((e.currentTarget as HTMLSelectElement).value);
        }
      }}
    >
      <option value="split">Split…</option>
      <option value="none">— Uncategorized —</option>
      <optgroup label="Categories">
        {catOptions.map((c) => (
          <option key={c.id} value={`cat:${c.id}`}>
            {c.label}
          </option>
        ))}
      </optgroup>
      <option disabled>{dividerLabel}</option>
      <optgroup label="Transfer to/from account">
        {accounts.map((a) => (
          <option key={a.id} value={`acct:${a.id}`}>
            {a.name}
          </option>
        ))}
      </optgroup>
    </select>
  );
});
