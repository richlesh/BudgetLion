import { useMemo, useState } from "react";
import type {
  Account,
  Category,
  EmployerContribution,
  PaycheckDeduction,
  PaycheckInput,
} from "../shared/types";
import { formatCents, parseCents } from "../core/money";
import { categoriesForDirection, categoryOptions } from "../core/categories";
import { buildPaycheckTransactions, learnPaycheckTargets, normalizeLabel, PaycheckError } from "../core/paycheck";
import type { LearnedTarget } from "../core/paycheck";

interface Props {
  /** All accounts (deposit target + transfer targets for deductions/contributions). */
  accounts: Account[];
  categories: Category[];
  /** Preselect this deposit account when set (e.g. the currently viewed account). */
  defaultDepositAccountId?: string | null;
  /** Optional prefill (Phase 2: from a parsed PDF). */
  initial?: Partial<PaycheckDraft>;
  /**
   * Prefill from a reconstructed paycheck (edit / view of an existing split).
   * Takes precedence over `initial` and fully seeds fields including targets.
   */
  initialInput?: PaycheckInput;
  /** "create" (default) shows create UI; "edit" reflects updating an existing paycheck. */
  mode?: "create" | "edit";
  /** View-only: on the counterparty (TO) side of a paycheck transfer split. */
  readOnly?: boolean;
  onCancel: () => void;
  /** Called with the built transactions to persist (deposit split + employer contributions). */
  onSubmit: (input: PaycheckInput) => void | Promise<void>;
}

/** A deduction row as edited in the UI (amounts as typed strings). */
interface DeductionRow {
  key: string;
  label: string;
  amount: string; // positive magnitude as typed
  target: string; // "cat:<id>" | "acct:<id>" | ""
}

/** An employer-contribution row (target must be a tracked account). */
interface ContributionRow {
  key: string;
  label: string;
  amount: string;
  accountId: string; // tracked account id
  sourceCategoryId: string; // income category id ("" allowed)
}

/** The editable draft the dialog manages (also the Phase 2 prefill shape). */
export interface PaycheckDraft {
  date: string;
  employer: string;
  depositAccountId: string;
  gross: string;
  grossCategoryId: string;
  deductions: DeductionRow[];
  contributions: ContributionRow[];
}

const NONE = "";

function today(): string {
  return new Date().toISOString().slice(0, 10);
}
function newKey(): string {
  return Math.random().toString(36).slice(2);
}

/** Convert a reconstructed PaycheckInput into the editable draft (targets encoded). */
function draftFromInput(input: PaycheckInput): PaycheckDraft {
  return {
    date: input.date,
    employer: input.employer,
    depositAccountId: input.depositAccountId,
    gross: input.grossCents ? (input.grossCents / 100).toFixed(2) : "",
    grossCategoryId: input.grossCategoryId,
    deductions:
      input.deductions.length > 0
        ? input.deductions.map((d) => ({
            key: newKey(),
            label: d.label,
            amount: (d.amountCents / 100).toFixed(2),
            target:
              d.target === "transfer" && d.accountId
                ? `acct:${d.accountId}`
                : d.categoryId
                  ? `cat:${d.categoryId}`
                  : NONE,
          }))
        : [{ key: newKey(), label: "", amount: "", target: NONE }],
    contributions: (input.employerContributions ?? []).map((c) => ({
      key: newKey(),
      label: c.label,
      amount: (c.amountCents / 100).toFixed(2),
      accountId: c.accountId ?? "",
      sourceCategoryId: c.sourceCategoryId ?? "",
    })),
  };
}

/**
 * Dedicated paycheck entry. Builds a single split income transaction: +gross to
 * an income category, minus each deduction (routed to an expense category OR a
 * transfer account, the user's choice), netting to the deposit. Employer
 * contributions (e.g. a 401k match) are separate transfer transactions.
 */
