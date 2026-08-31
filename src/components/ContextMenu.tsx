import { useEffect } from "react";

export interface ContextMenuItem {
  label: string;
  onClick: () => void;
}

interface Props {
  x: number;
  y: number;
  items: ContextMenuItem[];
  onClose: () => void;
}

/** A minimal popup menu anchored at (x, y). Closes on outside click or Escape. */
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
        <button
          key={it.label}
          className="context-menu-item"
          role="menuitem"
          onClick={() => {
            it.onClick();
            onClose();
          }}
        >
          {it.label}
        </button>
      ))}
    </div>
  );
}
