import { useEffect, useState } from "react";
import type {
  Account,
  Category,
  EstimateMode,
  Frequency,
  NewRecurringRuleInput,
  RecurringRule,
} from "../shared/types";
import { formatCents, parseCents } from "../core/money";
import { categoryOptions } from "../core/categories";

interface Props {
  accounts: Account[];
  categories: Category[];
  /** Optional pre-filled values (e.g. seeded from a transaction via "Add to Recurring"). */
  initialSeed?: Partial<NewRecurringRuleInput> | null;
  onClose: () => void;
  onChanged: () => void;
}

const FREQS: { value: Frequency; label: string }[] = [
  { value: "weekly", label: "Weekly" },
  { value: "biweekly", label: "Bi-weekly" },
  { value: "monthly", label: "Monthly" },
  { value: "yearly", label: "Yearly" },
];

const MODES: { value: EstimateMode; label: string }[] = [
  { value: "fixed", label: "Fixed amount" },
  { value: "average", label: "Average of history" },
  { value: "last", label: "Last amount" },
];

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

const BLANK: NewRecurringRuleInput = {
  name: "",
  amountCents: 0,
  estimateMode: "fixed",
  fromAccountId: null,
  toAccountId: null,
  categoryId: null,
  frequency: "monthly",
  intervalCount: 1,
  startDate: today(),
  endDate: null,
  dayOfMonth: null,
};

