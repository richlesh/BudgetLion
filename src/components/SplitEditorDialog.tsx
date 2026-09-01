import { useMemo, useState } from "react";
import type { Account, Category, NewSplitInput } from "../shared/types";
import { formatCents, parseCents } from "../core/money";
import { categoryOptions } from "../core/categories";

interface Props {
  /** The account whose ledger is being viewed (owning account). */
  account: Account;
  /** Other accounts available as transfer legs. */
  accounts: Account[];
  categories: Category[];
  /** The transaction's signed total effect on the owning account (e.g. -50000). */
  signedTotalCents: number;
  /** Existing split legs to seed the editor (empty for a fresh split). */
  initialSplits: NewSplitInput[];
  /**
   * View-only mode: the current account is a transfer-leg counterparty (the TO
   * side), not the split's owner. Legs are shown but not editable.
   */
  readOnly?: boolean;
  /**
   * The id of the account whose ledger is being viewed. In read-only mode, the
   * leg that transfers TO this account is labeled "From account".
   */
  currentAccountId?: string;
  /**
   * In read-only (TO-side) mode, the name of the account the money comes FROM
   * (the split's owning account). Used to label the leg that transfers to the
   * current account as "From <name>".
   */
  fromAccountName?: string;
  onCancel: () => void;
  /** Save the legs (already signed, owning-account perspective). */
  onSave: (splits: NewSplitInput[]) => void;
}

interface DraftLeg {
  key: string;
  // "cat:<id>" | "acct:<id>" | "" (unset)
  target: string;
  amount: string; // positive magnitude as typed
  memo: string;
}

const NONE = "";

function newKey(): string {
  return Math.random().toString(36).slice(2);
}

/**
 * Edit the split legs of a transaction. The user enters positive magnitudes; the
 * sign is taken from the transaction's direction (all legs share the owning
 * account's sign). The running remainder must reach zero to save.
 */
