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
import { buildPaycheckTransactions, PaycheckError } from "../core/paycheck";

interface Props {
  /** All accounts (deposit target + transfer targets for deductions/contributions). */
  accounts: Account[];
  categories: Category[];
  /** Preselect this deposit account when set (e.g. the currently viewed account). */
  defaultDepositAccountId?: string | null;
  /** Optional prefill (Phase 2: from a parsed PDF). */
  initial?: Partial<PaycheckDraft>;
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
  onCancel,
  onSubmit,
}: Props) {
  const [date, setDate] = useState(initial?.date ?? today());
  const [employer, setEmployer] = useState(initial?.employer ?? "");
  const [depositAccountId, setDepositAccountId] = useState(
    initial?.depositAccountId ?? defaultDepositAccountId ?? ""
  );
  const [gross, setGross] = useState(initial?.gross ?? "");
  const [grossCategoryId, setGrossCategoryId] = useState(initial?.grossCategoryId ?? "");
  const [deductions, setDeductions] = useState<DeductionRow[]>(
    initial?.deductions ?? [{ key: newKey(), label: "", amount: "", target: NONE }]
  );
  const [contributions, setContributions] = useState<ContributionRow[]>(
    initial?.contributions ?? []
  );
  const [error, setError] = useState<string | null>(null);
  const [pdfNote, setPdfNote] = useState<string | null>(null);

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

  // Phase 2: pick a stub PDF, extract + parse it in the main process, and prefill
  // the form. Targets (category/account) are left for the user to assign, since
  // the right mapping is personal. Falls back gracefully when nothing is found.
  async function importFromPdf() {
    setError(null);
    setPdfNote(null);
    try {
      const res = await window.ledger.importPaycheckPdf();
      if (!res) return; // user canceled
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
      const found = (res.grossCents != null ? 1 : 0) + res.deductions.length;
      if (found === 0) {
        setPdfNote(
          `Couldn't read values from "${res.fileName}". It may be a scanned image; enter the paycheck manually.`
        );
      } else {
        const extra = res.unresolvedLabels.length
          ? ` Unrecognized amounts: ${res.unresolvedLabels.join(", ")}.`
          : "";
        setPdfNote(`Prefilled from "${res.fileName}". Review amounts and assign a category or account to each deduction.${extra}`);
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
      else setError(e instanceof Error ? e.message : "Could not create paycheck.");
    }
  }

  return (
    <div className="dialog-backdrop" onClick={onCancel}>
      <div className="dialog" style={{ width: 620 }} onClick={(e) => e.stopPropagation()}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <h3>New Paycheck</h3>
          <button className="secondary" onClick={importFromPdf} title="Extract values from a paycheck-stub PDF to prefill this form.">
            Import from PDF…
          </button>
        </div>
        {pdfNote && <div className="account-type" style={{ marginBottom: 6 }}>{pdfNote}</div>}

        <div className="field">
          <label>Pay date</label>
          <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
        </div>
        <div className="field">
          <label>Employer</label>
          <input value={employer} onChange={(e) => setEmployer(e.target.value)} placeholder="Employer name" />
        </div>
        <div className="field">
          <label>Deposit account</label>
          <select value={depositAccountId} onChange={(e) => setDepositAccountId(e.target.value)}>
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
          <input value={gross} onChange={(e) => setGross(e.target.value)} placeholder="0.00" style={{ textAlign: "right" }} />
        </div>
        <div className="field">
          <label>Gross income category</label>
          <select value={grossCategoryId} onChange={(e) => setGrossCategoryId(e.target.value)}>
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
                onChange={(e) => updateDeduction(d.key, { label: e.target.value })}
                style={{ flex: 1.2 }}
              />
              <input
                value={d.amount}
                placeholder="0.00"
                onChange={(e) => updateDeduction(d.key, { amount: e.target.value })}
                style={{ width: 90, textAlign: "right" }}
              />
              <select
                value={d.target}
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
                        {a.name}
                      </option>
                    ))}
                </optgroup>
              </select>
              <button
                className="secondary icon-btn"
                title="Remove deduction"
                aria-label="Remove deduction"
                onClick={() => removeDeduction(d.key)}
              >
                ✕
              </button>
            </div>
          ))}
          <button className="secondary" onClick={addDeduction}>
            + Add deduction
          </button>
        </div>

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

        {error && <div className="error">{error}</div>}

        <div className="dialog-actions">
          <button className="secondary" onClick={onCancel}>
            Cancel
          </button>
          <button onClick={submit} disabled={netCents < 0}>
            Add paycheck
          </button>
        </div>
      </div>
    </div>
  );
}
