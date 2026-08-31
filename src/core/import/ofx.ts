// OFX (Open Financial Exchange) parser. Handles both SGML-style (v1.x) and
// XML-style (v2.x) OFX by extracting <STMTTRN> blocks with a tolerant regex.
// Pure/framework-agnostic.

import type { ParsedRow } from "../../shared/types";
import { parseCents } from "../money";
import { normalizeDate } from "./dates";
import { cleanDescription } from "./normalize";

/** Extract the inner text of the first occurrence of a tag within a block. */
function tag(block: string, name: string): string | null {
  // Matches <NAME>value  (SGML, value runs to next tag or newline) OR <NAME>value</NAME> (XML)
  const re = new RegExp(`<${name}>\\s*([^<\\r\\n]*)`, "i");
  const m = block.match(re);
  return m ? m[1].trim() : null;
}

/** Detect whether text looks like OFX. */
export function looksLikeOfx(text: string): boolean {
  return /<OFX>/i.test(text) || /OFXHEADER/i.test(text) || /<STMTTRN>/i.test(text);
}

export function ofxToRows(text: string): ParsedRow[] {
  const out: ParsedRow[] = [];
  // Grab each transaction block.
  const blocks = text.match(/<STMTTRN>[\s\S]*?(?=<STMTTRN>|<\/BANKTRANLIST>|<\/OFX>|$)/gi) || [];

  for (const block of blocks) {
    const dtRaw = tag(block, "DTPOSTED") || tag(block, "DTUSER");
    const amtRaw = tag(block, "TRNAMT");
    if (!dtRaw || amtRaw == null) continue;

    const date = normalizeDate(dtRaw, "iso");
    const amountCents = parseCents(amtRaw); // OFX amounts are already signed
    if (!date || amountCents == null) continue;

    const name = tag(block, "NAME");
    const memo = tag(block, "MEMO");
    const fitid = tag(block, "FITID");

    out.push({
      date,
      payee: cleanDescription(name),
      memo,
      amountCents,
      importId: fitid, // stable bank ID — ideal for dedupe
    });
  }
  return out;
}
