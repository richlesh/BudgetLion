// Live model-list fetching for AI providers. Runs in the Electron main process
// (uses the global fetch). All functions fail soft: on any error they return the
// bundled static model list for the vendor so the settings UI still works offline.

import { loadVendors } from "./vendors.js";
import { loadSettings } from "../settings.js";

const TIMEOUT_MS = 8000;

async function getJson(url: string, headers: Record<string, string>): Promise<unknown> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { headers, signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

/** Extract model ids from an OpenAI-style { data: [{ id }] } response. */
function idsFromData(json: unknown): string[] {
  const data = (json as { data?: Array<{ id?: string }> })?.data;
  if (!Array.isArray(data)) return [];
  return data.map((d) => d?.id).filter((x): x is string => typeof x === "string");
}

const stripSlash = (u: string) => u.replace(/\/+$/, "");

/** Bundled fallback models for a vendor. */
function staticModels(vendor: string): string[] {
  return loadVendors()[vendor]?.models ?? [];
}

/**
 * Fetch models for an OpenAI-compatible endpoint (openai + any vendor with a
 * baseURL, generic OpenAI vendors, and Ollama). Bearer auth when a key is given.
 */
async function fetchOpenAICompatible(baseURL: string, apiKey: string): Promise<string[]> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  const json = await getJson(`${stripSlash(baseURL)}/models`, headers);
  return idsFromData(json);
}

async function fetchAnthropic(apiKey: string): Promise<string[]> {
  const json = await getJson("https://api.anthropic.com/v1/models?limit=100", {
    "x-api-key": apiKey,
    "anthropic-version": "2023-06-01",
  });
  return idsFromData(json);
}

async function fetchAzure(endpoint: string, apiKey: string): Promise<string[]> {
  const json = await getJson(
    `${stripSlash(endpoint)}/openai/models?api-version=2024-06-01`,
    { "api-key": apiKey }
  );
  return idsFromData(json);
}

/**
 * Fetch models for a vendor using its stored credentials in settings, falling
 * back to the bundled static list on any error or missing credentials.
 */
export async function getModelsForVendor(vendor: string): Promise<string[]> {
  const vendors = loadVendors();
  const cfg = vendors[vendor];
  if (!cfg) return [];
  const s = loadSettings();
  const keys = s.apiKeys ?? {};
  try {
    let models: string[] = [];
    if (vendor === "anthropic") {
      if (keys.anthropic) models = await fetchAnthropic(keys.anthropic);
    } else if (vendor === "microsoft") {
      if (keys.microsoftApiKey && keys.microsoftEndpoint)
        models = await fetchAzure(keys.microsoftEndpoint, keys.microsoftApiKey);
    } else if (vendor === "ibm") {
      // IBM watsonx model listing requires an IAM token exchange; use static list.
      models = [];
    } else if (vendor === "amazon") {
      // Bedrock listing needs SigV4; use static list.
      models = [];
    } else if (vendor === "ollama") {
      models = await fetchOpenAICompatible(cfg.baseURL || "http://localhost:11434/v1", "");
    } else if (vendor === "generic") {
      // Generic (YAML) — no standardized listing here; use static/empty.
      models = [];
    } else if (vendor.startsWith("generic")) {
      const key = keys[vendor + "ApiKey"];
      const endpoint = keys[vendor + "Endpoint"];
      if (key && endpoint) models = await fetchOpenAICompatible(endpoint, key);
    } else {
      // OpenAI + any OpenAI-compatible vendor (has baseURL or defaults to OpenAI).
      const key = keys[vendor];
      const base = cfg.baseURL || "https://api.openai.com/v1";
      if (key) models = await fetchOpenAICompatible(base, key);
    }
    return models.length ? models : staticModels(vendor);
  } catch {
    return staticModels(vendor);
  }
}

/**
 * Fetch models given explicit credentials (used by the settings UI as the user
 * types). vendor determines the protocol; baseURL overrides the endpoint.
 */
export async function fetchModels(opts: {
  vendor: string;
  apiKey?: string;
  baseURL?: string;
}): Promise<string[]> {
  const { vendor, apiKey = "", baseURL } = opts;
  const cfg = loadVendors()[vendor];
  try {
    let models: string[] = [];
    if (vendor === "anthropic") {
      if (apiKey) models = await fetchAnthropic(apiKey);
    } else {
      const base = baseURL || cfg?.baseURL || "https://api.openai.com/v1";
      if (apiKey || vendor === "ollama") models = await fetchOpenAICompatible(base, apiKey);
    }
    return models.length ? models : staticModels(vendor);
  } catch {
    return staticModels(vendor);
  }
}
