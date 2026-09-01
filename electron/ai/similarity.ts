// AI-backed payee similarity for duplicate detection. Runs in the Electron main
// process (uses global fetch). Falls back to a pure exact/null comparison when no
// AI is configured or on any error, so de-dupe always works offline.

import { loadVendors } from "./vendors.js";
import { loadSettings } from "../settings.js";
import { pairSimilarFallback } from "../../src/core/dedupe.js";

const TIMEOUT_MS = 12000;
const stripSlash = (u: string) => u.replace(/\/+$/, "");

/** Normalize for the exact/empty fast-path (mirrors the core fallback). */
function norm(p: string | null): string | null {
  if (p == null) return null;
  const t = p.trim().toLowerCase();
  return t.length === 0 ? null : t;
}

/** Resolve the base URL + auth headers for the configured OpenAI-compatible vendor. */
function resolveEndpoint(
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
  // OpenAI + any OpenAI-compatible vendor (baseURL or the OpenAI default).
  const key = keys[vendor];
  if (!key) return null;
  return {
    baseURL: cfg.baseURL || "https://api.openai.com/v1",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
  };
}

const SYSTEM_PROMPT =
  "You compare two transactions from a personal-finance ledger and decide whether they " +
  "are duplicates of the same real-world transaction. Consider the payee names and the " +
  "memos together, allowing for abbreviations, bank descriptors, store/reference numbers, " +
  'punctuation, and formatting differences. Answer with exactly "YES" or "NO".';

/** Prompt for the two-string probe (used only by the availability check). */
function probePrompt(a: string, b: string): string {
  return `Payee A: ${a}\nPayee B: ${b}\nDo these refer to the same payee? Answer YES or NO.`;
}

/** Prompt comparing two transactions' payee + memo. Empty fields shown as "(none)". */
function pairPrompt(
  aPayee: string,
  aMemo: string | null,
  bPayee: string,
  bMemo: string | null
): string {
  const show = (s: string | null) => (s && s.trim() ? s : "(none)");
  return (
    `Transaction A — Payee: ${aPayee} | Memo: ${show(aMemo)}\n` +
    `Transaction B — Payee: ${bPayee} | Memo: ${show(bMemo)}\n` +
    `Are these duplicates of the same transaction? Answer YES or NO.`
  );
}

function parseYes(text: string): boolean {
  return /\byes\b/i.test(text.trim());
}

async function withTimeout(url: string, init: RequestInit): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

/** Anthropic messages API (/v1/messages) — different shape from OpenAI. */
async function askAnthropic(apiKey: string, model: string, content: string): Promise<boolean> {
  const res = await withTimeout("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model,
      max_tokens: 5,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content }],
    }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = (await res.json()) as { content?: Array<{ text?: string }> };
  const text = json.content?.map((c) => c.text ?? "").join("") ?? "";
  return parseYes(text);
}

/** OpenAI-compatible chat completions (/chat/completions). */
async function askOpenAICompatible(
  baseURL: string,
  headers: Record<string, string>,
  model: string,
  content: string
): Promise<boolean> {
  const res = await withTimeout(`${stripSlash(baseURL)}/chat/completions`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      model,
      max_tokens: 5,
      temperature: 0,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content },
      ],
    }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = (await res.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const text = json.choices?.[0]?.message?.content ?? "";
  return parseYes(text);
}

/**
 * Resolve the configured vendor + model, or null if AI isn't usable (no vendor,
 * no model, or an auth scheme we don't implement here).
 */
function resolveConfig():
  | { vendor: string; model: string; keys: Record<string, string> }
  | null {
  const s = loadSettings();
  const vendor = s.vendor;
  const model = s.model || (vendor ? s.defaultModels?.[vendor] : undefined);
  if (!vendor || !model) return null;
  // Vendors whose auth we don't implement here are treated as "not usable".
  if (vendor === "microsoft" || vendor === "amazon" || vendor === "ibm") return null;
  return { vendor, model, keys: s.apiKeys ?? {} };
}

/**
 * Send a prepared user prompt to the configured AI and parse a YES/NO answer.
 * Throws if AI isn't configured/usable or the request fails — callers decide
 * whether to fall back.
 */
async function askAi(content: string): Promise<boolean> {
  const cfg = resolveConfig();
  if (!cfg) throw new Error("AI not configured");
  const { vendor, model, keys } = cfg;
  if (vendor === "anthropic") {
    if (!keys.anthropic) throw new Error("Anthropic key missing");
    return askAnthropic(keys.anthropic, model, content);
  }
  const ep = resolveEndpoint(vendor, keys);
  if (!ep) throw new Error("No endpoint/key for vendor");
  return askOpenAICompatible(ep.baseURL, ep.headers, model, content);
}

/**
 * Is the AI configured AND currently responding? Performs a small live probe
 * (a single trivial similarity question) so a misconfigured or unreachable
 * provider reports as unavailable. Returns false on any error/timeout.
 */
export async function isAiAvailable(): Promise<boolean> {
  if (!resolveConfig()) return false;
  try {
    // A trivially-true prompt; we only care that a well-formed answer comes back.
    await askAi(probePrompt("Acme Store", "Acme Store #123"));
    return true;
  } catch {
    return false;
  }
}

/**
 * Decide if two transactions are duplicates by considering BOTH payee and memo.
 *
 * - Definitely-true fast path (no network): payee and memo each match exactly
 *   (case-insensitive) or are both empty — return true.
 * - If exactly one payee is empty, they cannot be the same payee — return false.
 * - When `useAI` is true and AI is configured, one model call judges the pair
 *   (payee + memo together). Otherwise, or on any AI failure, it falls back to
 *   {@link pairSimilarFallback}, which requires BOTH payee and memo to be similar.
 *
 * `useAI` lets the caller force the deterministic fallback even when AI is
 * available (e.g. the user declined AI for this de-dupe pass).
 */
export async function arePairSimilar(
  aPayee: string | null,
  aMemo: string | null,
  bPayee: string | null,
  bMemo: string | null,
  useAI = true
): Promise<boolean> {
  // Definitely-true fast path: exact/empty match on both fields. No AI needed.
  if (pairSimilarFallback(aPayee, aMemo, bPayee, bMemo)) return true;

  const pa = norm(aPayee);
  const pb = norm(bPayee);
  // If exactly one payee is empty, they can't be the same payee.
  if ((pa === null) !== (pb === null)) return false;

  // Not using AI: the deterministic fallback already returned false above.
  if (!useAI) return false;

  try {
    return await askAi(pairPrompt(aPayee ?? "(none)", aMemo, bPayee ?? "(none)", bMemo));
  } catch {
    // Not configured / network / error -> deterministic fallback (both fields).
    return pairSimilarFallback(aPayee, aMemo, bPayee, bMemo);
  }
}
