// Loads the bundled AI vendor catalog (resources/ai-vendors.json). Runs in the
// Electron main process. Each vendor: { label, models[], apiKeyUrl, baseURL? }.

import { app } from "electron";
import { readFileSync } from "node:fs";
import { join } from "node:path";

export interface VendorConfig {
  label: string;
  models: string[];
  apiKeyUrl: string;
  baseURL?: string;
}

export type VendorMap = Record<string, VendorConfig>;

let cache: VendorMap | null = null;

/** Load and cache the vendor catalog from resources/ai-vendors.json. */
export function loadVendors(): VendorMap {
  if (cache) return cache;
  try {
    const path = join(app.getAppPath(), "resources", "ai-vendors.json");
    const parsed = JSON.parse(readFileSync(path, "utf8")) as { vendors: VendorMap };
    cache = parsed.vendors ?? {};
  } catch {
    cache = {};
  }
  return cache;
}
