import { useMemo, useState } from "react";
import type {
  Account,
  CsvColumnMapping,
  ImportFormat,
  ParsedRow,
} from "../shared/types";
import { formatCents, isLiability } from "../core/money";
import { parseCsvGrid, guessMapping, csvToRows } from "../core/import/csv";
import { ofxToRows } from "../core/import/ofx";
import { qifToRows } from "../core/import/qif";
import { detectFormat, dedupeKey, looksLikeTransferByDescription } from "../core/import";
import { ConfirmDialog } from "./ConfirmDialog";

interface Props {
  account: Account;
  accounts: Account[];
  onCancel: () => void;
  onDone: (importedCount: number) => void;
}

type Stage = "pick" | "map" | "resolve" | "resolveDesc" | "preview";

// Sentinel stored in descResolutions to mean "the user chose Skip".
const SKIP = "__skip__";

export function ImportDialog({ account, accounts, onCancel, onDone }: Props) {
  const [stage, setStage] = useState<Stage>("pick");
  const [fileName, setFileName] = useState<string>("");
  const [format, setFormat] = useState<ImportFormat>("csv");
  const [grid, setGrid] = useState<string[][]>([]);
  const [mapping, setMapping] = useState<CsvColumnMapping | null>(null);
  const [rows, setRows] = useState<ParsedRow[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Resolution choices for transfer Account IDs that didn't auto-match: code -> accountId ("" = skip).
  const [resolutions, setResolutions] = useState<Record<string, string>>({});
  // Per-row resolutions for transfers detected by description (no Account ID):
  //   dedupe key -> accountId, or SKIP. Absent = undecided.
  const [descResolutions, setDescResolutions] = useState<Record<string, string>>({});
  // Index into descTransferRows for the one-at-a-time resolution walk.
  const [descIndex, setDescIndex] = useState(0);
  // Currently selected account in the description-transfer picker (per step).
  const [descPick, setDescPick] = useState<string>("");
  // When true, show a "notation looks off" confirmation before committing.
  const [notationWarn, setNotationWarn] = useState(false);

  // Accounts other than the import target, that could be a transfer counterparty.
  const otherAccounts = useMemo(
    () => accounts.filter((a) => a.id !== account.id),
    [accounts, account.id]
  );
  const accountByCode = useMemo(() => {
    const m = new Map<string, Account>();
    otherAccounts.forEach((a) => {
      if (a.accountCode) m.set(a.accountCode, a);
    });
    return m;
  }, [otherAccounts]);

  // Distinct transfer codes referenced by the parsed rows that don't auto-match
  // an existing account's Account ID (these need manual resolution).
  const unresolvedCodes = useMemo(() => {
    const codes = new Set<string>();
    for (const r of rows) {
      const ref = r.transferAccountRef;
      if (ref && !accountByCode.has(ref.code)) codes.add(ref.code);
    }
    return Array.from(codes);
  }, [rows, accountByCode]);

  // Rows that look like transfers by description but have no Account ID reference,
  // so they need a manual counterparty choice (or skip).
  const descTransferRows = useMemo(
    () => rows.filter((r) => !r.transferAccountRef && looksLikeTransferByDescription(r)),
    [rows]
  );

  const columnCount = grid[0]?.length ?? 0;
  const columnOptions = useMemo(
    () => Array.from({ length: columnCount }, (_, i) => i),
    [columnCount]
  );

  async function pickFile() {
    setError(null);
    const opened = await window.ledger.openImportFile();
    if (!opened) return;
    setFileName(opened.fileName);
    const fmt = detectFormat(opened.fileName, opened.text);
    setFormat(fmt);

    if (fmt === "csv") {
      const g = parseCsvGrid(opened.text);
      if (g.length === 0) {
        setError("The CSV file appears to be empty.");
        return;
      }
      setGrid(g);
      // Credit-card/loan statement CSVs typically use positive = outgoing and
      // negative = incoming (opposite of the internal convention), so default the
      // invert on for liability accounts. The user can toggle it in the mapping UI.
      setMapping({ ...guessMapping(g), invertAmounts: isLiability(account.type) });
      setStage("map");
    } else {
      const parsed = fmt === "ofx" ? ofxToRows(opened.text) : qifToRows(opened.text);
      if (parsed.length === 0) {
        setError(`No transactions found in the ${fmt.toUpperCase()} file.`);
        return;
      }
      setRows(parsed);
      setStage(nextStageAfterParse(parsed));
    }
  }

  function applyMapping() {
    if (!mapping) return;
    const parsed = csvToRows(grid, mapping);
    if (parsed.length === 0) {
      setError("No rows parsed. Check your column mapping (date + amount required).");
      return;
    }
    setError(null);
    setRows(parsed);
    setStage(nextStageAfterParse(parsed));
  }

  // Choose the next stage after parsing: resolve Account-ID transfers first, then
  // description-detected transfers, then the preview.
  function nextStageAfterParse(parsed: ParsedRow[]): Stage {
    const needsCode = parsed.some(
      (r) => r.transferAccountRef && !accountByCode.has(r.transferAccountRef.code)
    );
    if (needsCode) return "resolve";
    const needsDesc = parsed.some(
      (r) => !r.transferAccountRef && looksLikeTransferByDescription(r)
    );
    return needsDesc ? "resolveDesc" : "preview";
  }

  // After the Account-ID resolve step, continue to description resolution if any.
  function afterCodeResolve() {
    if (descTransferRows.length > 0) {
      setDescIndex(0);
      setDescPick("");
      setStage("resolveDesc");
    } else {
      setStage("preview");
    }
  }

  // Record a choice for the current description-transfer row and advance.
  function commitDescChoice(value: string) {
    const row = descTransferRows[descIndex];
    if (row) {
      const key = dedupeKey(row);
      setDescResolutions((prev) => ({ ...prev, [key]: value }));
    }
    const next = descIndex + 1;
    if (next < descTransferRows.length) {
      setDescIndex(next);
      setDescPick("");
    } else {
      setStage("preview");
    }
  }

  // Apply auto-matches + manual resolutions onto the rows, then continue to preview/commit.
  function resolveRows(rowsIn: ParsedRow[]): ParsedRow[] {
    return rowsIn.map((r) => {
      // 1) Account-ID reference resolution (auto-match or manual per-code choice).
      const ref = r.transferAccountRef;
      if (ref) {
        const auto = accountByCode.get(ref.code);
        const chosen = auto ? auto.id : resolutions[ref.code] || null;
        return { ...r, resolvedTransferAccountId: chosen || null };
      }
      // 2) Description-detected transfer resolution (per-row choice; SKIP => none).
      if (looksLikeTransferByDescription(r)) {
        const choice = descResolutions[dedupeKey(r)];
        const chosen = choice && choice !== SKIP ? choice : null;
        return { ...r, resolvedTransferAccountId: chosen };
      }
      return r;
    });
  }

  // Dedupe preview: mark rows whose key already appears within this import batch.
  // (Cross-check against existing DB rows happens on commit.)
  const previewRows = useMemo(() => {
    const seen = new Set<string>();
    return rows.map((row) => {
      const key = dedupeKey(row);
      const duplicate = seen.has(key);
      seen.add(key);
      return { row, duplicate };
    });
  }, [rows]);

  const dupCount = previewRows.filter((p) => p.duplicate).length;

  // Sign-distribution sanity check on the resolved rows (stored convention).
  // Expected dominant sign differs by account type:
  //   - loan/mortgage: one big disbursement (negative) plus many payments that
  //     reduce the balance (positive) -> expect MORE POSITIVES than negatives.
  //   - everything else (checking/savings/credit card): mostly outflows
  //     (spending / charges) -> expect MORE NEGATIVES than positives.
  // If the dominant sign is the opposite of expected, the file's amount notation
  // is probably reversed for this account.
  function notationLooksWrong(): boolean {
    let neg = 0;
    let pos = 0;
    for (const r of resolveRows(rows)) {
      if (r.amountCents < 0) neg++;
      else if (r.amountCents > 0) pos++;
    }
    if (neg === 0 && pos === 0) return false;
    return account.type === "loan" ? neg > pos : pos > neg;
  }

  // Called by the Import button: run the safety check first; if it trips, show a
  // confirmation, otherwise commit immediately.
  function attemptCommit() {
    if (notationLooksWrong()) {
      setNotationWarn(true);
      return;
    }
    void commit();
  }

  async function commit() {
    setNotationWarn(false);
    setBusy(true);
    setError(null);
    try {
      const count = await window.ledger.commitImport(account.id, resolveRows(rows));
      onDone(count);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  }

  function setMap<K extends keyof CsvColumnMapping>(key: K, value: CsvColumnMapping[K]) {
    if (!mapping) return;
    setMapping({ ...mapping, [key]: value });
  }

  function colSelect(
    label: string,
    key: "date" | "payee" | "memo" | "amount" | "debit" | "credit",
    allowNone: boolean
  ) {
    const value = mapping?.[key];
    return (
      <div className="field">
        <label>{label}</label>
        <select
          value={value == null ? "" : String(value)}
          onChange={(e) =>
            setMap(key, (e.target.value === "" ? null : Number(e.target.value)) as never)
          }
        >
          {allowNone && <option value="">— None —</option>}
          {columnOptions.map((i) => (
            <option key={i} value={i}>
              Column {i + 1}
              {mapping?.hasHeaderRow && grid[0][i] ? ` (${grid[0][i]})` : ""}
            </option>
          ))}
        </select>
      </div>
    );
  }

  return (
    <>
    <div className="dialog-backdrop" onClick={onCancel}>
      <div
        className="dialog"
        style={{ width: stage === "preview" ? 640 : 420 }}
        onClick={(e) => e.stopPropagation()}
      >
        <h3>Import into “{account.name}”</h3>
        <div className="account-type">
          {account.type.replace("_", " ")} · {account.currency}
        </div>

        {stage === "pick" && (
          <>
            <p style={{ fontSize: 13, color: "var(--muted)" }}>
              Choose a CSV, OFX/QFX, or QIF file exported from your bank. Transactions
              will be added to this account; duplicates are skipped automatically.
            </p>
            <button onClick={pickFile}>Choose File…</button>
          </>
        )}

        {stage === "map" && mapping && (
          <>
            <div className="account-type">
              {fileName} · detected {format.toUpperCase()} · {grid.length} rows
            </div>
            <label style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 13 }}>
              <input
                type="checkbox"
                checked={mapping.hasHeaderRow}
                onChange={(e) => setMap("hasHeaderRow", e.target.checked)}
                style={{ width: "auto" }}
              />
              First row is a header
            </label>
            <label style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 13 }}>
              <input
                type="checkbox"
                checked={!!mapping.invertAmounts}
                onChange={(e) => setMap("invertAmounts", e.target.checked)}
                style={{ width: "auto" }}
              />
              Amounts use loan / credit-card conventions
            </label>
            <div className="account-type" style={{ marginTop: -2 }}>
              Check when the file lists charges/payments as positive and
              credits/deposits as negative (typical of loan and credit-card
              statements). Amounts will be flipped on import.
            </div>
            <div className="field">
              <label>Date format</label>
              <select
                value={mapping.dateFormat}
                onChange={(e) => setMap("dateFormat", e.target.value as CsvColumnMapping["dateFormat"])}
              >
                <option value="us">MM/DD/YYYY (US)</option>
                <option value="eu">DD/MM/YYYY (EU)</option>
                <option value="iso">YYYY-MM-DD (ISO)</option>
              </select>
            </div>
            {colSelect("Date column", "date", false)}
            {colSelect("Payee column", "payee", true)}
            {colSelect("Memo column", "memo", true)}
            <p style={{ fontSize: 12, color: "var(--muted)" }}>
              Use a single signed Amount column, OR separate Debit/Credit columns.
            </p>
            {colSelect("Amount column (signed)", "amount", true)}
            {colSelect("Debit column (outflow)", "debit", true)}
            {colSelect("Credit column (inflow)", "credit", true)}
          </>
        )}

        {stage === "resolve" && (
          <>
            <p style={{ fontSize: 13, color: "var(--muted)" }}>
              Some transactions reference a transfer <strong>Account ID</strong> that
              doesn’t match any existing account. For each, pick the other account to
              wire up the transfer, or choose <em>Skip</em> to import it as a plain
              single-entry transaction.
            </p>
            {unresolvedCodes.map((code) => (
              <div className="field" key={code}>
                <label>Transfer Account ID: {code}</label>
                <select
                  value={resolutions[code] ?? ""}
                  onChange={(e) =>
                    setResolutions((prev) => ({ ...prev, [code]: e.target.value }))
                  }
                >
                  <option value="">— Skip (import as single entry) —</option>
                  {otherAccounts.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name}
                      {a.accountCode ? ` (${a.accountCode})` : ""}
                    </option>
                  ))}
                </select>
              </div>
            ))}
          </>
        )}

        {stage === "resolveDesc" && descTransferRows[descIndex] && (
          <>
            <p style={{ fontSize: 13, color: "var(--muted)" }}>
              This transaction looks like a <strong>transfer</strong> but no account
              could be matched from its details. Choose the other account involved,
              then click <em>Select</em> — or <em>Skip</em> to import it as a plain
              single-entry transaction.
            </p>
            <div className="account-type">
              Transfer {descIndex + 1} of {descTransferRows.length}
            </div>
            {(() => {
              const row = descTransferRows[descIndex];
              return (
                <div
                  style={{
                    border: "1px solid var(--border)",
                    borderRadius: 6,
                    padding: "8px 10px",
                    fontSize: 13,
                  }}
                >
                  <div>
                    <strong>{row.date}</strong> · {row.payee ?? "(no description)"}
                  </div>
                  {row.memo && <div style={{ color: "var(--muted)" }}>{row.memo}</div>}
                  <div className={row.amountCents < 0 ? "neg" : ""}>
                    {formatCents(row.amountCents, account.currency)}
                  </div>
                </div>
              );
            })()}
            <div className="field">
              <label>Other account</label>
              <select value={descPick} onChange={(e) => setDescPick(e.target.value)}>
                <option value="">— Select an account —</option>
                {otherAccounts.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                    {a.accountCode ? ` (${a.accountCode})` : ""}
                  </option>
                ))}
              </select>
            </div>
          </>
        )}

        {stage === "preview" && (
          <>
            <div className="account-type">
              {fileName} · {format.toUpperCase()} · {rows.length} transactions
              {dupCount > 0 ? ` · ${dupCount} in-file duplicate(s)` : ""}
            </div>
            <div style={{ maxHeight: 300, overflow: "auto", border: "1px solid var(--border)", borderRadius: 6 }}>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
                <thead>
                  <tr>
                    <th style={thStyle}>Date</th>
                    <th style={thStyle}>Payee</th>
                    <th style={{ ...thStyle, textAlign: "right" }}>Amount</th>
                  </tr>
                </thead>
                <tbody>
                  {previewRows.slice(0, 500).map((p, i) => (
                    <tr key={i} style={{ opacity: p.duplicate ? 0.5 : 1 }}>
                      <td style={tdStyle}>{p.row.date}</td>
                      <td style={tdStyle}>{p.row.payee ?? ""}</td>
                      <td style={{ ...tdStyle, textAlign: "right" }} className={p.row.amountCents < 0 ? "neg" : ""}>
                        {formatCents(p.row.amountCents, account.currency)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}

        {error && <div className="error">{error}</div>}

        <div className="dialog-actions">
          <button className="secondary" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
          {stage === "map" && <button onClick={applyMapping}>Preview →</button>}
          {stage === "resolve" && (
            <button onClick={afterCodeResolve}>Continue →</button>
          )}
          {stage === "resolveDesc" && (
            <>
              <button className="secondary" onClick={() => commitDescChoice(SKIP)}>
                Skip
              </button>
              <button onClick={() => commitDescChoice(descPick)} disabled={!descPick}>
                Select
              </button>
            </>
          )}
          {stage === "preview" && (
            <button onClick={attemptCommit} disabled={busy}>
              {busy ? "Importing…" : `Import ${rows.length} transaction(s)`}
            </button>
          )}
        </div>
      </div>
    </div>
    {notationWarn && (
      <ConfirmDialog
        title="Amount signs may be wrong"
        message={
          account.type === "loan"
            ? `Most imported transactions are outflows, but for the loan ${account.name} you'd ` +
              `normally expect more inflows (payments that reduce the balance). The file's amount ` +
              `notation may be reversed for this account (try toggling “invert” in the mapping ` +
              `step). Import anyway?`
            : `Most imported transactions are inflows, but for ${account.name} you'd normally ` +
              `expect more outflows. The file's amount notation may be reversed for this account ` +
              `(try toggling “invert” in the mapping step). Import anyway?`
        }
        confirmLabel="Continue"
        cancelLabel="Cancel"
        destructive={false}
        onConfirm={() => void commit()}
        onCancel={() => setNotationWarn(false)}
      />
    )}
    </>
  );
}

const thStyle: React.CSSProperties = {
  textAlign: "left",
  padding: "6px 8px",
  position: "sticky",
  top: 0,
  background: "var(--panel)",
  borderBottom: "1px solid var(--border)",
};
const tdStyle: React.CSSProperties = {
  padding: "4px 8px",
  borderBottom: "1px solid var(--border)",
};
