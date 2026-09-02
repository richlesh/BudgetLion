import {
  forwardRef,
  useEffect,
  useMemo,
  useRef,
  useState,
  useImperativeHandle,
} from "react";
import type { Account, Category } from "../shared/types";
import { categoriesForDirection, categoryDisplayName } from "../core/categories";

/**
 * The committed value of the Category/Account editor, encoding the user's choice:
 *  - none:     uncategorized single-entry
 *  - category: an income/expense category
 *  - transfer: the counterparty account of a transfer
 *  - split:    open the split editor
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
  // "split", so the list opens with the existing value preselected.
  initialValue?: string;
  // Direction of the row from the account's perspective, used to filter which
  // categories are offered (income vs expense). Undefined = show all.
  direction?: "income" | "expense";
  stopEditing: (cancel?: boolean) => void;
  onChoose: (choice: CategoryChoice) => void;
}

/** A flat, filterable option. `group` labels it in the list; `search` is matched. */
interface Opt {
  value: string; // "split" | "none" | "cat:<id>" | "acct:<id>"
  label: string;
  group: "" | "Category" | "Account";
}

/**
 * A filter-as-you-type combobox cell editor. Shows a text box plus a filtered
 * list of options (Split, Uncategorized, categories, and transfer accounts).
 * Typing narrows the list by a case-insensitive substring match on the label
 * (so account names match too, unlike native grouped-<select> type-ahead).
 * Nothing is committed until the user presses Enter or clicks an option.
 */
export const CategoryAccountEditor = forwardRef(function CategoryAccountEditor(
  props: EditorParams,
  ref
) {
  const { categories, accounts, direction, initialValue, stopEditing, onChoose } = props;

  // Build the flat option list: fixed choices, then categories, then accounts.
  const allOptions = useMemo<Opt[]>(() => {
    const cats = (direction ? categoriesForDirection(categories, direction) : categories)
      .map((c) => ({
        value: `cat:${c.id}`,
        label: categoryDisplayName(c, categories),
        group: "Category" as const,
      }))
      .sort((a, b) => a.label.localeCompare(b.label));
    const accts = accounts
      .map((a) => ({ value: `acct:${a.id}`, label: a.name, group: "Account" as const }))
      .sort((a, b) => a.label.localeCompare(b.label));
    return [
      { value: "split", label: "Split…", group: "" as const },
      { value: "none", label: "— Uncategorized —", group: "" as const },
      ...cats,
      ...accts,
    ];
  }, [categories, accounts, direction]);

  const [query, setQuery] = useState("");
  // Highlighted index into the FILTERED list.
  const [active, setActive] = useState(0);
  const committedRef = useRef(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const comboRef = useRef<HTMLDivElement>(null);
  // Upward shift (px) applied when the popup would otherwise bleed off the bottom
  // of the window (e.g. editing one of the last rows in the ledger).
  const [shiftUp, setShiftUp] = useState(0);

  // Filtered options by case-insensitive substring on the label.
  const filtered = useMemo<Opt[]>(() => {
    const q = query.trim().toLowerCase();
    if (!q) return allOptions;
    return allOptions.filter((o) => o.label.toLowerCase().includes(q));
  }, [allOptions, query]);

  // Keep the active index in range as the filter changes; default to the option
  // matching initialValue when the query is empty.
  useEffect(() => {
    if (query.trim() === "" && initialValue) {
      const idx = filtered.findIndex((o) => o.value === initialValue);
      setActive(idx >= 0 ? idx : 0);
    } else {
      setActive(0);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, filtered.length]);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // After mount, check if the popup overflows the viewport bottom and shift it up
  // so it stays fully visible.
  useEffect(() => {
    const el = comboRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const overflow = rect.bottom - window.innerHeight;
    if (overflow > 0) {
      setShiftUp(overflow + 8); // +8 px breathing room
    }
  }, []);

  // Scroll the active option into view as it changes.
  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const el = list.querySelector<HTMLElement>(`[data-idx="${active}"]`);
    el?.scrollIntoView({ block: "nearest" });
  }, [active]);

  const decode = (v: string): CategoryChoice => {
    if (v === "split") return { kind: "split" };
    if (v.startsWith("cat:")) {
      const id = v.slice(4);
      const cat = categories.find((c) => c.id === id);
      return { kind: "category", categoryId: id, label: cat ? categoryDisplayName(cat, categories) : "" };
    }
    if (v.startsWith("acct:")) {
      const id = v.slice(5);
      return { kind: "transfer", accountId: id, label: accounts.find((a) => a.id === id)?.name ?? "" };
    }
    return { kind: "none" };
  };

  const commit = (v: string | undefined) => {
    if (committedRef.current || v == null) return;
    committedRef.current = true;
    onChoose(decode(v));
    stopEditing(true); // commit via onChoose; don't let AG Grid write the cell
  };

  const cancel = () => {
    committedRef.current = true;
    stopEditing(true);
  };

  // Latest filtered list + active index for the capture-phase key handler, which
  // is bound once and would otherwise close over stale state.
  const stateRef = useRef({ filtered, active });
  stateRef.current = { filtered, active };

  // Capture-phase native keydown on the input: runs BEFORE AG Grid's grid-level
  // key handling, so Enter accepts the highlighted option instead of AG Grid
  // stopping the edit first (which would discard the selection). Arrow keys move
  // the highlight; Escape cancels.
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    const handler = (e: KeyboardEvent) => {
      const { filtered: f, active: a } = stateRef.current;
      if (e.key === "Enter") {
        e.preventDefault();
        e.stopPropagation();
        commit(f[a]?.value);
      } else if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        cancel();
      } else if (e.key === "ArrowDown") {
        e.preventDefault();
        e.stopPropagation();
        setActive((i) => Math.min(i + 1, stateRef.current.filtered.length - 1));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        e.stopPropagation();
        setActive((i) => Math.max(i - 1, 0));
      }
    };
    el.addEventListener("keydown", handler, true); // capture phase
    return () => el.removeEventListener("keydown", handler, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useImperativeHandle(ref, () => ({ getValue: () => undefined }));

  return (
    <div
      className="cat-acct-combo"
      ref={comboRef}
      style={shiftUp ? { transform: `translateY(-${shiftUp}px)` } : undefined}
    >
      <input
        ref={inputRef}
        className="cat-acct-input"
        type="text"
        value={query}
        placeholder="Type to filter…"
        autoFocus
        onChange={(e) => setQuery(e.target.value)}
      />
      <ul className="cat-acct-list" ref={listRef}>
        {filtered.length === 0 && <li className="cat-acct-empty">No matches</li>}
        {filtered.map((o, i) => (
          <li
            key={o.value}
            data-idx={i}
            className={
              "cat-acct-option" +
              (i === active ? " active" : "") +
              (o.group === "Account" ? " is-account" : "")
            }
            // Use onMouseDown so the click registers before the input blurs.
            onMouseDown={(e) => {
              e.preventDefault();
              commit(o.value);
            }}
            onMouseEnter={() => setActive(i)}
          >
            {o.group === "Account" ? `→ ${o.label}` : o.label}
            {o.group === "Account" && <span className="cat-acct-tag">account</span>}
          </li>
        ))}
      </ul>
    </div>
  );
});
