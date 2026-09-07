// Shared AI provider plumbing for the Electron main process. Centralizes vendor
// endpoint/auth resolution and a generic chat call so multiple features (dupe
// similarity, statement extraction) reuse the same OpenAI-compatible/Anthropic
// logic. Uses global fetch. Vendors whose auth we don't implement here
// (microsoft/amazon/ibm) resolve to null so callers can report "not usable".

import { loadVendors } from "./vendors.js";
import { loadSettings } from "../settings.js";

const stripSlash = (u: string) => u.replace(/\/+$/, "");

/** Resolve base URL + auth headers for an OpenAI-compatible vendor, or null. */
export function resolveEndpoint(
  vendor: string,
  keys: Record<string, string>
): { baseURL: string; headers: Record<string, string> } | null {
  const cfg = loadVendors()[vendor];
  if (!cfg) return null;

  if (vendor === "ollama") {
    return {
      baseURL: cfg.baseURL || "http://localhost:11434/v1",
      headers: { "Content-Type": "application/json" },
    };
  }
  if (vendor.startsWith("generic")) {
    const key = keys[vendor + "ApiKey"];
    const endpoint = keys[vendor + "Endpoint"];
    if (!endpoint) return null;
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (key) headers.Authorization = `Bearer ${key}`;
    return { baseURL: endpoint, headers };
  }
  const key = keys[vendor];
  if (!key) return null;
  return {
    baseURL: cfg.baseURL || "https://api.openai.com/v1",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
  };
}

/** The configured, usable AI vendor/model, or null when AI isn't available. */
export function resolveConfig():
  | { vendor: string; model: string; keys: Record<string, string> }
  | null {
  const s = loadSettings();
  const vendor = s.vendor;
  const model = s.model || (vendor ? s.defaultModels?.[vendor] : undefined);
  if (!vendor || !model) return null;
  if (vendor === "microsoft" || vendor === "amazon" || vendor === "ibm") return null;
  return { vendor, model, keys: s.apiKeys ?? {} };
}

async function withTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

/** Anthropic messages API (/v1/messages). Returns the assistant text. */
async function chatAnthropic(
  apiKey: string,
  model: string,
  system: string,
  user: string,
  maxTokens: number,
  timeoutMs: number
): Promise<string> {
  const res = await withTimeout(
    "https://api.anthropic.com/v1/messages",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model,
        max_tokens: maxTokens,
        system,
        messages: [{ role: "user", content: user }],
      }),
    },
    timeoutMs
  );
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = (await res.json()) as { content?: Array<{ text?: string }> };
  return json.content?.map((c) => c.text ?? "").join("") ?? "";
}

/** OpenAI-compatible chat completions (/chat/completions). Returns assistant text. */
async function chatOpenAICompatible(
  baseURL: string,
  headers: Record<string, string>,
  model: string,
  system: string,
  user: string,
  maxTokens: number,
  timeoutMs: number
): Promise<string> {
  const res = await withTimeout(
    `${stripSlash(baseURL)}/chat/completions`,
    {
      method: "POST",
      headers,
      body: JSON.stringify({
        model,
        max_tokens: maxTokens,
        temperature: 0,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
      }),
    },
    timeoutMs
  );
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = (await res.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  return json.choices?.[0]?.message?.content ?? "";
}

/**
 * Send a system+user prompt to the configured AI and return the raw assistant
 * text. Throws when AI isn't configured/usable or the request fails.
 */
export async function chat(
  system: string,
  user: string,
  opts: { maxTokens?: number; timeoutMs?: number } = {}
): Promise<string> {
  const cfg = resolveConfig();
  if (!cfg) throw new Error("AI not configured");
  const { vendor, model, keys } = cfg;
  const maxTokens = opts.maxTokens ?? 1024;
  const timeoutMs = opts.timeoutMs ?? 30000;

  if (vendor === "anthropic") {
    if (!keys.anthropic) throw new Error("Anthropic key missing");
    return chatAnthropic(keys.anthropic, model, system, user, maxTokens, timeoutMs);
  }
  const ep = resolveEndpoint(vendor, keys);
  if (!ep) throw new Error("No endpoint/key for vendor");
  return chatOpenAICompatible(ep.baseURL, ep.headers, model, system, user, maxTokens, timeoutMs);
}
