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
  ledgerColumnWidths?: Record<string, number>;
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
