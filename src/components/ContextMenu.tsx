import { useEffect, useLayoutEffect, useRef, useState } from "react";

export interface ContextMenuItem {
  label: string;
  /** Leaf action. Omitted for items that only open a submenu. */
  onClick?: () => void;
  /** Nested items shown in a side menu on hover. */
  submenu?: ContextMenuItem[];
  /** Greyed out and non-interactive when true. */
  disabled?: boolean;
}

interface Props {
  x: number;
  y: number;
  items: ContextMenuItem[];
  onClose: () => void;
}

/** Keyboard-focus coordination across nested menu levels.
 *
 * Only the deepest open menu should react to key presses (arrows, type-ahead,
 * Enter). Each open menu level pushes a token onto this shared stack while it
 * is the active (open) level; the level whose token is on top of the stack is
 * the one that owns the keyboard. This lets a submenu take over typing from its
 * parent, and hand control back when it closes. */
const focusStack: symbol[] = [];
function pushFocus(tok: symbol) {
  focusStack.push(tok);
}
function popFocus(tok: symbol) {
  const i = focusStack.lastIndexOf(tok);
  if (i >= 0) focusStack.splice(i, 1);
}
function isTopFocus(tok: symbol) {
  return focusStack.length > 0 && focusStack[focusStack.length - 1] === tok;
}

/** Index of the first non-disabled item at/after `start` (wrapping). */
function firstEnabled(items: ContextMenuItem[], start: number, dir: 1 | -1): number {
  const n = items.length;
  if (n === 0) return -1;
  for (let step = 0; step < n; step++) {
    const i = ((start + dir * step) % n + n) % n;
    if (!items[i].disabled) return i;
  }
  return -1;
}

/** A single menu level: renders rows, owns keyboard navigation + type-ahead
 * when it is the deepest (active) open level. `depth` distinguishes the root
 * (0) from submenus for focus bookkeeping. */
