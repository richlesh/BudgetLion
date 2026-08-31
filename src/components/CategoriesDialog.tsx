import { useState } from "react";
import type { Category } from "../shared/types";

interface Props {
  categories: Category[];
  onCancel: () => void;
  onAdd: (name: string) => Promise<void> | void;
}

export function CategoriesDialog({ categories, onCancel, onAdd }: Props) {
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);

  async function add() {
    const trimmed = name.trim();
    if (!trimmed) {
      setError("Enter a category name.");
      return;
    }
    if (categories.some((c) => c.name.toLowerCase() === trimmed.toLowerCase())) {
      setError("That category already exists.");
      return;
    }
    await onAdd(trimmed);
    setName("");
    setError(null);
  }

  return (
    <div className="dialog-backdrop" onClick={onCancel}>
      <div className="dialog" onClick={(e) => e.stopPropagation()}>
        <h3>Categories</h3>
        <div className="field">
          <label>Add a category</label>
          <div style={{ display: "flex", gap: 8 }}>
            <input
              value={name}
              autoFocus
              placeholder="e.g. Groceries"
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && add()}
            />
            <button onClick={add}>Add</button>
          </div>
        </div>
        {error && <div className="error">{error}</div>}
        <div className="field">
          <label>Existing</label>
          <div style={{ maxHeight: 180, overflowY: "auto" }}>
            {categories.length === 0 ? (
              <div className="account-type">None yet</div>
            ) : (
              categories.map((c) => (
                <div key={c.id} style={{ padding: "4px 0" }}>
                  {c.name}
                </div>
              ))
            )}
          </div>
        </div>
        <div className="dialog-actions">
          <button className="secondary" onClick={onCancel}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
