// Pure description-normalization helpers shared by the import parsers.
// Kept dependency-free to avoid import cycles among the parser modules.

/**
 * Normalize an imported description by trimming a leading "Withdrawal ACH" or
 * "Deposit ACH" prefix (case-insensitive), plus any following separator/space.
 * Returns null unchanged. If trimming would leave an empty string, the original
 * (trimmed) value is kept so the row still has a description.
 */
export function cleanDescription(desc: string | null): string | null {
  if (desc == null) return null;
  const trimmed = desc.trim();
  const stripped = trimmed.replace(/^(?:withdrawal|deposit)\s+ach\b[\s:;,-]*/i, "").trim();
  return stripped === "" ? trimmed : stripped;
}
