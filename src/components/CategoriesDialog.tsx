import { useMemo, useState } from "react";
import type { Category, CategoryApplicability, NewCategoryInput } from "../shared/types";
import { categoryDisplayName, categoryOptions } from "../core/categories";
import { TrashIcon } from "./TrashIcon";

interface Props {
  categories: Category[];
  /** Ids of categories referenced by any transaction/split/rule/child (not deletable). */
  usedCategoryIds: Set<string>;
  onClose: () => void;
  onAdd: (input: NewCategoryInput) => Promise<void> | void;
  onUpdate: (id: string, patch: Partial<NewCategoryInput>) => Promise<void> | void;
  /** Delete an unused category (soft delete). */
  onDelete: (id: string) => Promise<void> | void;
}

const APPLIC: { value: CategoryApplicability; label: string }[] = [
  { value: "both", label: "Both" },
  { value: "income", label: "Income only" },
  { value: "expense", label: "Expense only" },
];

/**
 * Modeless (non-modal) category editor. Rendered as a floating panel with no
 * backdrop so the rest of the app stays interactive while it's open.
 * Supports subcategories (Parent:Child), an applicability flag, and editing
 * existing categories in place.
 */
export function CategoriesDialog({
  categories,
  usedCategoryIds,
  onClose,
  onAdd,
  onUpdate,
  onDelete,
}: Props) {
  const [name, setName] = useState("");
  const [parentId, setParentId] = useState<string>("");
  const [applicability, setApplicability] = useState<CategoryApplicability>("both");
  const [error, setError] = useState<string | null>(null);

  // Options sorted by full display name (Parent:Child).
  const options = useMemo(() => categoryOptions(categories), [categories]);

  // Descendant lookup to prevent choosing a cycle when picking a parent (edit mode).
  const descendantsOf = (id: string): Set<string> => {
    const kids = new Map<string, string[]>();
    categories.forEach((c) => {
      if (c.parentId) kids.set(c.parentId, [...(kids.get(c.parentId) ?? []), c.id]);
    });
    const out = new Set<string>();
    const stack = [id];
    while (stack.length) {
      const cur = stack.pop()!;
      for (const k of kids.get(cur) ?? []) {
        if (!out.has(k)) {
          out.add(k);
          stack.push(k);
        }
      }
    }
    return out;
  };

  async function add() {
    const trimmed = name.trim();
    if (!trimmed) {
      setError("Enter a category name.");
      return;
    }
    // Uniqueness is on the full path (allows "Electric" under two parents).
    const proposedParent = parentId || null;
    const clash = categories.some(
      (c) =>
        c.parentId === proposedParent &&
        c.name.toLowerCase() === trimmed.toLowerCase()
    );
    if (clash) {
      setError("A category with that name already exists under the same parent.");
      return;
    }
    await onAdd({ name: trimmed, parentId: proposedParent, applicability });
    setName("");
    setError(null);
  }

  return (
    <div className="modeless-panel" role="dialog" aria-label="Categories">
      <div className="modeless-header">
        <strong>Categories</strong>
        <button className="secondary icon-btn" title="Close" onClick={onClose}>
          ✕
        </button>
      </div>

      <div className="modeless-body">
        {/* Add form */}
        <div className="field">
          <label>New category name</label>
          <input
            value={name}
            placeholder="e.g. Electric"
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && add()}
          />
        </div>
        <div className="field">
          <label>Parent (optional — makes a subcategory)</label>
          <select value={parentId} onChange={(e) => setParentId(e.target.value)}>
            <option value="">— None (top level) —</option>
            {options.map((o) => (
              <option key={o.category.id} value={o.category.id}>
                {o.display}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label>Applies to</label>
          <select
            value={applicability}
            onChange={(e) => setApplicability(e.target.value as CategoryApplicability)}
          >
            {APPLIC.map((a) => (
              <option key={a.value} value={a.value}>
                {a.label}
              </option>
            ))}
          </select>
        </div>
        {error && <div className="error">{error}</div>}
        <button onClick={add}>Add Category</button>

        {/* Existing categories with inline edit of parent + applicability */}
        <div className="field" style={{ marginTop: 8 }}>
          <label>Existing</label>
          <div className="cat-list">
            {options.length === 0 ? (
              <div className="account-type">None yet</div>
            ) : (
              options.map(({ category: c }) => (
                <CategoryRowEditor
                  key={c.id}
                  category={c}
                  categories={categories}
                  disallowParents={descendantsOf(c.id)}
                  onUpdate={onUpdate}
                  used={usedCategoryIds.has(c.id)}
                  onDelete={onDelete}
                />
              ))
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function CategoryRowEditor({
  category,
  categories,
  disallowParents,
  onUpdate,
  used,
  onDelete,
}: {
  category: Category;
  categories: Category[];
  disallowParents: Set<string>;
  onUpdate: (id: string, patch: Partial<NewCategoryInput>) => Promise<void> | void;
  used: boolean;
  onDelete: (id: string) => Promise<void> | void;
}) {
  const options = useMemo(() => categoryOptions(categories), [categories]);
  // Inline base-name editing: double-click the name to edit; Enter saves, Escape
  // (or blur) cancels. Only the category's OWN name is edited, not the full path.
  const [editingName, setEditingName] = useState(false);
  const [draftName, setDraftName] = useState(category.name);

  function beginEditName() {
    setDraftName(category.name);
    setEditingName(true);
  }

  function commitName() {
    const trimmed = draftName.trim();
    if (trimmed && trimmed !== category.name) {
      void onUpdate(category.id, { name: trimmed });
    }
    setEditingName(false);
  }

  return (
    <div className="cat-row">
      {editingName ? (
        <input
          className="cat-name-input"
          value={draftName}
          autoFocus
          onChange={(e) => setDraftName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              commitName();
            } else if (e.key === "Escape") {
              e.preventDefault();
              setEditingName(false);
            }
          }}
          onFocus={(e) => e.currentTarget.select()}
          onBlur={() => setEditingName(false)}
          title="Edit category name — press Enter to save, Esc to cancel"
        />
      ) : (
        <div
          className="cat-name"
          title={`${categoryDisplayName(category, categories)} — double-click to rename`}
          onDoubleClick={beginEditName}
        >
          {categoryDisplayName(category, categories)}
        </div>
      )}
      <select
        value={category.parentId ?? ""}
        onChange={(e) => onUpdate(category.id, { parentId: e.target.value || null })}
        title="Parent category"
      >
        <option value="">(top level)</option>
        {options
          .filter((o) => o.category.id !== category.id && !disallowParents.has(o.category.id))
          .map((o) => (
            <option key={o.category.id} value={o.category.id}>
              {o.display}
            </option>
          ))}
      </select>
      <select
        value={category.applicability}
        onChange={(e) =>
          onUpdate(category.id, { applicability: e.target.value as CategoryApplicability })
        }
        title="Applies to"
      >
        <option value="both">Both</option>
        <option value="income">Income</option>
        <option value="expense">Expense</option>
      </select>
      {used ? (
        // Keep the column aligned; used categories can't be deleted.
        <span className="cat-del-spacer" aria-hidden="true" />
      ) : (
        <button
          type="button"
          className="secondary icon-btn cat-del-btn"
          title="Delete category (not used by any transaction)"
          aria-label={`Delete category ${category.name}`}
          onClick={() => onDelete(category.id)}
        >
          <TrashIcon />
        </button>
      )}
    </div>
  );
}