function MenuList({
  items,
  onClose,
  onCloseLevel,
  active,
  className,
}: {
  items: ContextMenuItem[];
  /** Close the whole context menu (leaf activation, Escape). */
  onClose: () => void;
  /** Close just this menu level (ArrowLeft out of a submenu). Defaults to
   * onClose for the root level, which has no parent to return to. */
  onCloseLevel?: () => void;
  /** Whether this level is currently open/visible (eligible for keyboard). */
  active: boolean;
  className: string;
}) {
  const tokRef = useRef<symbol>(Symbol("menu-level"));
  const [highlight, setHighlight] = useState<number>(-1);
  // The index of the submenu currently open from this level (keyboard-driven),
  // or null when none. Hover also opens submenus (see MenuRow) independently.
  const [openSubIndex, setOpenSubIndex] = useState<number | null>(null);
  const typeBufRef = useRef<{ text: string; at: number }>({ text: "", at: 0 });
  const rowRefs = useRef<Array<HTMLDivElement | null>>([]);

  // Register/unregister this level on the shared focus stack while it is active.
  useEffect(() => {
    const tok = tokRef.current;
    if (active) {
      pushFocus(tok);
      return () => popFocus(tok);
    }
    return;
  }, [active]);

  // Keep the highlighted row scrolled into view.
  useEffect(() => {
    if (highlight >= 0) rowRefs.current[highlight]?.scrollIntoView({ block: "nearest" });
  }, [highlight]);

  useEffect(() => {
    if (!active) return;
    const tok = tokRef.current;
    const onKey = (e: KeyboardEvent) => {
      // A deeper submenu is open and owns the keyboard — ignore here.
      if (!isTopFocus(tok)) return;

      const move = (dir: 1 | -1) => {
        const start = highlight < 0 ? (dir === 1 ? 0 : items.length - 1) : highlight + dir;
        const next = firstEnabled(items, start, dir);
        if (next >= 0) setHighlight(next);
      };

      switch (e.key) {
        case "ArrowDown":
          e.preventDefault();
          e.stopPropagation();
          move(1);
          break;
        case "ArrowUp":
          e.preventDefault();
          e.stopPropagation();
          move(-1);
          break;
        case "ArrowRight":
        case "Enter": {
          const it = items[highlight];
          if (!it || it.disabled) {
            if (e.key === "Enter") {
              e.preventDefault();
              e.stopPropagation();
            }
            break;
          }
          e.preventDefault();
          e.stopPropagation();
          if (it.submenu && it.submenu.length > 0) {
            setOpenSubIndex(highlight);
          } else if (it.onClick) {
            it.onClick();
            onClose();
          }
          break;
        }
        case "ArrowLeft":
          // Close this submenu and hand focus back to the parent level.
          if (className.includes("context-submenu") && onCloseLevel) {
            e.preventDefault();
            e.stopPropagation();
            onCloseLevel();
          }
          break;
        case "Escape":
          e.preventDefault();
          e.stopPropagation();
          onClose();
          break;
        default: {
          // Type-ahead: printable single characters filter by label prefix,
          // then fall back to a substring match. Consume the key so it never
          // reaches the grid/input beneath the menu.
          if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
            e.preventDefault();
            e.stopPropagation();
            const now = Date.now();
            const buf = typeBufRef.current;
            // Reset the buffer after a short pause between keystrokes.
            buf.text = now - buf.at > 800 ? e.key : buf.text + e.key;
            buf.at = now;
            const q = buf.text.toLowerCase();
            const matches = (label: string) => label.toLowerCase().startsWith(q);
            const contains = (label: string) => label.toLowerCase().includes(q);
            let found = items.findIndex((it) => !it.disabled && matches(it.label));
            if (found < 0) found = items.findIndex((it) => !it.disabled && contains(it.label));
            if (found >= 0) setHighlight(found);
          }
          break;
        }
      }
    };
    // Capture so we intercept before the grid's own key handlers.
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [active, items, highlight, onClose, onCloseLevel, className]);

  return (
    <>
      {items.map((it, i) => (
        <MenuRow
          key={it.label}
          item={it}
          onClose={onClose}
          rowRef={(el) => (rowRefs.current[i] = el)}
          highlighted={i === highlight}
          onHover={() => setHighlight(i)}
          // Keyboard-opened submenu for this row; hover opens independently.
          keyboardOpen={openSubIndex === i}
          onCloseSubmenu={() => {
            setOpenSubIndex(null);
          }}
        />
      ))}
    </>
  );
}

/** One row in a menu; opens a side submenu on hover or via keyboard when it has
 * children. The submenu is fixed-positioned and clamped to the viewport so a
 * long list (e.g. many categories) never runs off the bottom or right edge. */
