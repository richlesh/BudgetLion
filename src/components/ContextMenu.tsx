import { useEffect, useState } from "react";

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

/** One row in a menu; opens a side submenu on hover when it has children. */
function MenuRow({ item, onClose }: { item: ContextMenuItem; onClose: () => void }) {
  const [open, setOpen] = useState(false);
  const hasSub = !!item.submenu && item.submenu.length > 0;

  return (
    <div
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
        <div className="context-menu context-submenu" role="menu">
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
    <div className="context-menu" style={{ left: x, top: y }} role="menu">
      {items.map((it) => (
        <MenuRow key={it.label} item={it} onClose={onClose} />
      ))}
    </div>
  );
}
