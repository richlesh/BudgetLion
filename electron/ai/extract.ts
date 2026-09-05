// Opt-in AI extraction of transactions from a bank/credit-card statement's text.
// Runs in the Electron main process. Sends the extracted PDF text to the
// configured AI provider and asks for a strict JSON array of transactions, then
// normalizes them into signed ParsedRows (STATEMENT convention: charge positive,
// credit negative) so they flow through the exact same review/import path as the
// heuristic parser and the CSV importer.
//
// Privacy note: this sends statement text to the user's configured AI provider.
// It is only ever invoked from an explicit "Extract with AI" action in the UI.

import type { ParsedRow } from "../../src/shared/types.js";
import { chat, resolveConfig } from "./provider.js";

/** Is an AI vendor/model configured (so the UI can enable the button)? */
export function isAiConfigured(): boolean {
  return resolveConfig() != null;
}

const SYSTEM_PROMPT =
  "You extract financial transactions from raw bank or credit-card statement text. " +
  "Return ONLY a JSON array (no prose, no code fences). Each element must be an object " +
  'with exactly these keys: "date" (ISO YYYY-MM-DD), "description" (string), and ' +
  '"amount" (a number in dollars). When a row shows BOTH a transaction date and a ' +
  "posting date, use the TRANSACTION date (the date the purchase/payment occurred), " +
  "not the posting date. Use the transaction/posting year implied by the statement " +
  "period. Sign convention: a purchase, fee, or interest charge is POSITIVE; " +
  "a payment, refund, or credit is NEGATIVE. Exclude summary/total lines, headers, " +
  "balances, and anything that is not an individual transaction. If there are no " +
  "transactions, return [].";

function userPrompt(text: string): string {
  // Cap the payload defensively; statements are usually well under this.
  const clipped = text.length > 60000 ? text.slice(0, 60000) : text;
  return `Statement text:\n"""\n${clipped}\n"""`;
}

/** Pull the first JSON array out of a model response (tolerates stray text/fences). */
function extractJsonArray(raw: string): unknown {
  let s = raw.trim();
  // Strip code fences if present.
  s = s.replace(/^```(?:json)?/i, "").replace(/```$/i, "").trim();
  if (s.startsWith("[")) {
    return JSON.parse(s);
  }
  // Otherwise find the outermost [...] span.
  const start = s.indexOf("[");
  const end = s.lastIndexOf("]");
  if (start >= 0 && end > start) {
    return JSON.parse(s.slice(start, end + 1));
  }
  throw new Error("No JSON array found in AI response");
}

interface RawTx {
  date?: unknown;
  description?: unknown;
  amount?: unknown;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Coerce one raw AI object into a ParsedRow, or null if unusable. */
function toRow(obj: RawTx): ParsedRow | null {
  const date = typeof obj.date === "string" ? obj.date.trim() : "";
  if (!ISO_DATE.test(date)) return null;

  const amountNum =
    typeof obj.amount === "number"
      ? obj.amount
      : typeof obj.amount === "string"
        ? Number(obj.amount.replace(/[$,\s]/g, ""))
        : NaN;
  if (!Number.isFinite(amountNum) || amountNum === 0) return null;

  const desc =
    typeof obj.description === "string" && obj.description.trim()
      ? obj.description.trim()
      : null;

  // Return STATEMENT convention (charge +, credit -), exactly like the heuristic
  // parser. The import UI's invert toggle (defaulted on for liability accounts)
  // applies the flip to the internal stored convention — so we do NOT flip here.
  const cents = Math.round(amountNum * 100);
  return { date, payee: desc, memo: null, amountCents: cents, importId: null };
}

/**
 * Extract transactions from statement text via the configured AI. Returns rows
 * in STATEMENT convention (charge +, credit -); the import UI's invert toggle
 * (defaulted on for credit-card/loan accounts, per `isLiability`) applies the
 * flip to the internal stored convention — identical to the heuristic/CSV paths.
 * Throws when AI isn't configured or the call/parse fails.
 */
export async function extractTransactions(
  text: string,
  _isLiability: boolean
): Promise<ParsedRow[]> {
  if (!resolveConfig()) throw new Error("AI is not configured. Set a vendor and model in Settings.");
  if (!text || text.trim() === "") throw new Error("No statement text to extract from.");

  const raw = await chat(SYSTEM_PROMPT, userPrompt(text), { maxTokens: 4096, timeoutMs: 60000 });
  const parsed = extractJsonArray(raw);
  if (!Array.isArray(parsed)) throw new Error("AI response was not a JSON array.");

  const rows: ParsedRow[] = [];
  for (const item of parsed) {
    if (item && typeof item === "object") {
      const row = toRow(item as RawTx);
      if (row) rows.push(row);
    }
  }
  return rows;
}