function MenuRow({
  item,
  onClose,
  rowRef: setRowRefEl,
  highlighted,
  onHover,
  keyboardOpen,
  onCloseSubmenu,
}: {
  item: ContextMenuItem;
  onClose: () => void;
  rowRef: (el: HTMLDivElement | null) => void;
  highlighted: boolean;
  onHover: () => void;
  keyboardOpen: boolean;
  onCloseSubmenu: () => void;
}) {
  const [hoverOpen, setHoverOpen] = useState(false);
  const rowRef = useRef<HTMLDivElement | null>(null);
  const subRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number; maxHeight: number } | null>(null);
  const hasSub = !!item.submenu && item.submenu.length > 0;
  const open = hasSub && (hoverOpen || keyboardOpen);

  // Position the submenu against the viewport once it opens (and is measured).
  useLayoutEffect(() => {
    if (!open || !hasSub) {
      setPos(null);
      return;
    }
    const row = rowRef.current?.getBoundingClientRect();
    const sub = subRef.current;
    if (!row || !sub) return;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const margin = 6;
    const subW = sub.offsetWidth || 200;
    const subH = sub.scrollHeight;

    // Horizontal: prefer opening to the right of the row; flip to the left if it
    // would overflow the right edge.
    let left = row.right + 2;
    if (left + subW > vw - margin) left = Math.max(margin, row.left - subW - 2);

    // Vertical: start aligned near the row top, but shift up so the bottom fits;
    // cap the height to the available viewport so it scrolls instead of clipping.
    const maxHeight = vh - 2 * margin;
    let top = row.top - 5;
    const height = Math.min(subH, maxHeight);
    if (top + height > vh - margin) top = Math.max(margin, vh - margin - height);
    if (top < margin) top = margin;

    setPos({ left, top, maxHeight });
  }, [open, hasSub]);

  return (
    <div
      ref={(el) => {
        rowRef.current = el;
        setRowRefEl(el);
      }}
      className="context-menu-row"
      onMouseEnter={() => {
        setHoverOpen(true);
        onHover();
      }}
      onMouseLeave={() => setHoverOpen(false)}
    >
      <button
        className={
          "context-menu-item" +
          (item.disabled ? " disabled" : "") +
          (hasSub ? " has-submenu" : "") +
          (highlighted ? " highlighted" : "")
        }
        role="menuitem"
        disabled={item.disabled}
        onClick={() => {
          if (item.disabled || hasSub) return; // submenu parents don't act on click
          item.onClick?.();
          onClose();
        }}
      >
        <span>{item.label}</span>
        {hasSub && <span className="context-menu-caret">▸</span>}
      </button>
      {hasSub && open && (
        <div
          ref={subRef}
          className="context-menu context-submenu"
          role="menu"
          style={
            pos
              ? { left: pos.left, top: pos.top, maxHeight: pos.maxHeight }
              : // Pre-measure render: offscreen so it can be sized without flicker.
                { left: -9999, top: 0, visibility: "hidden" }
          }
        >
          <MenuList
            items={item.submenu!}
            onClose={onClose}
            onCloseLevel={onCloseSubmenu}
            active={open}
            className="context-menu context-submenu"
          />
        </div>
      )}
    </div>
  );
}

/** A popup menu anchored at (x, y) with optional hierarchical submenus.
 * Closes on outside click or Escape. Supports keyboard navigation (arrow keys,
 * Enter) and type-ahead: typing jumps to the matching item in the active menu
 * level instead of leaking keystrokes to the grid/input beneath. */
export function ContextMenu({ x, y, items, onClose }: Props) {
  const menuRef = useRef<HTMLDivElement>(null);
  // Clamp the menu to the viewport: if it would run off the bottom (e.g. a tall
  // menu opened on a bottom row) shift it up so its bottom is flush with the
  // window; likewise for the right edge. Cap the height so it scrolls if needed.
  const [pos, setPos] = useState<{ left: number; top: number; maxHeight: number } | null>(null);
  useLayoutEffect(() => {
    const el = menuRef.current;
    if (!el) return;
    const margin = 6;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const w = el.offsetWidth || 200;
    const h = el.scrollHeight;
    const maxHeight = vh - 2 * margin;
    const height = Math.min(h, maxHeight);
    let top = y;
    if (top + height > vh - margin) top = Math.max(margin, vh - margin - height);
    if (top < margin) top = margin;
    let left = x;
    if (left + w > vw - margin) left = Math.max(margin, vw - margin - w);
    if (left < margin) left = margin;
    setPos({ left, top, maxHeight });
  }, [x, y, items]);

  useEffect(() => {
    const close = () => onClose();
    // Defer so the opening click doesn't immediately close it.
    const id = setTimeout(() => {
      window.addEventListener("click", close);
      window.addEventListener("contextmenu", close);
    }, 0);
    return () => {
      clearTimeout(id);
      window.removeEventListener("click", close);
      window.removeEventListener("contextmenu", close);
    };
  }, [onClose]);

  return (
    <div
      ref={menuRef}
      className="context-menu"
      style={
        pos
          ? { left: pos.left, top: pos.top, maxHeight: pos.maxHeight, overflowY: "auto" }
          : // Pre-measure render: place at the requested point, hidden to avoid a flash.
            { left: x, top: y, visibility: "hidden" }
      }
      role="menu"
    >
      <MenuList items={items} onClose={onClose} active className="context-menu" />
    </div>
  );
}