export function SplitEditorDialog({
  account,
  accounts,
  categories,
  signedTotalCents,
  initialSplits,
  readOnly = false,
  currentAccountId,
  fromAccountName,
  onCancel,
  onSave,
}: Props) {
  const sign = signedTotalCents < 0 ? -1 : 1;
  const totalMagnitude = Math.abs(signedTotalCents);
  // The split's owning-account total (sum of the signed legs). Used for the
  // read-only TO-side display, where `signedTotalCents` is only this account's
  // single-leg effect.
  const ownerSignedTotal = initialSplits.reduce((s, l) => s + l.amountCents, 0);

  const otherAccounts = useMemo(
    () => accounts.filter((a) => a.id !== account.id),
    [accounts, account.id]
  );

  // Category options sorted by full display name for the leg picker.
  const categoryChoices = useMemo(() => categoryOptions(categories), [categories]);

  // Lookups for rendering a leg's target as static text in read-only mode.
  const categoryNameById = useMemo(() => {
    const m = new Map<string, string>();
    for (const o of categoryChoices) m.set(o.category.id, o.display);
    return m;
  }, [categoryChoices]);
  const accountNameById = useMemo(() => {
    const m = new Map<string, string>();
    for (const a of accounts) m.set(a.id, a.name);
    return m;
  }, [accounts]);

  // Human label for a leg's target. In read-only (TO-side) mode, the leg that
  // transfers to the current account is shown as "From account".
  const targetLabel = (target: string): string => {
    if (target.startsWith("cat:")) return categoryNameById.get(target.slice(4)) ?? "Category";
    if (target.startsWith("acct:")) {
      const acctId = target.slice(5);
      if (readOnly && currentAccountId && acctId === currentAccountId) {
        return fromAccountName ? `From ${fromAccountName}` : "From account";
      }
      return accountNameById.get(acctId) ?? "Account";
    }
    return "—";
  };

  const seed: DraftLeg[] = useMemo(() => {
    const legs = initialSplits.length > 0 ? initialSplits : [];
    const drafts = legs.map((l) => ({
      key: newKey(),
      target: l.categoryId ? `cat:${l.categoryId}` : l.transferAccountId ? `acct:${l.transferAccountId}` : NONE,
      amount: (Math.abs(l.amountCents) / 100).toFixed(2),
      memo: l.memo ?? "",
    }));
    // Always start with at least two rows for a new split.
    while (drafts.length < 2) drafts.push({ key: newKey(), target: NONE, amount: "", memo: "" });
    return drafts;
  }, [initialSplits]);

  const [legs, setLegs] = useState<DraftLeg[]>(seed);
  const [error, setError] = useState<string | null>(null);

  const allocated = legs.reduce((s, l) => s + (parseCents(l.amount) ?? 0), 0);
  // On the read-only TO side, `signedTotalCents` reflects only this account's
  // (single-leg) effect, not the whole split's owning total, so use the sum of
  // the legs as the total there — the split is already balanced.
  const effectiveTotalMagnitude = readOnly ? allocated : totalMagnitude;
  const remaining = effectiveTotalMagnitude - allocated;

  function update(key: string, patch: Partial<DraftLeg>) {
    setLegs((prev) => prev.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  }
  function addLeg() {
    setLegs((prev) => [...prev, { key: newKey(), target: NONE, amount: "", memo: "" }]);
  }
  function removeLeg(key: string) {
    setLegs((prev) => (prev.length > 1 ? prev.filter((l) => l.key !== key) : prev));
  }

  function save() {
    if (legs.length < 2) {
      setError("A split needs at least two legs.");
      return;
    }
    const out: NewSplitInput[] = [];
    for (const l of legs) {
      const cents = parseCents(l.amount);
      if (cents == null || cents <= 0) {
        setError("Every leg needs a positive amount.");
        return;
      }
      if (l.target === NONE) {
        setError("Every leg needs a category or account.");
        return;
      }
      const signed = Math.abs(cents) * sign;
      if (l.target.startsWith("cat:")) {
        out.push({ amountCents: signed, categoryId: l.target.slice(4), memo: l.memo.trim() || null });
      } else {
        out.push({ amountCents: signed, transferAccountId: l.target.slice(5), memo: l.memo.trim() || null });
      }
    }
    if (remaining !== 0) {
      setError(`Remaining must be zero (off by ${formatCents(remaining, account.currency)}).`);
      return;
    }
    onSave(out);
  }

  return (
    <div className="dialog-backdrop dialog-backdrop-top" onClick={onCancel}>
      <div className="dialog" style={{ width: 520 }} onClick={(e) => e.stopPropagation()}>
        <h3>{readOnly ? "Split transaction (view only)" : "Split transaction"}</h3>
        <div className="account-type">
          Total {formatCents(readOnly ? ownerSignedTotal : signedTotalCents, account.currency)} ·{" "}
          {readOnly ? "split legs (view only)" : "allocate across legs"}
        </div>
        {readOnly && (
          <div className="account-type" style={{ marginTop: 4 }}>
            You must edit splits on the FROM side of the transaction.
          </div>
        )}

        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {legs.map((l) => (
            <div key={l.key} style={{ display: "flex", gap: 6, alignItems: "center" }}>
              {readOnly ? (
                <div
                  className="split-leg-readonly"
                  style={{ flex: 1, padding: "4px 6px" }}
                  title={targetLabel(l.target)}
                >
                  {targetLabel(l.target)}
                </div>
              ) : (
                <select
                  value={l.target}
                  onChange={(e) => update(l.key, { target: e.target.value })}
                  style={{ flex: 1 }}
                >
                  <option value={NONE}>— Category or account —</option>
                  <optgroup label="Categories">
                    {categoryChoices.map((o) => (
                      <option key={o.category.id} value={`cat:${o.category.id}`}>
                        {o.display}
                      </option>
                    ))}
                  </optgroup>
                  <optgroup label="Transfer to/from account">
                    {otherAccounts.map((a) => (
                      <option key={a.id} value={`acct:${a.id}`}>
                        {a.name}
                      </option>
                    ))}
                  </optgroup>
                </select>
              )}
              <input
                value={l.amount}
                placeholder="0.00"
                readOnly={readOnly}
                disabled={readOnly}
                onChange={(e) => update(l.key, { amount: e.target.value })}
                style={{ width: 90, textAlign: "right" }}
              />
              <input
                value={l.memo}
                placeholder="memo"
                readOnly={readOnly}
                disabled={readOnly}
                onChange={(e) => update(l.key, { memo: e.target.value })}
                style={{ width: 110 }}
              />
              {!readOnly && (
                <button
                  className="secondary icon-btn"
                  title="Remove leg"
                  aria-label="Remove leg"
                  onClick={() => removeLeg(l.key)}
                >
                  ✕
                </button>
              )}
            </div>
          ))}
        </div>

        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          {readOnly ? (
            <span />
          ) : (
            <button className="secondary" onClick={addLeg}>
              + Add leg
            </button>
          )}
          <div className={remaining !== 0 ? "error" : ""} style={{ fontVariantNumeric: "tabular-nums" }}>
            Remaining: {formatCents(remaining === 0 ? 0 : remaining * sign, account.currency)}
          </div>
        </div>

        {error && <div className="error">{error}</div>}

        <div className="dialog-actions">
          <button className="secondary" onClick={onCancel}>
            {readOnly ? "Close" : "Cancel"}
          </button>
          {!readOnly && (
            <button onClick={save} disabled={remaining !== 0}>
              Save split
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
