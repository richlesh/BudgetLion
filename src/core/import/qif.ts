// QIF (Quicken Interchange Format) parser. QIF records are line-based:
//   D<date>  T<amount>  P<payee>  M<memo>  N<number>  ^  (record terminator)
// Pure/framework-agnostic.

import type { ParsedRow } from "../../shared/types";
import { parseCents } from "../money";
import { normalizeDate } from "./dates";
import { cleanDescription } from "./normalize";

export function looksLikeQif(text: string): boolean {
  return /^!Type:/im.test(text) || /^\^/m.test(text);
}

export function qifToRows(text: string): ParsedRow[] {
  const out: ParsedRow[] = [];
  const lines = text.split(/\r?\n/);

  let cur: Partial<ParsedRow> & { rawDate?: string } = {};

  const flush = () => {
    if (cur.rawDate && cur.amountCents != null) {
      const date = normalizeDate(cur.rawDate, "us");
      if (date) {
        out.push({
          date,
          payee: cleanDescription(cur.payee ?? null),
          memo: cur.memo ?? null,
          amountCents: cur.amountCents, // QIF amounts are signed
          importId: null,
          transferAccountRef: cur.transferAccountRef ?? null,
        });
      }
    }
    cur = {};
  };

  for (const raw of lines) {
    const line = raw.replace(/\r$/, "");
    if (line.startsWith("!")) continue; // header (e.g. !Type:Bank)
    if (line.startsWith("^")) {
      flush();
      continue;
    }
    const code = line[0];
    const value = line.slice(1).trim();
    switch (code) {
      case "D":
        cur.rawDate = value.replace(/'/g, "/").replace(/ /g, "");
        break;
      case "T":
      case "U": {
        const cents = parseCents(value);
        if (cents != null) cur.amountCents = cents;
        break;
      }
      case "P":
        cur.payee = value || null;
        break;
      case "M":
        cur.memo = value || null;
        break;
      case "A": {
        // Address lines; we use one to carry the transfer counterparty Account ID:
        //   "TRANSFER TO ACCOUNT ID:<code>" / "TRANSFER FROM ACCOUNT ID:<code>"
        const m = /^TRANSFER\s+(TO|FROM)\s+ACCOUNT\s+ID:\s*(.+)$/i.exec(value);
        if (m) {
          cur.transferAccountRef = {
            dir: m[1].toLowerCase() as "to" | "from",
            code: m[2].trim(),
          };
        }
        break;
      }
      default:
        break;
    }
  }
  flush(); // in case the file lacks a trailing ^
  return out;
}
