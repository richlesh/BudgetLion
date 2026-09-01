// Category display helpers. Pure, framework-agnostic.

import type { Category, CategoryApplicability } from "../shared/types";

/**
 * Full display name for a category, joining ancestors with ":".
 * e.g. Utilities:Electric, Interest:Income. Guards against cycles.
 */
export function categoryDisplayName(
  category: Category,
  all: Category[]
): string {
  const byId = new Map(all.map((c) => [c.id, c]));
  const parts: string[] = [category.name];
  let parentId = category.parentId;
  const seen = new Set<string>([category.id]);
  while (parentId && !seen.has(parentId)) {
    seen.add(parentId);
    const parent = byId.get(parentId);
    if (!parent) break;
    parts.unshift(parent.name);
    parentId = parent.parentId;
  }
  return parts.join(":");
}

/** Categories that may be used for a given direction (income or expense). */
export function categoriesForDirection(
  all: Category[],
  direction: "income" | "expense"
): Category[] {
  const wanted: CategoryApplicability = direction;
  return all.filter(
    (c) => c.deletedAt == null && (c.applicability === "both" || c.applicability === wanted)
  );
}

/** Build [{category, display}] sorted by display name for pickers. */
export function categoryOptions(
  all: Category[]
): Array<{ category: Category; display: string }> {
  return all
    .filter((c) => c.deletedAt == null)
    .map((c) => ({ category: c, display: categoryDisplayName(c, all) }))
    .sort((a, b) => a.display.localeCompare(b.display));
}
