import type { ReactNode } from "react";
import type { Account } from "../shared/types";
import { bpsToPercent, displaySign, formatCents, isLiability } from "../core/money";

interface Props {
  account: Account;
  onClose: () => void;
}

const TYPE_LABELS: Record<Account["type"], string> = {
  checking: "Checking",
  savings: "Savings",
  credit_card: "Credit Card",
  loan: "Loan / Mortgage",
  investment: "Investment",
  asset: "Asset",
};

// Matches http(s) URLs and bare www.* hosts inside free text. Kept deliberately
// simple; trailing punctuation is trimmed off the match below so a URL at the
// end of a sentence doesn't swallow the period/paren.
const URL_RE = /\b(https?:\/\/[^\s]+|www\.[^\s]+)/gi;

/** Open a URL in the default browser via the main process (http/https only). */
function openUrl(raw: string) {
  const url = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  void window.ledger.openExternal(url);
}

/** A single clickable link that opens externally instead of navigating in-app. */
function ExternalLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a
      href={href}
      onClick={(e) => {
        e.preventDefault();
        openUrl(href);
      }}
    >
      {children}
    </a>
  );
}

/** Render free text with any embedded URLs turned into clickable links. Line
 * breaks are preserved by the caller's CSS (white-space: pre-wrap). */
function linkify(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  let key = 0;
  for (const m of text.matchAll(URL_RE)) {
    const start = m.index ?? 0;
    let match = m[0];
    // Trim trailing punctuation that's more likely sentence punctuation than URL.
    const trailing = match.match(/[).,;!?]+$/)?.[0] ?? "";
    if (trailing) match = match.slice(0, match.length - trailing.length);
    const end = start + match.length;
    if (start > last) out.push(text.slice(last, start));
    out.push(
      <ExternalLink key={key++} href={match}>
        {match}
      </ExternalLink>
    );
    if (trailing) out.push(trailing);
    last = end + trailing.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="field">
      <label>{label}</label>
      <div>{value || "—"}</div>
    </div>
  );
}

/** Row whose value text may contain URLs; those are rendered as clickable links. */
function LinkRow({ label, value, multiline }: { label: string; value: string; multiline?: boolean }) {
  return (
    <div className="field">
      <label>{label}</label>
      <div style={multiline ? { whiteSpace: "pre-wrap" } : undefined}>
        {value ? linkify(value) : "—"}
      </div>
    </div>
  );
}

/** Read-only view of an account's fields. */
export function ViewAccountDialog({ account, onClose }: Props) {
  const openingDisplay = formatCents(
    account.openingBalanceCents * displaySign(account.type),
    account.currency
  );
  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <div className="dialog" onClick={(e) => e.stopPropagation()}>
        <h3>Account details</h3>
        <Row label="Name" value={account.name} />
        <Row label="Type" value={TYPE_LABELS[account.type]} />
        <Row label="Account ID" value={account.accountCode ?? ""} />
        <Row label="Currency" value={account.currency} />
        {isLiability(account.type) && (
          <Row
            label="Annual interest rate"
            value={account.interestRateBps != null ? `${bpsToPercent(account.interestRateBps)}%` : ""}
          />
        )}
        <Row label="Opening balance" value={openingDisplay} />
        <Row label="Opening balance date" value={account.openingBalanceDate ?? ""} />
        <LinkRow label="Website URL" value={account.websiteUrl ?? ""} />
        <LinkRow label="Notes" value={account.notes ?? ""} multiline />
        <div className="dialog-actions">
          <button onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}