export function RecurringRulesDialog({ accounts, categories, initialSeed, onClose, onChanged }: Props) {
  const [rules, setRules] = useState<RecurringRule[]>([]);
  const [editingId, setEditingId] = useState<string | null>(null);
  const seeded: NewRecurringRuleInput = initialSeed ? { ...BLANK, ...initialSeed } : BLANK;
  const [form, setForm] = useState<NewRecurringRuleInput>(seeded);
  const [amountStr, setAmountStr] = useState(((seeded.amountCents ?? 0) / 100).toFixed(2));
  const [error, setError] = useState<string | null>(null);

  // Category options sorted by full display name for the picker.
  const categoryChoices = categoryOptions(categories);

  const refresh = () => window.ledger.listRecurringRules().then(setRules);
  useEffect(() => {
    void refresh();
  }, []);

  function beginEdit(r: RecurringRule) {
    setEditingId(r.id);
    setForm({
      name: r.name,
      amountCents: r.amountCents ?? 0,
      estimateMode: r.estimateMode,
      fromAccountId: r.fromAccountId,
      toAccountId: r.toAccountId,
      categoryId: r.categoryId,
      frequency: r.frequency,
      intervalCount: r.intervalCount,
      startDate: r.startDate,
      endDate: r.endDate,
      dayOfMonth: r.dayOfMonth,
    });
    setAmountStr(((r.amountCents ?? 0) / 100).toFixed(2));
    setError(null);
  }

  function beginNew() {
    setEditingId(null);
    setForm(BLANK);
    setAmountStr("0.00");
    setError(null);
  }

  function set<K extends keyof NewRecurringRuleInput>(key: K, value: NewRecurringRuleInput[K]) {
    setForm((f) => ({ ...f, [key]: value }));
  }

  async function save() {
    if (!form.name.trim()) {
      setError("Name is required.");
      return;
    }
    if (!form.fromAccountId && !form.toAccountId) {
      setError("Pick a From and/or To account.");
      return;
    }
    if (form.fromAccountId && form.fromAccountId === form.toAccountId) {
      setError("From and To cannot be the same account.");
      return;
    }
    const cents = parseCents(amountStr) ?? 0;
    const payload: NewRecurringRuleInput = {
      ...form,
      name: form.name.trim(),
      amountCents: form.estimateMode === "fixed" ? Math.abs(cents) : null,
    };
    try {
      if (editingId) await window.ledger.updateRecurringRule({ id: editingId, ...payload });
      else await window.ledger.createRecurringRule(payload);
      await refresh();
      onChanged();
      beginNew();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  async function remove(id: string) {
    await window.ledger.deleteRecurringRule(id);
    await refresh();
    onChanged();
    if (editingId === id) beginNew();
  }

  const acctName = (id: string | null) =>
    id ? accounts.find((a) => a.id === id)?.name ?? "?" : "—";

  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <div className="dialog" style={{ width: 620 }} onClick={(e) => e.stopPropagation()}>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <h3 style={{ margin: 0 }}>Recurring Rules</h3>
          <span style={{ flex: 1 }} />
          <button className="secondary icon-btn" onClick={onClose} title="Close" aria-label="Close">
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              style={{ display: "block" }}
            >
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>

        <div style={{ display: "flex", gap: 16 }}>
          {/* Existing rules list */}
          <div style={{ flex: 1, maxHeight: 360, overflow: "auto" }}>
            {rules.length === 0 ? (
              <div className="account-type">No rules yet.</div>
            ) : (
              rules.map((r) => (
                <div
                  key={r.id}
                  className={"account-item" + (r.id === editingId ? " active" : "")}
                  onClick={() => beginEdit(r)}
                >
                  <div>
                    <div>{r.name}</div>
                    <div className="account-type">
                      {r.frequency} · {acctName(r.fromAccountId)} → {acctName(r.toAccountId)} ·{" "}
                      {r.estimateMode === "fixed"
                        ? formatCents(r.amountCents ?? 0, "USD")
                        : r.estimateMode}
                    </div>
                  </div>
                  <button
                    className="secondary"
                    style={{ padding: "2px 8px" }}
                    onClick={(e) => {
                      e.stopPropagation();
                      void remove(r.id);
                    }}
                  >
                    Delete
                  </button>
                </div>
              ))
            )}
          </div>

          {/* Edit / add form */}
          <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 8 }}>
            <div className="field">
              <label>Name</label>
              <input value={form.name} onChange={(e) => set("name", e.target.value)} placeholder="Mortgage, Electric bill…" />
            </div>
            <div className="field">
              <label>From account</label>
              <select value={form.fromAccountId ?? ""} onChange={(e) => set("fromAccountId", e.target.value || null)}>
                <option value="">— External —</option>
                {accounts.map((a) => (
                  <option key={a.id} value={a.id}>{a.name}</option>
                ))}
              </select>
            </div>
            <div className="field">
              <label>To account</label>
              <select value={form.toAccountId ?? ""} onChange={(e) => set("toAccountId", e.target.value || null)}>
                <option value="">— External —</option>
                {accounts.map((a) => (
                  <option key={a.id} value={a.id}>{a.name}</option>
                ))}
              </select>
            </div>
            <div className="field">
              <label>Category</label>
              <select value={form.categoryId ?? ""} onChange={(e) => set("categoryId", e.target.value || null)}>
                <option value="">— Uncategorized —</option>
                {categoryChoices.map((o) => (
                  <option key={o.category.id} value={o.category.id}>{o.display}</option>
                ))}
              </select>
            </div>
            <div className="field">
              <label>Estimation</label>
              <select value={form.estimateMode} onChange={(e) => set("estimateMode", e.target.value as EstimateMode)}>
                {MODES.map((m) => (
                  <option key={m.value} value={m.value}>{m.label}</option>
                ))}
              </select>
            </div>
            {form.estimateMode === "fixed" && (
              <div className="field">
                <label>Amount</label>
                <input value={amountStr} onChange={(e) => setAmountStr(e.target.value)} />
              </div>
            )}
            <div style={{ display: "flex", gap: 8 }}>
              <div className="field" style={{ flex: 1 }}>
                <label>Frequency</label>
                <select value={form.frequency} onChange={(e) => set("frequency", e.target.value as Frequency)}>
                  {FREQS.map((f) => (
                    <option key={f.value} value={f.value}>{f.label}</option>
                  ))}
                </select>
              </div>
              <div className="field" style={{ width: 90 }}>
                <label>Every</label>
                <input
                  type="number"
                  min={1}
                  value={form.intervalCount ?? 1}
                  onChange={(e) => set("intervalCount", Math.max(1, Number(e.target.value)))}
                />
              </div>
            </div>
            <div style={{ display: "flex", gap: 8 }}>
              <div className="field" style={{ flex: 1 }}>
                <label>Start date</label>
                <input type="date" value={form.startDate} onChange={(e) => set("startDate", e.target.value)} />
              </div>
              <div className="field" style={{ flex: 1 }}>
                <label>End date (optional)</label>
                <input type="date" value={form.endDate ?? ""} onChange={(e) => set("endDate", e.target.value || null)} />
              </div>
            </div>
            {error && <div className="error">{error}</div>}
            <div className="dialog-actions">
              {editingId && (
                <button className="secondary" onClick={beginNew}>
                  New
                </button>
              )}
              <button onClick={save}>{editingId ? "Update" : "Add"} Rule</button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
