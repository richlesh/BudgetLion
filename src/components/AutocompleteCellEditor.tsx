import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useGridCellEditor, type CustomCellEditorProps } from "ag-grid-react";

/** Extra params supplied via the column's `cellEditorParams`. */
interface ExtraParams {
  suggestions?: string[];
  minChars?: number;
  maxSuggestions?: number;
}

type Props = CustomCellEditorProps<unknown, string> & ExtraParams;

/**
 * AG Grid v33 custom cell editor for text fields with a type-ahead completion
 * popup sourced from `suggestions` (the account's prior payees/memos). Renders as
 * a normal in-cell input; the suggestion list floats in a body-level portal so it
 * isn't clipped or mis-positioned by the grid's transformed cells.
 *
 * Behavior mirrors the Add Transaction dialog: suggestions appear after
 * `minChars`, Up/Down move the highlight, Enter accepts the highlighted
 * suggestion (otherwise commits the cell), Escape closes the popup (otherwise
 * cancels the edit).
 *
 * Keyboard is handled with a CAPTURE-phase native listener on the input so it
 * runs before AG Grid's own grid-level key handling (otherwise AG Grid would
 * commit the typed text on Enter before we could accept the suggestion).
 */
export function AutocompleteCellEditor(props: Props) {
  const {
    initialValue,
    value,
    onValueChange,
    eventKey,
    suggestions = [],
    minChars = 3,
    maxSuggestions = 8,
  } = props;

  const seed =
    eventKey && eventKey.length === 1
      ? eventKey
      : initialValue == null
        ? ""
        : String(initialValue);

  const [text, setText] = useState<string>(() =>
    typeof value === "string" && value.length > 0 ? value : seed
  );
  const [open, setOpen] = useState(true);
  const [activeIndex, setActiveIndex] = useState(0);
  const [rect, setRect] = useState<{ left: number; top: number; width: number } | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const commit = (final: string) => {
    onValueChange(final.trim() === "" ? null : final);
    if (props.stopEditing) props.stopEditing();
    else props.api?.stopEditing();
  };

  const update = (next: string) => {
    setText(next);
    onValueChange(next.trim() === "" ? null : next);
  };

  const matches = useMemo(() => {
    const q = text.trim().toLowerCase();
    if (q.length < minChars) return [];
    const seen = new Set<string>();
    const out: string[] = [];
    for (const s of suggestions) {
      if (s == null) continue;
      const lower = s.toLowerCase();
      if (lower === q || seen.has(lower)) continue;
      if (lower.includes(q)) {
        seen.add(lower);
        out.push(s);
        if (out.length >= maxSuggestions) break;
      }
    }
    return out;
  }, [text, suggestions, minChars, maxSuggestions]);

  const showPopup = open && matches.length > 0;

  // Keep the latest values available to the capture-phase native key handler,
  // which is bound once and would otherwise close over stale state.
  const stateRef = useRef({ showPopup, matches, activeIndex });
  stateRef.current = { showPopup, matches, activeIndex };

  function accept(s: string) {
    setText(s);
    setOpen(false);
    setActiveIndex(0);
    commit(s);
  }

  // Push the seed into the grid once so a commit without further typing keeps it.
  useEffect(() => {
    onValueChange(text.trim() === "" ? null : text);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const measure = () => {
    const el = inputRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setRect({ left: r.left, top: r.bottom, width: r.width });
  };

  useLayoutEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.focus();
    if (!(eventKey && eventKey.length === 1)) el.select();
    measure();
  }, [eventKey]);

  useGridCellEditor({
    focusIn: () => inputRef.current?.focus(),
  });

  // Capture-phase native keydown: runs before AG Grid's grid-level handler so we
  // can navigate/accept suggestions and stop the event from reaching the grid.
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    const handler = (e: KeyboardEvent) => {
      const { showPopup: sp, matches: ms, activeIndex: ai } = stateRef.current;
      if (!sp) return; // popup closed: let AG Grid handle Enter/Escape/Tab
      if (e.key === "ArrowDown") {
        e.preventDefault();
        e.stopPropagation();
        setActiveIndex((i) => (i + 1) % ms.length);
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        e.stopPropagation();
        setActiveIndex((i) => (i - 1 + ms.length) % ms.length);
      } else if (e.key === "Enter") {
        e.preventDefault();
        e.stopPropagation();
        accept(ms[ai] ?? ms[0]);
      } else if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        setOpen(false);
      }
    };
    el.addEventListener("keydown", handler, true); // capture
    return () => el.removeEventListener("keydown", handler, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="autocomplete-cell">
      <input
        ref={inputRef}
        value={text}
        autoComplete="off"
        onChange={(e) => {
          update(e.target.value);
          setOpen(true);
          setActiveIndex(0);
          measure();
        }}
      />
      {showPopup &&
        rect &&
        createPortal(
          <ul
            className="autocomplete-list autocomplete-list-fixed"
            role="listbox"
            style={{ left: rect.left, top: rect.top, width: rect.width }}
          >
            {matches.map((s, i) => (
              <li
                key={s}
                role="option"
                aria-selected={i === activeIndex}
                className={"autocomplete-item" + (i === activeIndex ? " active" : "")}
                onMouseDown={(e) => {
                  e.preventDefault();
                  accept(s);
                }}
                onMouseEnter={() => setActiveIndex(i)}
              >
                {s}
              </li>
            ))}
          </ul>,
          document.body
        )}
    </div>
  );
}
