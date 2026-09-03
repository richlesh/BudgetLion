// Asset-record metadata: extra per-item detail stored in Asset.metadata as JSON,
// for physical assets tracked in an 'asset' account (property, vehicles,
// collectibles, equipment). Pure/framework-agnostic.

/** Lifecycle status of a physical asset item. */
export type AssetStatus = "held" | "sold" | "lost";

/** Structured detail stored in Asset.metadata (JSON string). All fields optional. */
export interface AssetRecordMeta {
  model?: string | null;
  serial?: string | null;
  status?: AssetStatus;
  purchasePriceCents?: number | null;
  purchaseDate?: string | null; // ISO
  salePriceCents?: number | null; // 0 for "lost"
  saleDate?: string | null; // ISO
  notes?: string | null;
}

/** Safely parse an Asset.metadata JSON string into AssetRecordMeta (never throws). */
export function parseAssetMeta(metadata: string | null | undefined): AssetRecordMeta {
  if (!metadata) return {};
  try {
    const obj = JSON.parse(metadata);
    return obj && typeof obj === "object" ? (obj as AssetRecordMeta) : {};
  } catch {
    return {};
  }
}

/** Serialize AssetRecordMeta to a JSON string (dropping undefined keys). */
export function stringifyAssetMeta(meta: AssetRecordMeta): string {
  const clean: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(meta)) {
    if (v !== undefined) clean[k] = v;
  }
  return JSON.stringify(clean);
}

/** Merge patch fields into an existing metadata JSON string, returning a new JSON string. */
export function mergeAssetMeta(metadata: string | null | undefined, patch: AssetRecordMeta): string {
  return stringifyAssetMeta({ ...parseAssetMeta(metadata), ...patch });
}
