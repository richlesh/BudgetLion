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

/** One row in a menu; opens a side submenu on hover when it has children.
 * The submenu is fixed-positioned and clamped to the viewport so a long list
 * (e.g. many categories) never runs off the bottom or right edge. */
function MenuRow({ item, onClose }: { item: ContextMenuItem; onClose: () => void }) {
  const [open, setOpen] = useState(false);
  const rowRef = useRef<HTMLDivElement>(null);
  const subRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number; maxHeight: number } | null>(null);
  const hasSub = !!item.submenu && item.submenu.length > 0;

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
      ref={rowRef}
      className="context-menu-row"
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
    >
      <button
        className={
          "context-menu-item" +
          (item.disabled ? " disabled" : "") +
          (hasSub ? " has-submenu" : "")
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
          {item.submenu!.map((sub) => (
            <MenuRow key={sub.label} item={sub} onClose={onClose} />
          ))}
        </div>
      )}
    </div>
  );
}

/** A popup menu anchored at (x, y) with optional hierarchical submenus.
 * Closes on outside click or Escape. */
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
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    // Defer so the opening click doesn't immediately close it.
    const id = setTimeout(() => {
      window.addEventListener("click", close);
      window.addEventListener("contextmenu", close);
      window.addEventListener("keydown", onKey);
    }, 0);
    return () => {
      clearTimeout(id);
      window.removeEventListener("click", close);
      window.removeEventListener("contextmenu", close);
      window.removeEventListener("keydown", onKey);
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
      {items.map((it) => (
        <MenuRow key={it.label} item={it} onClose={onClose} />
      ))}
    </div>
  );
}
