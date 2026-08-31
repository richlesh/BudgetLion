import {
  forwardRef,
  useImperativeHandle,
  useMemo,
  useState,
} from "react";
import type { Account, Category } from "../shared/types";

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
  const { categories, accounts, stopEditing, onChoose } = props;

  // Stable option value encoding: "none" | "cat:<id>" | "acct:<id>".
  const [value, setValue] = useState<string>("none");

  const decode = (v: string): CategoryChoice => {
    if (v === "split") return { kind: "split" };
    if (v.startsWith("cat:")) {
      const id = v.slice(4);
      const label = categories.find((c) => c.id === id)?.name ?? "";
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

  const onChange = (v: string) => {
    setValue(v);
    onChoose(decode(v));
    // Cancel so AG Grid doesn't overwrite the (string) cell value; the grid will
    // refresh from fresh data after the mutation persists.
    stopEditing(true);
  };

  const dividerLabel = useMemo(() => "──────────", []);

  return (
    <select
      className="cat-acct-editor"
      value={value}
      autoFocus
      onChange={(e) => onChange(e.target.value)}
    >
      <option value="split">Split…</option>
      <option value="none">— Uncategorized —</option>
      <optgroup label="Categories">
        {categories.map((c) => (
          <option key={c.id} value={`cat:${c.id}`}>
            {c.name}
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
