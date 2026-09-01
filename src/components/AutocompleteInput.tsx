import { useMemo, useRef, useState } from "react";

interface Props {
  value: string;
  onChange: (value: string) => void;
  /** Candidate completions (e.g. prior payees/memos for the account). */
  suggestions: string[];
  /** Minimum characters typed before suggestions appear. Default 3. */
  minChars?: number;
  /** Max suggestions shown. Default 8. */
  maxSuggestions?: number;
  placeholder?: string;
  autoFocus?: boolean;
  disabled?: boolean;
  title?: string;
}

/**
 * A text input with a completion popup sourced from `suggestions`. Suggestions
 * appear once at least `minChars` have been typed and are filtered (case-
 * insensitive substring) as the user types. Up/Down move the highlighted item,
 * Enter accepts it, Escape dismisses. Clicking a suggestion accepts it.
 */
export function AutocompleteInput({
  value,
  onChange,
  suggestions,
  minChars = 3,
  maxSuggestions = 8,
  placeholder,
  autoFocus,
  disabled,
  title,
}: Props) {
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  // Suppress reopening the popup immediately after accepting a suggestion.
  const justAcceptedRef = useRef(false);

  const matches = useMemo(() => {
    const q = value.trim().toLowerCase();
    if (q.length < minChars) return [];
    const seen = new Set<string>();
    const out: string[] = [];
    for (const s of suggestions) {
      if (s == null) continue;
      const lower = s.toLowerCase();
      // Skip exact match (nothing to complete) and de-dupe case-insensitively.
      if (lower === q || seen.has(lower)) continue;
      if (lower.includes(q)) {
        seen.add(lower);
        out.push(s);
        if (out.length >= maxSuggestions) break;
      }
    }
    return out;
  }, [value, suggestions, minChars, maxSuggestions]);

  const showPopup = open && !disabled && matches.length > 0;

  function accept(text: string) {
    justAcceptedRef.current = true;
    onChange(text);
    setOpen(false);
    setActiveIndex(0);
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (!showPopup) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIndex((i) => (i + 1) % matches.length);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIndex((i) => (i - 1 + matches.length) % matches.length);
    } else if (e.key === "Enter") {
      // Accept the highlighted suggestion (don't submit the form yet).
      e.preventDefault();
      accept(matches[activeIndex] ?? matches[0]);
    } else if (e.key === "Escape") {
      e.preventDefault();
      setOpen(false);
    }
  }

  return (
    <div className="autocomplete">
      <input
        value={value}
        placeholder={placeholder}
        autoFocus={autoFocus}
        disabled={disabled}
        title={title}
        autoComplete="off"
        onChange={(e) => {
          onChange(e.target.value);
          if (justAcceptedRef.current) {
            justAcceptedRef.current = false;
          } else {
            setOpen(true);
          }
          setActiveIndex(0);
        }}
        onKeyDown={onKeyDown}
        onFocus={() => setOpen(true)}
        // Delay closing so a click on a suggestion registers before blur hides it.
        onBlur={() => window.setTimeout(() => setOpen(false), 120)}
      />
      {showPopup && (
        <ul className="autocomplete-list" role="listbox">
          {matches.map((s, i) => (
            <li
              key={s}
              role="option"
              aria-selected={i === activeIndex}
              className={"autocomplete-item" + (i === activeIndex ? " active" : "")}
              // onMouseDown (not onClick) so it fires before the input's blur.
              onMouseDown={(e) => {
                e.preventDefault();
                accept(s);
              }}
              onMouseEnter={() => setActiveIndex(i)}
            >
              {s}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