export function PaycheckDialog({
  accounts,
  categories,
  defaultDepositAccountId,
  initial,
  initialInput,
  mode = "create",
  readOnly = false,
  onCancel,
  onSubmit,
}: Props) {
  // A reconstructed paycheck (edit/view) fully seeds the draft, including targets.
  const seed: Partial<PaycheckDraft> = initialInput ? draftFromInput(initialInput) : initial ?? {};
  const [date, setDate] = useState(seed.date ?? today());
  const [employer, setEmployer] = useState(seed.employer ?? "");
  const [depositAccountId, setDepositAccountId] = useState(
    seed.depositAccountId ?? defaultDepositAccountId ?? ""
  );
  const [gross, setGross] = useState(seed.gross ?? "");
  const [grossCategoryId, setGrossCategoryId] = useState(seed.grossCategoryId ?? "");
  const [deductions, setDeductions] = useState<DeductionRow[]>(
    seed.deductions ?? [{ key: newKey(), label: "", amount: "", target: NONE }]
  );
  const [contributions, setContributions] = useState<ContributionRow[]>(
    seed.contributions ?? []
  );
  const [error, setError] = useState<string | null>(null);
  const [pdfNote, setPdfNote] = useState<string | null>(null);
  // Employer contributions can't be reconstructed from a single deposit split,
  // so they're only offered when creating a new paycheck.
  const showContributions = mode === "create" && !readOnly;

  const incomeChoices = useMemo(
    () => categoryOptions(categoriesForDirection(categories, "income")),
    [categories]
  );
  const expenseChoices = useMemo(
    () => categoryOptions(categoriesForDirection(categories, "expense")),
    [categories]
  );

  // Live net readout.
  const grossCents = parseCents(gross) ?? 0;
  const totalDeductionsCents = deductions.reduce((s, d) => s + (parseCents(d.amount) ?? 0), 0);
  const netCents = grossCents - totalDeductionsCents;
  const contributionsCents = contributions.reduce((s, c) => s + (parseCents(c.amount) ?? 0), 0);
  const currency = accounts.find((a) => a.id === depositAccountId)?.currency ?? "USD";
  // Amounts are positive magnitudes; the sign is applied automatically (gross is
  // income, deductions are subtracted). Flag any negative entry to block saving.
  const isNeg = (s: string) => {
    const c = parseCents(s);
    return c != null && c < 0;
  };
  const hasNegative =
    isNeg(gross) ||
    deductions.some((d) => isNeg(d.amount)) ||
    (showContributions && contributions.some((c) => isNeg(c.amount)));

  function updateDeduction(key: string, patch: Partial<DeductionRow>) {
    setDeductions((prev) => prev.map((d) => (d.key === key ? { ...d, ...patch } : d)));
  }
  function addDeduction() {
    setDeductions((prev) => [...prev, { key: newKey(), label: "", amount: "", target: NONE }]);
  }
  function removeDeduction(key: string) {
    setDeductions((prev) => prev.filter((d) => d.key !== key));
  }
  function updateContribution(key: string, patch: Partial<ContributionRow>) {
    setContributions((prev) => prev.map((c) => (c.key === key ? { ...c, ...patch } : c)));
  }
  function addContribution() {
    setContributions((prev) => [
      ...prev,
      { key: newKey(), label: "Employer 401(k) Match", amount: "", accountId: "", sourceCategoryId: "" },
    ]);
  }
  function removeContribution(key: string) {
    setContributions((prev) => prev.filter((c) => c.key !== key));
  }

  function buildInput(): PaycheckInput {
    const parsedDeductions: PaycheckDeduction[] = deductions
      .filter((d) => d.target !== NONE || d.amount.trim() !== "" || d.label.trim() !== "")
      .map((d) => {
        const amt = parseCents(d.amount) ?? 0;
        if (d.target.startsWith("cat:")) {
          return { label: d.label, amountCents: amt, target: "category", categoryId: d.target.slice(4) };
        }
        if (d.target.startsWith("acct:")) {
          return { label: d.label, amountCents: amt, target: "transfer", accountId: d.target.slice(5) };
        }
        // Unset target — pass through so the builder raises a clear error.
        return { label: d.label, amountCents: amt, target: "category", categoryId: null };
      });

    const parsedContributions: EmployerContribution[] = contributions.map((c) => ({
      label: c.label,
      amountCents: parseCents(c.amount) ?? 0,
      target: "transfer",
      accountId: c.accountId || null,
      sourceCategoryId: c.sourceCategoryId || null,
    }));

    return {
      date,
      employer,
      depositAccountId,
      grossCents,
      grossCategoryId,
      deductions: parsedDeductions,
      employerContributions: parsedContributions,
    };
  }

  // Convert a learned target into the dialog's encoded target string.
  function encodeLearned(t: LearnedTarget): string {
    if (t.target === "transfer" && t.accountId) return `acct:${t.accountId}`;
    if (t.target === "category" && t.categoryId) return `cat:${t.categoryId}`;
    return NONE;
  }

  // Learn from the last few paychecks of the same employer (same deposit account)
  // and auto-assign a category/account to any deduction that has no target yet.
  // Also adopts the prior gross income category when none is chosen. Returns the
  // number of targets filled. No-op when employer/deposit account are unset.
  async function applyLearning(overrideEmployer?: string): Promise<number> {
    const emp = (overrideEmployer ?? employer).trim();
    if (!emp || !depositAccountId) return 0;
    let data;
    try {
      data = await window.ledger.getAggregateData();
    } catch {
      return 0;
    }
    const learned = learnPaycheckTargets(data, emp, depositAccountId);
    if (learned.sampleCount === 0) return 0;

    let filled = 0;
    setDeductions((prev) =>
      prev.map((d) => {
        if (d.target !== NONE) return d; // respect the user's / PDF's explicit target
        const hit = learned.labelToTarget.get(normalizeLabel(d.label));
        if (!hit) return d;
        const enc = encodeLearned(hit);
        if (enc === NONE) return d;
        filled++;
        return { ...d, target: enc };
      })
    );
    // Adopt a prior gross income category if none chosen yet.
    setGrossCategoryId((cur) => cur || learned.grossCategoryId || cur);
    return filled;
  }

  // Phase 2: pick a stub PDF, extract + parse it in the main process, and prefill
  // the form. Targets (category/account) are left for the user to assign, since
  // the right mapping is personal. Falls back gracefully when nothing is found.
  async function importFromPdf() {
    setError(null);
    setPdfNote(null);
    try {
      const res = await window.ledger.importPaycheckPdf();
      if (!res) return; // user canceled
      if (res.employer) setEmployer(res.employer);
      if (res.date) setDate(res.date);
      if (res.grossCents != null) setGross((res.grossCents / 100).toFixed(2));
      if (res.deductions.length > 0) {
        setDeductions(
          res.deductions.map((d) => ({
            key: newKey(),
            label: d.label,
            amount: (d.amountCents / 100).toFixed(2),
            target: NONE, // user assigns a category or account
          }))
        );
      }
      const found = (res.date ? 1 : 0) + (res.grossCents != null ? 1 : 0) + res.deductions.length;
      if (found === 0) {
        setPdfNote(
          `Couldn't read values from "${res.fileName}". It may be a scanned image; enter the paycheck manually.`
        );
      } else {
        const extra = res.unresolvedLabels.length
          ? ` Unrecognized amounts: ${res.unresolvedLabels.join(", ")}.`
          : "";
        // Learn category/account targets from prior paychecks of this employer.
        const filled = await applyLearning(res.employer ?? undefined);
        const learnNote = filled > 0
          ? ` Auto-assigned ${filled} deduction${filled === 1 ? "" : "s"} from your prior paychecks — please verify.`
          : "";
        setPdfNote(
          `Prefilled from "${res.fileName}". Review amounts and assign a category or account to each deduction.${extra}${learnNote}`
        );
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not read the PDF.");
    }
  }

  async function submit() {
    setError(null);
    try {
      const input = buildInput();
      // Validate by building (throws PaycheckError on bad input).
      buildPaycheckTransactions(input);
      await onSubmit(input);
    } catch (e) {
      if (e instanceof PaycheckError) setError(e.message);
      else setError(e instanceof Error ? e.message : `Could not ${mode === "edit" ? "update" : "create"} paycheck.`);
    }
  }

  const title = readOnly ? "Paycheck (view only)" : mode === "edit" ? "Edit Paycheck" : "New Paycheck";

  return (
    <div className="dialog-backdrop" onClick={onCancel}>
      <div className="dialog" style={{ width: 620 }} onClick={(e) => e.stopPropagation()}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <h3>{title}</h3>
          {mode === "create" && !readOnly && (
            <button className="secondary" onClick={importFromPdf} title="Extract values from a paycheck-stub PDF to prefill this form.">
              Import from PDF…
            </button>
          )}
        </div>
        {readOnly && (
          <div className="account-type" style={{ marginBottom: 4 }}>
            You must edit this paycheck from the deposit account's ledger.
          </div>
        )}
        {pdfNote && <div className="account-type" style={{ marginBottom: 6 }}>{pdfNote}</div>}

        <div className="field">
          <label>Pay date</label>
          <input type="date" value={date} disabled={readOnly} onChange={(e) => setDate(e.target.value)} />
        </div>
        <div className="field">
          <label>Employer</label>
          <input
            value={employer}
            disabled={readOnly}
            onChange={(e) => setEmployer(e.target.value)}
            onBlur={() => { if (!readOnly) void applyLearning(); }}
            placeholder="Employer name"
          />
        </div>
        <div className="field">
          <label>Deposit account</label>
          <select value={depositAccountId} disabled={readOnly} onChange={(e) => setDepositAccountId(e.target.value)}>
            <option value={NONE}>— Choose account —</option>
            {accounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label>Gross pay</label>
          <input value={gross} disabled={readOnly} onChange={(e) => setGross(e.target.value)} placeholder="0.00" style={{ textAlign: "right" }} />
        </div>
        <div className="field">
          <label>Gross income category</label>
          <select value={grossCategoryId} disabled={readOnly} onChange={(e) => setGrossCategoryId(e.target.value)}>
            <option value={NONE}>— Choose income category —</option>
            {incomeChoices.map((o) => (
              <option key={o.category.id} value={o.category.id}>
                {o.display}
              </option>
            ))}
          </select>
        </div>

        <div className="paycheck-section">
          <div className="paycheck-section-head">
            <strong>Deductions</strong>
            <span className="account-type">taxes, insurance, 401(k), …</span>
          </div>
          {deductions.map((d) => (
            <div key={d.key} className="paycheck-row">
              <input
                value={d.label}
                placeholder="Label (e.g. Federal Tax)"
                disabled={readOnly}
                onChange={(e) => updateDeduction(d.key, { label: e.target.value })}
                style={{ flex: 1.2 }}
              />
              <input
                value={d.amount}
                placeholder="0.00"
                disabled={readOnly}
                onChange={(e) => updateDeduction(d.key, { amount: e.target.value })}
                style={{ width: 90, textAlign: "right" }}
              />
              <select
                value={d.target}
                disabled={readOnly}
                onChange={(e) => updateDeduction(d.key, { target: e.target.value })}
                style={{ flex: 1.4 }}
                title="Route this deduction to an expense category or transfer it to a tracked account (e.g. a 401k)."
              >
                <option value={NONE}>— Category or account —</option>
                <optgroup label="Expense category">
                  {expenseChoices.map((o) => (
                    <option key={o.category.id} value={`cat:${o.category.id}`}>
                      {o.display}
                    </option>
                  ))}
                </optgroup>
                <optgroup label="Transfer to account">
                  {accounts
                    .filter((a) => a.id !== depositAccountId)
                    .map((a) => (
                      <option key={a.id} value={`acct:${a.id}`}>
                        → {a.name}
                      </option>
                    ))}
                </optgroup>
              </select>
              {!readOnly && (
                <button
                  className="secondary icon-btn"
                  title="Remove deduction"
                  aria-label="Remove deduction"
                  onClick={() => removeDeduction(d.key)}
                >
                  ✕
                </button>
              )}
            </div>
          ))}
          {!readOnly && (
            <button className="secondary" onClick={addDeduction}>
              + Add deduction
            </button>
          )}
        </div>

        {showContributions && (
        <div className="paycheck-section">
          <div className="paycheck-section-head">
            <strong>Employer contributions</strong>
            <span className="account-type">separate — not part of net (e.g. 401k match)</span>
          </div>
          {contributions.map((c) => (
            <div key={c.key} className="paycheck-row">
              <input
                value={c.label}
                placeholder="Label (e.g. 401k Match)"
                onChange={(e) => updateContribution(c.key, { label: e.target.value })}
                style={{ flex: 1.2 }}
              />
              <input
                value={c.amount}
                placeholder="0.00"
                onChange={(e) => updateContribution(c.key, { amount: e.target.value })}
                style={{ width: 90, textAlign: "right" }}
              />
              <select
                value={c.accountId}
                onChange={(e) => updateContribution(c.key, { accountId: e.target.value })}
                style={{ flex: 0.9 }}
                title="The tracked account that receives the employer contribution (e.g. a 401k)."
              >
                <option value={NONE}>— To account —</option>
                {accounts
                  .filter((a) => a.id !== depositAccountId)
                  .map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name}
                    </option>
                  ))}
              </select>
              <select
                value={c.sourceCategoryId}
                onChange={(e) => updateContribution(c.key, { sourceCategoryId: e.target.value })}
                style={{ flex: 0.9 }}
                title="Income category the employer money is attributed to (optional)."
              >
                <option value={NONE}>— Income category —</option>
                {incomeChoices.map((o) => (
                  <option key={o.category.id} value={o.category.id}>
                    {o.display}
                  </option>
                ))}
              </select>
              <button
                className="secondary icon-btn"
                title="Remove contribution"
                aria-label="Remove contribution"
                onClick={() => removeContribution(c.key)}
              >
                ✕
              </button>
            </div>
          ))}
          <button className="secondary" onClick={addContribution}>
            + Add employer contribution
          </button>
        </div>
        )}

        <div className="paycheck-summary">
          <span>Gross: {formatCents(grossCents, currency)}</span>
          <span>− Deductions: {formatCents(totalDeductionsCents, currency)}</span>
          <span className={netCents < 0 ? "error" : "net"}>
            = Net deposit: {formatCents(netCents, currency)}
          </span>
          {contributionsCents > 0 && (
            <span className="account-type">Employer adds {formatCents(contributionsCents, currency)} (separate)</span>
          )}
        </div>

        {!readOnly && hasNegative && (
          <div className="error">
            Enter positive amounts only — gross is added as income and deductions are subtracted automatically.
          </div>
        )}
        {error && <div className="error">{error}</div>}

        <div className="dialog-actions">
          <button className="secondary" onClick={onCancel}>
            {readOnly ? "Close" : "Cancel"}
          </button>
          {!readOnly && (
            <button onClick={submit} disabled={netCents < 0 || hasNegative}>
              {mode === "edit" ? "Save changes" : "Add paycheck"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
