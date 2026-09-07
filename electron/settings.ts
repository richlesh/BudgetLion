// Settings persistence for BudgetLion. Stored as JSON in the user's home dir,
// mirroring the NeuroPanther Chat pattern.

import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface Settings {
  theme: "light" | "dark";
  defaultCurrency: string;
  // License info (set via the License dialog)
  licenseKey?: string;
  userName?: string;
  // UI persistence
  windowBounds?: { width: number; height: number; x?: number; y?: number };
  // Path to the current database folder ("package"). Unset = default userData.
  currentDbDir?: string;
  ledgerColumnWidths?: Record<string, number>;
  // Forecast (projection) ledger column widths (colKey -> px).
  forecastColumnWidths?: Record<string, number>;
  // Width (px) of the accounts sidebar (draggable divider).
  sidebarWidth?: number;
  // Fonts (empty string = system default)
  ledgerFont?: string;
  ledgerFontSize?: number;
  printFont?: string;
  printFontSize?: number;
  // AI / LLM
  vendor?: string;
  model?: string;
  apiKeys?: Record<string, string>;
  defaultModels?: Record<string, string>;
  // Phase 2: automated price fetching (opt-in, off by default).
  priceFetchEnabled?: boolean;
  priceSource?: "yahoo";
  // Total number of AI requests made (persisted across launches); used to
  // periodically nag unlicensed users to purchase.
  aiRequestCount?: number;
}

const SETTINGS_PATH = join(homedir(), ".budgetlion-settings.json");

const DEFAULTS: Settings = {
  theme: "light",
  defaultCurrency: "USD",
  vendor: "openai",
  model: "",
  apiKeys: {},
  defaultModels: {},
};

export function loadSettings(): Settings {
  try {
    const saved = JSON.parse(readFileSync(SETTINGS_PATH, "utf8")) as Partial<Settings>;
    return {
      ...DEFAULTS,
      ...saved,
      apiKeys: { ...(DEFAULTS.apiKeys ?? {}), ...(saved.apiKeys ?? {}) },
      defaultModels: { ...(DEFAULTS.defaultModels ?? {}), ...(saved.defaultModels ?? {}) },
    };
  } catch {
    return { ...DEFAULTS };
  }
}

export function saveSettings(settings: Settings): void {
  writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2), "utf8");
}

export function settingsPath(): string {
  return SETTINGS_PATH;
}

/**
 * Increment the persisted AI-request counter and return the new total. Survives
 * across launches (stored in the settings JSON). Best-effort: if persistence
 * fails, still returns the in-memory incremented value.
 */
export function recordAiRequest(): number {
  const settings = loadSettings();
  const count = (settings.aiRequestCount ?? 0) + 1;
  try {
    saveSettings({ ...settings, aiRequestCount: count });
  } catch {
    // Ignore write failures; the caller still gets the incremented count.
  }
  return count;
}
