// Data-access layer: maps between SQLite rows and shared domain types.
// Runs only in the Electron main process.

import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import type {
  Account,
  Category,
  NewAccountInput,
  NewCategoryInput,
  UpdateCategoryInput,
  NewTransactionInput,
  ReconcileInput,
  Transaction,
  UpdateTransactionInput,
  UpdateAccountInput,
  TransactionSplit,
  NewSplitInput,
  RecurringRule,
  NewRecurringRuleInput,
  UpdateRecurringRuleInput,
  Asset,
  NewAssetInput,
  UpdateAssetInput,
  AssetValuation,
  NewValuationInput,
  InvestmentTransaction,
  NewTradeInput,
  LedgerTradeInfo,
  InvestmentImportRow,
  LoanPaymentSplitResult,
} from "../../src/shared/types.js";
import { ClearedState } from "../../src/shared/types.js";
import { MICRO } from "../../src/shared/types.js";
import { tradeCashCents } from "../../src/core/worth.js";
import { loanBalanceAsOf, computeLoanPaymentSplit } from "../../src/core/loanSplit.js";
import { getDb } from "./index.js";
import { withUndo } from "./undo.js";

// ---- Row shapes (snake_case, as stored) ----

interface AccountRow {
  id: string;
  name: string;
  type: string;
  currency: string;
  account_code: string | null;
  opening_balance_cents: number;
  opening_balance_date: string | null;
  interest_rate_bps: number | null;
  principal_cents: number | null;
  term_months: number | null;
  escrow_payment_cents: number | null;
  escrow_target: string | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

interface TransactionRow {
  id: string;
  date: string;
  payee: string | null;
  memo: string | null;
  amount_cents: number;
  from_account_id: string | null;
  to_account_id: string | null;
  category_id: string | null;
  cleared: number;
  reconciled: number;
  import_id: string | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

// ---- Mappers ----

function toAccount(r: AccountRow): Account {
  return {
    id: r.id,
    name: r.name,
    type: r.type as Account["type"],
    currency: r.currency,
    accountCode: r.account_code,
    openingBalanceCents: r.opening_balance_cents,
    openingBalanceDate: r.opening_balance_date,
    interestRateBps: r.interest_rate_bps,
    principalCents: r.principal_cents,
    termMonths: r.term_months,
    escrowPaymentCents: r.escrow_payment_cents,
    escrowTarget: r.escrow_target,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    deletedAt: r.deleted_at,
  };
}

function toTransaction(r: TransactionRow): Transaction {
  return {
    id: r.id,
    date: r.date,
    payee: r.payee,
    memo: r.memo,
    amountCents: r.amount_cents,
    fromAccountId: r.from_account_id,
    toAccountId: r.to_account_id,
    categoryId: r.category_id,
    cleared: r.cleared as ClearedState,
    reconciled: r.reconciled ?? 0,
    importId: r.import_id,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    deletedAt: r.deleted_at,
  };
}

function now(): string {
  return new Date().toISOString();
}

// ---- Accounts ----

export function listAccounts(): Account[] {
  const db: Database.Database = getDb();
  const rows = db
    .prepare("SELECT * FROM accounts WHERE deleted_at IS NULL ORDER BY name COLLATE NOCASE")
    .all() as AccountRow[];
  return rows.map(toAccount);
}

export function createAccount(input: NewAccountInput): Account {
  const db = getDb();
  const ts = now();
  const row: AccountRow = {
    id: randomUUID(),
    name: input.name,
    type: input.type,
    currency: input.currency ?? "USD",
    account_code: input.accountCode ?? null,
    opening_balance_cents: input.openingBalanceCents ?? 0,
    opening_balance_date: input.openingBalanceDate ?? null,
    interest_rate_bps: input.interestRateBps ?? null,
    principal_cents: input.principalCents ?? null,
    term_months: input.termMonths ?? null,
    escrow_payment_cents: input.escrowPaymentCents ?? null,
    escrow_target: input.escrowTarget ?? null,
    created_at: ts,
    updated_at: ts,
    deleted_at: null,
  };
  db.prepare(
    `INSERT INTO accounts
       (id, name, type, currency, account_code, opening_balance_cents, opening_balance_date,
        interest_rate_bps, principal_cents, term_months, escrow_payment_cents, escrow_target, created_at, updated_at, deleted_at)
     VALUES
       (@id, @name, @type, @currency, @account_code, @opening_balance_cents, @opening_balance_date,
        @interest_rate_bps, @principal_cents, @term_months, @escrow_payment_cents, @escrow_target, @created_at, @updated_at, @deleted_at)`
  ).run(row);
  return toAccount(row);
}

/** Update an account's opening balance amount and/or date. */
export function updateAccount(input: UpdateAccountInput): void {
  const db = getDb();
  const fields: string[] = [];
  const params: Record<string, unknown> = { id: input.id, updated_at: now() };

  if (input.name !== undefined) {
    fields.push("name = @name");
    params.name = input.name;
  }
  if (input.type !== undefined) {
    fields.push("type = @type");
    params.type = input.type;
  }
  if (input.currency !== undefined) {
    fields.push("currency = @currency");
    params.currency = input.currency;
  }
  if (input.accountCode !== undefined) {
    fields.push("account_code = @account_code");
    params.account_code = input.accountCode;
  }
  if (input.interestRateBps !== undefined) {
    fields.push("interest_rate_bps = @interest_rate_bps");
    params.interest_rate_bps = input.interestRateBps;
  }
  if (input.escrowPaymentCents !== undefined) {
    fields.push("escrow_payment_cents = @escrow_payment_cents");
    params.escrow_payment_cents = input.escrowPaymentCents;
  }
  if (input.escrowTarget !== undefined) {
    fields.push("escrow_target = @escrow_target");
    params.escrow_target = input.escrowTarget;
  }
  if (input.openingBalanceCents !== undefined) {
    fields.push("opening_balance_cents = @opening_balance_cents");
    params.opening_balance_cents = input.openingBalanceCents;
  }
  if (input.openingBalanceDate !== undefined) {
    fields.push("opening_balance_date = @opening_balance_date");
    params.opening_balance_date = input.openingBalanceDate;
  }
  if (fields.length === 0) return; // nothing to update
  fields.push("updated_at = @updated_at");

  db.prepare(`UPDATE accounts SET ${fields.join(", ")} WHERE id = @id`).run(params);
}

/**
 * Whether an account has any reconciled transactions from its perspective: either
 * it OWNS a transaction whose matching side bit is set (from=1 / to=2), or it's a
 * split transfer-leg counterparty whose leg is reconciled. Mirrors the renderer's
 * isReconciledForAccount so the ledger green/lock and this check stay in sync.
 */
export function accountHasReconciled(accountId: string): boolean {
  const db = getDb();
  const owned = db
    .prepare(
      `SELECT COUNT(*) AS n FROM transactions
        WHERE deleted_at IS NULL
          AND ((from_account_id = ? AND (reconciled & 1) != 0)
            OR (to_account_id = ? AND (reconciled & 2) != 0))`
    )
    .get(accountId, accountId) as { n: number };
  if (owned.n > 0) return true;
  const recLegs = db
    .prepare(
      `SELECT COUNT(*) AS n FROM transaction_splits
        WHERE deleted_at IS NULL AND transfer_account_id = ? AND reconciled != 0`
    )
    .get(accountId) as { n: number };
  return recLegs.n > 0;
}

/**
 * True when an account has NO content other than its (synthetic) opening
 * balance: no non-deleted transactions on either side, no transfer-split legs
 * pointing at it, and no non-deleted assets/holdings. Such an "empty" account is
 * safe to delete.
 */
export function accountIsEmpty(accountId: string): boolean {
  const db = getDb();
  const txn = db
    .prepare(
      `SELECT COUNT(*) AS n FROM transactions
        WHERE deleted_at IS NULL AND (from_account_id = ? OR to_account_id = ?)`
    )
    .get(accountId, accountId) as { n: number };
  if (txn.n > 0) return false;
  const legs = db
    .prepare(
      `SELECT COUNT(*) AS n FROM transaction_splits
        WHERE deleted_at IS NULL AND transfer_account_id = ?`
    )
    .get(accountId) as { n: number };
  if (legs.n > 0) return false;
  const assets = db
    .prepare("SELECT COUNT(*) AS n FROM assets WHERE deleted_at IS NULL AND account_id = ?")
    .get(accountId) as { n: number };
  return assets.n === 0;
}

/**
 * Soft-delete an empty account. Throws if the account still has content
 * (transactions, transfer-split legs, or assets) so callers can't orphan data.
 */
export function deleteAccount(accountId: string): void {
  if (!accountIsEmpty(accountId)) {
    throw new Error("Only empty accounts (no transactions or holdings) can be deleted.");
  }
  const db = getDb();
  db.prepare("UPDATE accounts SET deleted_at = ?, updated_at = ? WHERE id = ?").run(
    now(),
    now(),
    accountId
  );
}

// ---- Transactions ----

/** All non-deleted transactions touching a given account (either side). */
export function transactionsForAccount(accountId: string): Transaction[] {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT * FROM transactions
        WHERE deleted_at IS NULL
          AND (from_account_id = ? OR to_account_id = ?)`
    )
    .all(accountId, accountId) as TransactionRow[];
  return rows.map(toTransaction);
}

/** Every non-deleted transaction (used for all-account balance computation). */
export function allTransactions(): Transaction[] {
  const db = getDb();
  const rows = db
    .prepare("SELECT * FROM transactions WHERE deleted_at IS NULL")
    .all() as TransactionRow[];
  return rows.map(toTransaction);
}

/** Non-deleted transactions by id (used to load split-transfer counterparties). */
export function transactionsByIds(ids: string[]): Transaction[] {
  if (ids.length === 0) return [];
  const db = getDb();
  const placeholders = ids.map(() => "?").join(",");
  const rows = db
    .prepare(
      `SELECT * FROM transactions WHERE deleted_at IS NULL AND id IN (${placeholders})`
    )
    .all(...ids) as TransactionRow[];
  return rows.map(toTransaction);
}

export function createTransaction(input: NewTransactionInput): Transaction {
  const db = getDb();
  const ts = now();
  const isSplit = !!(input.splits && input.splits.length >= 2);
  const row: TransactionRow = {
    id: randomUUID(),
    date: input.date,
    payee: input.payee ?? null,
    memo: input.memo ?? null,
    amount_cents: input.amountCents,
    from_account_id: input.fromAccountId ?? null,
    to_account_id: input.toAccountId ?? null,
    // Split transactions carry no single inline category; the legs hold the detail.
    category_id: isSplit ? null : input.categoryId ?? null,
    cleared: input.cleared ?? ClearedState.Uncleared,
    reconciled: 0,
    import_id: input.importId ?? null,
    created_at: ts,
    updated_at: ts,
    deleted_at: null,
  };
  const insertTx = db.prepare(
    `INSERT INTO transactions
       (id, date, payee, memo, amount_cents, from_account_id, to_account_id,
        category_id, cleared, reconciled, import_id, created_at, updated_at, deleted_at)
     VALUES
       (@id, @date, @payee, @memo, @amount_cents, @from_account_id, @to_account_id,
        @category_id, @cleared, @reconciled, @import_id, @created_at, @updated_at, @deleted_at)`
  );
  const run = db.transaction(() => {
    insertTx.run(row);
    if (isSplit) {
      writeSplits(
        db,
        row.id,
        input.splits as NewSplitInput[],
        owningSignedTotal(row.from_account_id, row.to_account_id, row.amount_cents),
        ts
      );
    }
  });
  withUndo("Add transaction", [], () => {
    run();
    return [row.id]; // newly created transaction id for the snapshot
  });
  return toTransaction(row);
}

export function updateTransaction(input: UpdateTransactionInput): void {
  const db = getDb();
  // Build a dynamic SET clause only for provided fields.
  const fields: string[] = [];
  const params: Record<string, unknown> = { id: input.id, updated_at: now() };

  const map: Array<[keyof UpdateTransactionInput, string]> = [
    ["date", "date"],
    ["payee", "payee"],
    ["memo", "memo"],
    ["amountCents", "amount_cents"],
    ["fromAccountId", "from_account_id"],
    ["toAccountId", "to_account_id"],
    ["categoryId", "category_id"],
    ["cleared", "cleared"],
  ];
  for (const [key, col] of map) {
    if (input[key] !== undefined) {
      fields.push(`${col} = @${col}`);
      params[col] = input[key];
    }
  }
  const ts = params.updated_at as string;
  const wantsSplits = input.splits !== undefined;
  const splitLegs = input.splits ?? [];
  const makeSplit = wantsSplits && splitLegs.length >= 2;
  // When converting to a split, clear the inline single category.
  if (makeSplit && input.categoryId === undefined) {
    fields.push("category_id = @category_id");
    params.category_id = null;
  }
  fields.push("updated_at = @updated_at");

  const run = db.transaction(() => {
    db.prepare(`UPDATE transactions SET ${fields.join(", ")} WHERE id = @id`).run(params);
    // If the date changed and this transaction is a leg of an investment lot,
    // keep the lot's own date in sync (share-as-of/history read the lot date).
    if (input.date !== undefined) {
      db.prepare(
        `UPDATE investment_transactions
            SET date = @date, updated_at = @ts
          WHERE deleted_at IS NULL
            AND (cash_txn_id = @id OR income_txn_id = @id OR fee_txn_id = @id)`
      ).run({ date: input.date, ts, id: input.id });
    }
    if (wantsSplits) {
      if (makeSplit) {
        // Read back the effective from/to/amount to compute the owning signed total.
        const cur = db
          .prepare("SELECT from_account_id, to_account_id, amount_cents FROM transactions WHERE id = ?")
          .get(input.id) as {
          from_account_id: string | null;
          to_account_id: string | null;
          amount_cents: number;
        };
        writeSplits(
          db,
          input.id,
          splitLegs,
          owningSignedTotal(cur.from_account_id, cur.to_account_id, cur.amount_cents),
          ts
        );
      } else {
        // Fewer than 2 legs => not a split: clear any existing split rows.
        db.prepare(
          "UPDATE transaction_splits SET deleted_at = ?, updated_at = ? WHERE transaction_id = ? AND deleted_at IS NULL"
        ).run(ts, ts, input.id);
      }
    }
  });
  withUndo("Edit transaction", [input.id], () => {
    run();
  });
}

/** Soft delete so the deletion can sync. */
export function deleteTransaction(id: string): void {
  const db = getDb();
  const ts = now();
  assertNotReconciled(db, [id]);
  // Affected transaction ids: this one plus any sibling legs of a linked
  // investment lot (so the undo snapshot covers the whole cascade at the
  // transaction level).
  const siblingRows = db
    .prepare(
      `SELECT cash_txn_id, income_txn_id, fee_txn_id FROM investment_transactions
        WHERE deleted_at IS NULL AND (cash_txn_id = ? OR income_txn_id = ? OR fee_txn_id = ?)`
    )
    .all(id, id, id) as Array<{
    cash_txn_id: string | null;
    income_txn_id: string | null;
    fee_txn_id: string | null;
  }>;
  const affectedTxIds = new Set<string>([id]);
  for (const r of siblingRows) {
    for (const legId of [r.cash_txn_id, r.income_txn_id, r.fee_txn_id]) {
      if (legId) affectedTxIds.add(legId);
    }
  }
  const run = db.transaction(() => {
    db.prepare("UPDATE transactions SET deleted_at = ?, updated_at = ? WHERE id = ?").run(ts, ts, id);
    db.prepare(
      "UPDATE transaction_splits SET deleted_at = ?, updated_at = ? WHERE transaction_id = ? AND deleted_at IS NULL"
    ).run(ts, ts, id);

    // If this transaction is the cash or income leg of an investment lot, deleting
    // it must also remove the lot (so computed share counts adjust) and the lot's
    // OTHER leg (so no orphaned cash/income transaction is left behind).
    const lots = db
      .prepare(
        `SELECT id, cash_txn_id, income_txn_id, fee_txn_id FROM investment_transactions
          WHERE deleted_at IS NULL AND (cash_txn_id = ? OR income_txn_id = ? OR fee_txn_id = ?)`
      )
      .all(id, id, id) as Array<{
      id: string;
      cash_txn_id: string | null;
      income_txn_id: string | null;
      fee_txn_id: string | null;
    }>;
    for (const lot of lots) {
      db.prepare(
        "UPDATE investment_transactions SET deleted_at = ?, updated_at = ? WHERE id = ?"
      ).run(ts, ts, lot.id);
      // Soft-delete the sibling leg(s) that weren't the one just deleted.
      for (const legId of [lot.cash_txn_id, lot.income_txn_id, lot.fee_txn_id]) {
        if (legId && legId !== id) {
          db.prepare(
            "UPDATE transactions SET deleted_at = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL"
          ).run(ts, ts, legId);
        }
      }
    }
  });
  withUndo("Delete transaction", Array.from(affectedTxIds), () => {
    run();
  });
}

/** Delete many transactions as a SINGLE undo step. */
export function bulkDeleteTransactions(ids: string[]): void {
  if (ids.length === 0) return;
  assertNotReconciled(getDb(), ids);
  withUndo(`Delete ${ids.length} transactions`, ids, () => {
    for (const id of ids) deleteTransaction(id); // nested: folded into this entry
  });
}

/** Throw if any of the given transactions is reconciled (protects them from deletion). */
function assertNotReconciled(db: ReturnType<typeof getDb>, ids: string[]): void {
  if (ids.length === 0) return;
  const placeholders = ids.map(() => "?").join(",");
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n FROM transactions
        WHERE deleted_at IS NULL AND reconciled != 0 AND id IN (${placeholders})`
    )
    .get(...ids) as { n: number };
  if (row.n > 0) {
    throw new Error("Reconciled transactions can't be deleted. Un-reconcile them first.");
  }
  // Also block when a split transfer leg (counterparty side) is reconciled.
  const legRow = db
    .prepare(
      `SELECT COUNT(*) AS n FROM transaction_splits
        WHERE deleted_at IS NULL AND reconciled != 0 AND transaction_id IN (${placeholders})`
    )
    .get(...ids) as { n: number };
  if (legRow.n > 0) {
    throw new Error("Reconciled transactions can't be deleted. Un-reconcile them first.");
  }
}

/**
 * Set or clear the reconciled bit for `accountId`'s side of each transaction.
 * The bit is From (1) when the account is the from-side, To (2) when it's the
 * to-side. Transactions where the account is on neither side are skipped.
 */
export function setTransactionsReconciled(ids: string[], accountId: string, reconciled: boolean): void {
  if (ids.length === 0) return;
  const db = getDb();
  const ts = now();
  withUndo(reconciled ? "Reconcile transactions" : "Un-reconcile transactions", ids, () => {
    const sel = db.prepare("SELECT from_account_id, to_account_id, reconciled FROM transactions WHERE id = ?");
    const upd = db.prepare("UPDATE transactions SET reconciled = ?, updated_at = ? WHERE id = ?");
    const legUpd = db.prepare(
      `UPDATE transaction_splits SET reconciled = ?, updated_at = ?
        WHERE transaction_id = ? AND transfer_account_id = ? AND deleted_at IS NULL`
    );
    for (const id of ids) {
      const r = sel.get(id) as { from_account_id: string | null; to_account_id: string | null; reconciled: number } | undefined;
      if (!r) continue;
      const bit = r.from_account_id === accountId ? 1 : r.to_account_id === accountId ? 2 : 0;
      if (bit !== 0) {
        // Owning side: toggle the transaction's side bit.
        const next = reconciled ? (r.reconciled | bit) : (r.reconciled & ~bit);
        upd.run(next, ts, id);
      } else {
        // Counterparty via split transfer leg(s): toggle their reconciled flag.
        legUpd.run(reconciled ? 1 : 0, ts, id, accountId);
      }
    }
  });
}

/**
 * Reconcile an account in one undo step: create any nonzero adjustment
 * transactions (marked reconciled) and mark the checked transactions reconciled.
 * Returns the number of transactions reconciled (existing checked + created).
 */
export function reconcileAccount(input: ReconcileInput): number {
  const db = getDb();
  const ts = now();
  const adjustments = (input.adjustments ?? []).filter((a) => Math.round(a.amountCents) !== 0);
  const label = "Reconcile account";
  let count = 0;
  withUndo(label, input.reconcileIds, () => {
    const created: string[] = [];
    // Adjustments are created in this account and reconciled on the side they
    // touch: an inflow (amt >= 0) arrives (to = account => To bit); an outflow
    // leaves (from = account => From bit).
    const insert = db.prepare(
      `INSERT INTO transactions
         (id, date, payee, memo, amount_cents, from_account_id, to_account_id,
          category_id, cleared, reconciled, import_id, created_at, updated_at, deleted_at)
       VALUES (@id, @date, @payee, @memo, @amount_cents, @from_account_id, @to_account_id,
               @category_id, 0, @reconciled, NULL, @created_at, @created_at, NULL)`
    );
    for (const a of adjustments) {
      const amt = Math.round(a.amountCents);
      const id = randomUUID();
      const inflow = amt >= 0;
      insert.run({
        id,
        date: a.date,
        payee: a.description ?? null,
        memo: null,
        amount_cents: Math.abs(amt),
        from_account_id: inflow ? null : input.accountId,
        to_account_id: inflow ? input.accountId : null,
        category_id: a.categoryId ?? null,
        // Reconciled on the account's side: To (2) for inflow, From (1) for outflow.
        reconciled: inflow ? 2 : 1,
        created_at: ts,
      });
      created.push(id);
      count++;
    }
    if (input.reconcileIds.length > 0) {
      // OR in the account's side bit (owner) or set the transfer leg(s) (counterparty).
      const sel = db.prepare("SELECT from_account_id, to_account_id, reconciled FROM transactions WHERE id = ?");
      const upd = db.prepare("UPDATE transactions SET reconciled = ?, updated_at = ? WHERE id = ?");
      const legUpd = db.prepare(
        `UPDATE transaction_splits SET reconciled = 1, updated_at = ?
          WHERE transaction_id = ? AND transfer_account_id = ? AND deleted_at IS NULL`
      );
      for (const id of input.reconcileIds) {
        const r = sel.get(id) as { from_account_id: string | null; to_account_id: string | null; reconciled: number } | undefined;
        if (!r) continue;
        const bit = r.from_account_id === input.accountId ? 1 : r.to_account_id === input.accountId ? 2 : 0;
        if (bit !== 0) {
          upd.run(r.reconciled | bit, ts, id);
        } else {
          legUpd.run(ts, id, input.accountId);
        }
        count++;
      }
    }
    return created; // snapshot the newly created rows for undo
  });
  return count;
}

/** Apply a set of transaction updates as a SINGLE undo step (e.g. Bulk Category). */
export function bulkUpdateTransactions(updates: UpdateTransactionInput[]): void {
  if (updates.length === 0) return;
  const ids = updates.map((u) => u.id);
  withUndo(`Update ${updates.length} transactions`, ids, () => {
    for (const u of updates) updateTransaction(u); // nested: folded into this entry
  });
}

// ---- Transaction splits ----

interface SplitRow {
  id: string;
  transaction_id: string;
  amount_cents: number;
  category_id: string | null;
  transfer_account_id: string | null;
  memo: string | null;
  reconciled: number;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

function toSplit(r: SplitRow): TransactionSplit {
  return {
    id: r.id,
    transactionId: r.transaction_id,
    amountCents: r.amount_cents,
    categoryId: r.category_id,
    transferAccountId: r.transfer_account_id,
    memo: r.memo,
    reconciled: r.reconciled ?? 0,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    deletedAt: r.deleted_at,
  };
}

/** The transaction's signed effect on its OWNING account (from/to perspective). */
function owningSignedTotal(fromAccountId: string | null, toAccountId: string | null, amountCents: number): number {
  // A split transaction has a single owning side (from XOR to). Prefer 'to' if set.
  if (toAccountId) return amountCents;
  if (fromAccountId) return -amountCents;
  return 0;
}

/**
 * Replace a transaction's split legs. Soft-deletes existing splits and inserts the
 * new ones. Enforces the invariant that split amounts sum to the transaction's
 * signed effect on its owning account. Called within the create/update flow.
 */
function writeSplits(
  db: ReturnType<typeof getDb>,
  txId: string,
  splits: NewSplitInput[],
  owningSigned: number,
  ts: string
): void {
  const sum = splits.reduce((s, leg) => s + leg.amountCents, 0);
  if (sum !== owningSigned) {
    throw new Error(
      `Split legs (${sum}) must sum to the transaction amount (${owningSigned}).`
    );
  }
  for (const leg of splits) {
    const hasCat = leg.categoryId != null;
    const hasXfer = leg.transferAccountId != null;
    if (hasCat === hasXfer) {
      throw new Error("Each split must be exactly one of a category or a transfer account.");
    }
  }
  // Soft-delete any current splits, then insert the new set.
  db.prepare(
    "UPDATE transaction_splits SET deleted_at = ?, updated_at = ? WHERE transaction_id = ? AND deleted_at IS NULL"
  ).run(ts, ts, txId);
  const ins = db.prepare(
    `INSERT INTO transaction_splits
       (id, transaction_id, amount_cents, category_id, transfer_account_id, memo, reconciled,
        created_at, updated_at, deleted_at)
     VALUES
       (@id, @transaction_id, @amount_cents, @category_id, @transfer_account_id, @memo, 0,
        @created_at, @updated_at, @deleted_at)`
  );
  for (const leg of splits) {
    ins.run({
      id: randomUUID(),
      transaction_id: txId,
      amount_cents: leg.amountCents,
      category_id: leg.categoryId ?? null,
      transfer_account_id: leg.transferAccountId ?? null,
      memo: leg.memo ?? null,
      created_at: ts,
      updated_at: ts,
      deleted_at: null,
    });
  }
}

/** Non-deleted splits for a single transaction. */
export function splitsForTransaction(txId: string): TransactionSplit[] {
  const db = getDb();
  const rows = db
    .prepare("SELECT * FROM transaction_splits WHERE transaction_id = ? AND deleted_at IS NULL")
    .all(txId) as SplitRow[];
  return rows.map(toSplit);
}

/** ALL non-deleted splits across every transaction (used by chart aggregation). */
export function allSplits(): TransactionSplit[] {
  const db = getDb();
  const rows = db
    .prepare("SELECT * FROM transaction_splits WHERE deleted_at IS NULL")
    .all() as SplitRow[];
  return rows.map(toSplit);
}

/** Map of transactionId -> non-deleted splits, for a set of transaction ids. */
export function splitsForTransactions(txIds: string[]): Map<string, TransactionSplit[]> {
  const out = new Map<string, TransactionSplit[]>();
  if (txIds.length === 0) return out;
  const db = getDb();
  const placeholders = txIds.map(() => "?").join(",");
  const rows = db
    .prepare(
      `SELECT * FROM transaction_splits
        WHERE deleted_at IS NULL AND transaction_id IN (${placeholders})`
    )
    .all(...txIds) as SplitRow[];
  for (const r of rows) {
    const list = out.get(r.transaction_id) ?? [];
    list.push(toSplit(r));
    out.set(r.transaction_id, list);
  }
  return out;
}

/** Transaction ids that have a non-deleted transfer-leg split pointing at an account. */
export function transactionIdsWithTransferSplitTo(accountId: string): string[] {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT DISTINCT transaction_id AS id FROM transaction_splits
        WHERE deleted_at IS NULL AND transfer_account_id = ?`
    )
    .all(accountId) as Array<{ id: string }>;
  return rows.map((r) => r.id);
}

/** importIds already present for an account (for import dedupe). */
export function importIdsForAccount(accountId: string): Set<string> {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT DISTINCT import_id FROM transactions
        WHERE deleted_at IS NULL AND import_id IS NOT NULL
          AND (from_account_id = ? OR to_account_id = ?)`
    )
    .all(accountId, accountId) as { import_id: string }[];
  return new Set(rows.map((r) => r.import_id));
}

/**
 * Build a map of normalized payee (lowercased, whitespace-collapsed) -> the
 * category id of the MOST RECENT categorized transaction with that payee. Used
 * to auto-categorize imported transactions by matching a prior payee. Excludes
 * deleted rows and transfers/splits (category_id null). Most-recent wins by
 * date, then created_at.
 */
export function categoryByPayee(): Map<string, string> {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT payee, category_id
         FROM transactions
        WHERE deleted_at IS NULL
          AND category_id IS NOT NULL
          AND payee IS NOT NULL AND TRIM(payee) <> ''
        ORDER BY date ASC, created_at ASC`
    )
    .all() as { payee: string; category_id: string }[];
  // Iterating oldest -> newest and overwriting means the newest wins.
  const map = new Map<string, string>();
  for (const r of rows) {
    const key = r.payee.toLowerCase().replace(/\s+/g, " ").trim();
    if (key) map.set(key, r.category_id);
  }
  return map;
}

/**
 * Insert many transactions in a single sync transaction, skipping any whose
 * importId already exists for the account. Returns the number actually inserted.
 */
export function createTransactionsBulk(inputs: NewTransactionInput[]): number {
  const db = getDb();
  const insert = db.prepare(
    `INSERT INTO transactions
       (id, date, payee, memo, amount_cents, from_account_id, to_account_id,
        category_id, cleared, import_id, created_at, updated_at, deleted_at)
     VALUES
       (@id, @date, @payee, @memo, @amount_cents, @from_account_id, @to_account_id,
        @category_id, @cleared, @import_id, @created_at, @updated_at, @deleted_at)`
  );

  const run = db.transaction((rows: NewTransactionInput[]) => {
    const ids: string[] = [];
    for (const input of rows) {
      const ts = now();
      const id = randomUUID();
      insert.run({
        id,
        date: input.date,
        payee: input.payee ?? null,
        memo: input.memo ?? null,
        amount_cents: input.amountCents,
        from_account_id: input.fromAccountId ?? null,
        to_account_id: input.toAccountId ?? null,
        category_id: input.categoryId ?? null,
        cleared: input.cleared ?? 0,
        import_id: input.importId ?? null,
        created_at: ts,
        updated_at: ts,
        deleted_at: null,
      });
      ids.push(id);
    }
    return ids;
  });

  // Whole bulk import is a single undo step.
  let count = 0;
  withUndo("Import transactions", [], () => {
    const ids = run(inputs);
    count = ids.length;
    return ids;
  });
  return count;
}

// ---- Categories ----

interface CategoryRow {
  id: string;
  name: string;
  parent_id: string | null;
  applicability: string;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

function toCategory(r: CategoryRow): Category {
  return {
    id: r.id,
    name: r.name,
    parentId: r.parent_id,
    applicability: (r.applicability as Category["applicability"]) ?? "both",
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    deletedAt: r.deleted_at,
  };
}

export function listCategories(): Category[] {
  const db = getDb();
  const rows = db
    .prepare("SELECT * FROM categories WHERE deleted_at IS NULL ORDER BY name COLLATE NOCASE")
    .all() as CategoryRow[];
  return rows.map(toCategory);
}

export function createCategory(input: NewCategoryInput): Category {
  const db = getDb();
  const ts = now();
  const row: CategoryRow = {
    id: randomUUID(),
    name: input.name,
    parent_id: input.parentId ?? null,
    applicability: input.applicability ?? "both",
    created_at: ts,
    updated_at: ts,
    deleted_at: null,
  };
  db.prepare(
    `INSERT INTO categories (id, name, parent_id, applicability, created_at, updated_at, deleted_at)
     VALUES (@id, @name, @parent_id, @applicability, @created_at, @updated_at, @deleted_at)`
  ).run(row);
  return toCategory(row);
}

export function updateCategory(input: UpdateCategoryInput): void {
  const db = getDb();
  const fields: string[] = [];
  const params: Record<string, unknown> = { id: input.id, updated_at: now() };
  const map: Array<[keyof UpdateCategoryInput, string]> = [
    ["name", "name"],
    ["parentId", "parent_id"],
    ["applicability", "applicability"],
  ];
  for (const [key, col] of map) {
    if (input[key] !== undefined) {
      fields.push(`${col} = @${col}`);
      params[col] = input[key];
    }
  }
  fields.push("updated_at = @updated_at");
  db.prepare(`UPDATE categories SET ${fields.join(", ")} WHERE id = @id`).run(params);
}

/**
 * Usage count per category id, counting only references that would prevent a safe
 * delete: non-deleted transactions, non-deleted transaction splits, non-deleted
 * recurring rules, and non-deleted child categories (deleting a parent would
 * orphan its children). Categories with a count of 0 are safe to delete.
 * Returns a map of categoryId -> count (only non-zero entries are included).
 */
export function categoryUsageCounts(): Record<string, number> {
  const db = getDb();
  const counts: Record<string, number> = {};
  const add = (id: string | null, n: number) => {
    if (!id || n <= 0) return;
    counts[id] = (counts[id] ?? 0) + n;
  };

  const tally = (sql: string) => {
    const rows = db.prepare(sql).all() as Array<{ category_id: string | null; n: number }>;
    for (const r of rows) add(r.category_id, r.n);
  };

  tally(
    `SELECT category_id, COUNT(*) AS n FROM transactions
       WHERE deleted_at IS NULL AND category_id IS NOT NULL GROUP BY category_id`
  );
  tally(
    `SELECT category_id, COUNT(*) AS n FROM transaction_splits
       WHERE deleted_at IS NULL AND category_id IS NOT NULL GROUP BY category_id`
  );
  tally(
    `SELECT category_id, COUNT(*) AS n FROM recurring_rules
       WHERE deleted_at IS NULL AND category_id IS NOT NULL GROUP BY category_id`
  );
  // Child categories: a non-deleted category whose parent_id points at the target.
  tally(
    `SELECT parent_id AS category_id, COUNT(*) AS n FROM categories
       WHERE deleted_at IS NULL AND parent_id IS NOT NULL GROUP BY parent_id`
  );

  return counts;
}

/**
 * Soft-delete a category. Throws if the category is still referenced anywhere
 * that would break referential integrity (see {@link categoryUsageCounts}), so a
 * used category can never be deleted even if the UI somehow allowed it.
 */
export function deleteCategory(id: string): void {
  const usage = categoryUsageCounts();
  if ((usage[id] ?? 0) > 0) {
    throw new Error("Cannot delete a category that is in use.");
  }
  const db = getDb();
  const ts = now();
  db.prepare("UPDATE categories SET deleted_at = ?, updated_at = ? WHERE id = ?").run(ts, ts, id);
}

/**
 * Ensure a top-level expense category with the given name exists (case-insensitive
 * match). Returns its id, creating it if absent. Used for the Escrow leg.
 */
export function ensureExpenseCategory(name: string): string {
  const existing = listCategories().find(
    (c) => c.parentId == null && c.name.toLowerCase() === name.toLowerCase()
  );
  if (existing) return existing.id;
  return createCategory({ name, applicability: "expense" }).id;
}

/**
 * Ensure the Interest category tree exists: a parent "Interest" (applicability
 * 'both') with children "Expense" (expense) and "Income" (income), giving the
 * display names Interest / Interest:Expense / Interest:Income. Idempotent —
 * matches existing categories by name (case-insensitive) and only creates the
 * missing ones. Returns the three category ids.
 */
export function ensureInterestCategories(): {
  parentId: string;
  expenseId: string;
  incomeId: string;
} {
  const all = listCategories();
  const findTop = (name: string) =>
    all.find(
      (c) => c.parentId == null && c.name.toLowerCase() === name.toLowerCase()
    );
  const findChild = (parentId: string, name: string) =>
    all.find(
      (c) => c.parentId === parentId && c.name.toLowerCase() === name.toLowerCase()
    );

  let parent = findTop("Interest");
  if (!parent) parent = createCategory({ name: "Interest", applicability: "both" });

  let expense = findChild(parent.id, "Expense");
  if (!expense)
    expense = createCategory({ name: "Expense", parentId: parent.id, applicability: "expense" });

  let income = findChild(parent.id, "Income");
  if (!income)
    income = createCategory({ name: "Income", parentId: parent.id, applicability: "income" });

  return { parentId: parent.id, expenseId: expense.id, incomeId: income.id };
}

/**
 * Compute an auto principal/interest split for a loan-payment transaction (a
 * transfer whose counterparty is a loan account). Interest is charged on the
 * loan's balance AS OF the payment date (excluding this payment) at the loan's
 * monthly rate; principal is the remainder. Ensures the Interest categories exist
 * and returns split legs signed from the OWNING (paying) account's perspective:
 *   - interest leg  -> Interest:Expense category
 *   - principal leg -> transfer to the loan account
 * Leg memos are left blank. Throws if the transaction is not a transfer to a loan.
 */
export function buildLoanPaymentSplit(txId: string): LoanPaymentSplitResult {
  const db = getDb();
  const tx = db
    .prepare("SELECT * FROM transactions WHERE id = ? AND deleted_at IS NULL")
    .get(txId) as TransactionRow | undefined;
  if (!tx) throw new Error(`Transaction not found: ${txId}`);
  if (!tx.from_account_id || !tx.to_account_id) {
    throw new Error("Auto principal/interest split requires a transfer to a loan account.");
  }

  const accounts = listAccounts();
  const from = accounts.find((a) => a.id === tx.from_account_id);
  const to = accounts.find((a) => a.id === tx.to_account_id);
  // The loan is whichever side is a loan account; the payer is the other side.
  const loan = to?.type === "loan" ? to : from?.type === "loan" ? from : null;
  const payer = loan && loan.id === tx.to_account_id ? from : to;
  if (!loan || !payer) {
    throw new Error("Auto principal/interest split requires the counterparty to be a loan account.");
  }

  // Loan balance as of the payment date, excluding this payment. The loan's
  // history includes BOTH transactions it directly owns AND transactions whose
  // transfer-leg splits point at it (e.g. prior loan payments made as splits,
  // where the loan is the split counterparty rather than the owning from/to).
  const owned = transactionsForAccount(loan.id);
  const counterpartyIds = transactionIdsWithTransferSplitTo(loan.id);
  const ownedIds = new Set(owned.map((t) => t.id));
  const extra = transactionsByIds(counterpartyIds.filter((id) => !ownedIds.has(id)));
  const loanTxns = [...owned, ...extra];
  const splitsByTx = splitsForTransactions(loanTxns.map((t) => t.id));
  const balanceAsOf = loanBalanceAsOf(loan, loanTxns, splitsByTx, tx.date, txId);

  const payment = tx.amount_cents;
  const { interestCents, principalCents, escrowCents } = computeLoanPaymentSplit(
    payment,
    balanceAsOf,
    loan.interestRateBps,
    loan.escrowPaymentCents ?? 0
  );

  const { expenseId } = ensureInterestCategories();

  // The split is owned by the paying account, where this is an outflow: legs are
  // NEGATIVE (money leaving) and sum to -payment. Leg memos are left blank.
  const splits: NewSplitInput[] = [
    // Principal -> transfer to the loan account.
    {
      amountCents: -principalCents,
      transferAccountId: loan.id,
      memo: null,
    },
    // Interest -> Interest:Expense category.
    {
      amountCents: -interestCents,
      categoryId: expenseId,
      memo: null,
    },
  ];
  // Escrow -> its own leg (only when the loan has escrow). Destination comes from
  // the loan's escrow_target: 'cat:<id>' => a category leg, 'acct:<id>' => a
  // transfer leg to that (escrow) account. When unset/invalid, fall back to an
  // auto-created 'Escrow' expense category.
  if (escrowCents > 0) {
    const target = loan.escrowTarget ?? "";
    if (target.startsWith("acct:")) {
      splits.push({ amountCents: -escrowCents, transferAccountId: target.slice(5), memo: null });
    } else if (target.startsWith("cat:")) {
      splits.push({ amountCents: -escrowCents, categoryId: target.slice(4), memo: null });
    } else {
      const escrowCatId = ensureExpenseCategory("Escrow");
      splits.push({ amountCents: -escrowCents, categoryId: escrowCatId, memo: null });
    }
  }

  return { interestCents, principalCents, escrowCents, splits };
}

/** All non-deleted accounts and categories, for JSON export. */
export function exportData(): {
  accounts: Account[];
  categories: Category[];
  recurringRules: RecurringRule[];
} {
  return {
    accounts: listAccounts(),
    categories: listCategories(),
    recurringRules: listRecurringRules(),
  };
}

/**
 * Upsert accounts and categories by id (preserving ids so transfer references
 * stay valid). Existing rows are updated; new rows are inserted. Returns counts.
 */
export function importData(data: {
  accounts?: Account[];
  categories?: Category[];
  recurringRules?: RecurringRule[];
}): { accounts: number; categories: number; recurringRules: number } {
  const db = getDb();
  const ts = now();
  let accounts = 0;
  let categories = 0;
  let recurringRules = 0;

  const upsertAccount = db.prepare(
    `INSERT INTO accounts
       (id, name, type, currency, account_code, opening_balance_cents, opening_balance_date,
        interest_rate_bps, principal_cents, term_months, escrow_payment_cents, escrow_target, created_at, updated_at, deleted_at)
     VALUES
       (@id, @name, @type, @currency, @account_code, @opening_balance_cents, @opening_balance_date,
        @interest_rate_bps, @principal_cents, @term_months, @escrow_payment_cents, @escrow_target, @created_at, @updated_at, @deleted_at)
     ON CONFLICT(id) DO UPDATE SET
       name = excluded.name, type = excluded.type, currency = excluded.currency,
       account_code = excluded.account_code,
       opening_balance_cents = excluded.opening_balance_cents,
       opening_balance_date = excluded.opening_balance_date,
       interest_rate_bps = excluded.interest_rate_bps,
       principal_cents = excluded.principal_cents,
       term_months = excluded.term_months,
       escrow_payment_cents = excluded.escrow_payment_cents,
       escrow_target = excluded.escrow_target,
       updated_at = excluded.updated_at,
       deleted_at = excluded.deleted_at`
  );

  const upsertCategory = db.prepare(
    `INSERT INTO categories (id, name, parent_id, applicability, created_at, updated_at, deleted_at)
     VALUES (@id, @name, @parent_id, @applicability, @created_at, @updated_at, @deleted_at)
     ON CONFLICT(id) DO UPDATE SET
       name = excluded.name, parent_id = excluded.parent_id,
       applicability = excluded.applicability,
       updated_at = excluded.updated_at, deleted_at = excluded.deleted_at`
  );

  const upsertRule = db.prepare(
    `INSERT INTO recurring_rules
       (id, name, amount_cents, estimate_mode, from_account_id, to_account_id, category_id,
        frequency, interval_count, start_date, end_date, day_of_month,
        created_at, updated_at, deleted_at)
     VALUES
       (@id, @name, @amount_cents, @estimate_mode, @from_account_id, @to_account_id, @category_id,
        @frequency, @interval_count, @start_date, @end_date, @day_of_month,
        @created_at, @updated_at, @deleted_at)
     ON CONFLICT(id) DO UPDATE SET
       name = excluded.name, amount_cents = excluded.amount_cents,
       estimate_mode = excluded.estimate_mode,
       from_account_id = excluded.from_account_id, to_account_id = excluded.to_account_id,
       category_id = excluded.category_id, frequency = excluded.frequency,
       interval_count = excluded.interval_count, start_date = excluded.start_date,
       end_date = excluded.end_date, day_of_month = excluded.day_of_month,
       updated_at = excluded.updated_at, deleted_at = excluded.deleted_at`
  );

  const tx = db.transaction(() => {
    for (const a of data.accounts ?? []) {
      upsertAccount.run({
        id: a.id || randomUUID(),
        name: a.name,
        type: a.type,
        currency: a.currency ?? "USD",
        account_code: a.accountCode ?? null,
        opening_balance_cents: a.openingBalanceCents ?? 0,
        opening_balance_date: a.openingBalanceDate ?? null,
        interest_rate_bps: a.interestRateBps ?? null,
        principal_cents: a.principalCents ?? null,
        term_months: a.termMonths ?? null,
        escrow_payment_cents: a.escrowPaymentCents ?? null,
        escrow_target: a.escrowTarget ?? null,
        created_at: a.createdAt ?? ts,
        updated_at: ts,
        deleted_at: a.deletedAt ?? null,
      });
      accounts++;
    }
    for (const c of data.categories ?? []) {
      upsertCategory.run({
        id: c.id || randomUUID(),
        name: c.name,
        parent_id: c.parentId ?? null,
        applicability: c.applicability ?? "both",
        created_at: c.createdAt ?? ts,
        updated_at: ts,
        deleted_at: c.deletedAt ?? null,
      });
      categories++;
    }
    // Recurring rules last: they reference accounts and categories by id.
    for (const r of data.recurringRules ?? []) {
      upsertRule.run({
        id: r.id || randomUUID(),
        name: r.name,
        amount_cents: r.amountCents ?? null,
        estimate_mode: r.estimateMode ?? "fixed",
        from_account_id: r.fromAccountId ?? null,
        to_account_id: r.toAccountId ?? null,
        category_id: r.categoryId ?? null,
        frequency: r.frequency,
        interval_count: r.intervalCount ?? 1,
        start_date: r.startDate,
        end_date: r.endDate ?? null,
        day_of_month: r.dayOfMonth ?? null,
        created_at: r.createdAt ?? ts,
        updated_at: ts,
        deleted_at: r.deletedAt ?? null,
      });
      recurringRules++;
    }
  });
  tx();
  return { accounts, categories, recurringRules };
}

// ---- Recurring rules (M4) ----

interface RuleRow {
  id: string;
  name: string;
  amount_cents: number | null;
  estimate_mode: string;
  from_account_id: string | null;
  to_account_id: string | null;
  category_id: string | null;
  frequency: string;
  interval_count: number;
  start_date: string;
  end_date: string | null;
  day_of_month: number | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

function toRule(r: RuleRow): RecurringRule {
  return {
    id: r.id,
    name: r.name,
    amountCents: r.amount_cents,
    estimateMode: r.estimate_mode as RecurringRule["estimateMode"],
    fromAccountId: r.from_account_id,
    toAccountId: r.to_account_id,
    categoryId: r.category_id,
    frequency: r.frequency as RecurringRule["frequency"],
    intervalCount: r.interval_count,
    startDate: r.start_date,
    endDate: r.end_date,
    dayOfMonth: r.day_of_month,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    deletedAt: r.deleted_at,
  };
}

export function listRecurringRules(): RecurringRule[] {
  const db = getDb();
  const rows = db
    .prepare("SELECT * FROM recurring_rules WHERE deleted_at IS NULL ORDER BY name COLLATE NOCASE")
    .all() as RuleRow[];
  return rows.map(toRule);
}

export function createRecurringRule(input: NewRecurringRuleInput): RecurringRule {
  const db = getDb();
  const ts = now();
  const row: RuleRow = {
    id: randomUUID(),
    name: input.name,
    amount_cents: input.amountCents ?? null,
    estimate_mode: input.estimateMode ?? "fixed",
    from_account_id: input.fromAccountId ?? null,
    to_account_id: input.toAccountId ?? null,
    category_id: input.categoryId ?? null,
    frequency: input.frequency,
    interval_count: input.intervalCount ?? 1,
    start_date: input.startDate,
    end_date: input.endDate ?? null,
    day_of_month: input.dayOfMonth ?? null,
    created_at: ts,
    updated_at: ts,
    deleted_at: null,
  };
  db.prepare(
    `INSERT INTO recurring_rules
       (id, name, amount_cents, estimate_mode, from_account_id, to_account_id,
        category_id, frequency, interval_count, start_date, end_date, day_of_month,
        created_at, updated_at, deleted_at)
     VALUES
       (@id, @name, @amount_cents, @estimate_mode, @from_account_id, @to_account_id,
        @category_id, @frequency, @interval_count, @start_date, @end_date, @day_of_month,
        @created_at, @updated_at, @deleted_at)`
  ).run(row);
  return toRule(row);
}

export function updateRecurringRule(input: UpdateRecurringRuleInput): void {
  const db = getDb();
  const fields: string[] = [];
  const params: Record<string, unknown> = { id: input.id, updated_at: now() };
  const map: Array<[keyof UpdateRecurringRuleInput, string]> = [
    ["name", "name"],
    ["amountCents", "amount_cents"],
    ["estimateMode", "estimate_mode"],
    ["fromAccountId", "from_account_id"],
    ["toAccountId", "to_account_id"],
    ["categoryId", "category_id"],
    ["frequency", "frequency"],
    ["intervalCount", "interval_count"],
    ["startDate", "start_date"],
    ["endDate", "end_date"],
    ["dayOfMonth", "day_of_month"],
  ];
  for (const [key, col] of map) {
    if (input[key] !== undefined) {
      fields.push(`${col} = @${col}`);
      params[col] = input[key];
    }
  }
  fields.push("updated_at = @updated_at");
  db.prepare(`UPDATE recurring_rules SET ${fields.join(", ")} WHERE id = @id`).run(params);
}

export function deleteRecurringRule(id: string): void {
  const db = getDb();
  db.prepare("UPDATE recurring_rules SET deleted_at = ?, updated_at = ? WHERE id = ?").run(
    now(),
    now(),
    id
  );
}

// ---- Assets & valuations (Phase 1) ----

interface AssetRow {
  id: string;
  account_id: string;
  name: string;
  asset_class: string;
  symbol: string | null;
  quantity_micro: number;
  metadata: string | null;
  currency: string;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

interface ValuationRow {
  id: string;
  asset_id: string;
  as_of_date: string;
  value_micros: number;
  source: string | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

function toAsset(r: AssetRow): Asset {
  return {
    id: r.id,
    accountId: r.account_id,
    name: r.name,
    assetClass: r.asset_class as Asset["assetClass"],
    symbol: r.symbol,
    quantityMicro: r.quantity_micro,
    metadata: r.metadata,
    currency: r.currency,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    deletedAt: r.deleted_at,
  };
}

function toValuation(r: ValuationRow): AssetValuation {
  return {
    id: r.id,
    assetId: r.asset_id,
    asOfDate: r.as_of_date,
    valueMicros: r.value_micros,
    source: r.source,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    deletedAt: r.deleted_at,
  };
}

/** All non-deleted assets (optionally for a single account). */
export function listAssets(accountId?: string): Asset[] {
  const db = getDb();
  const rows = accountId
    ? (db
        .prepare(
          "SELECT * FROM assets WHERE deleted_at IS NULL AND account_id = ? ORDER BY name COLLATE NOCASE"
        )
        .all(accountId) as AssetRow[])
    : (db
        .prepare("SELECT * FROM assets WHERE deleted_at IS NULL ORDER BY name COLLATE NOCASE")
        .all() as AssetRow[]);
  return rows.map(toAsset);
}

export function createAsset(input: NewAssetInput): Asset {
  const db = getDb();
  const ts = now();
  const row: AssetRow = {
    id: randomUUID(),
    account_id: input.accountId,
    name: input.name,
    asset_class: input.assetClass ?? "other",
    symbol: input.symbol ?? null,
    quantity_micro: input.quantityMicro ?? 1_000_000,
    metadata: input.metadata ?? null,
    currency: input.currency ?? "USD",
    created_at: ts,
    updated_at: ts,
    deleted_at: null,
  };
  db.prepare(
    `INSERT INTO assets
       (id, account_id, name, asset_class, symbol, quantity_micro, metadata, currency,
        created_at, updated_at, deleted_at)
     VALUES
       (@id, @account_id, @name, @asset_class, @symbol, @quantity_micro, @metadata, @currency,
        @created_at, @updated_at, @deleted_at)`
  ).run(row);
  return toAsset(row);
}

export function updateAsset(input: UpdateAssetInput): void {
  const db = getDb();
  const fields: string[] = [];
  const params: Record<string, unknown> = { id: input.id, updated_at: now() };
  const map: Array<[keyof UpdateAssetInput, string]> = [
    ["name", "name"],
    ["assetClass", "asset_class"],
    ["symbol", "symbol"],
    ["quantityMicro", "quantity_micro"],
    ["metadata", "metadata"],
    ["currency", "currency"],
  ];
  for (const [key, col] of map) {
    if (input[key] !== undefined) {
      fields.push(`${col} = @${col}`);
      params[col] = input[key];
    }
  }
  if (fields.length === 0) return;
  fields.push("updated_at = @updated_at");
  db.prepare(`UPDATE assets SET ${fields.join(", ")} WHERE id = @id`).run(params);
}

/** Soft-delete an asset and its valuations so the deletion can sync. */
export function deleteAsset(id: string): void {
  const db = getDb();
  const ts = now();
  const run = db.transaction(() => {
    db.prepare("UPDATE assets SET deleted_at = ?, updated_at = ? WHERE id = ?").run(ts, ts, id);
    db.prepare(
      "UPDATE asset_valuations SET deleted_at = ?, updated_at = ? WHERE asset_id = ? AND deleted_at IS NULL"
    ).run(ts, ts, id);
  });
  run();
}

/** Non-deleted valuations for a single asset (most recent first). */
export function valuationsForAsset(assetId: string): AssetValuation[] {
  const db = getDb();
  const rows = db
    .prepare(
      "SELECT * FROM asset_valuations WHERE deleted_at IS NULL AND asset_id = ? ORDER BY as_of_date DESC"
    )
    .all(assetId) as ValuationRow[];
  return rows.map(toValuation);
}

/** ALL non-deleted valuations, grouped by assetId (for worth computation). */
export function allValuationsByAsset(): Map<string, AssetValuation[]> {
  const db = getDb();
  const rows = db
    .prepare("SELECT * FROM asset_valuations WHERE deleted_at IS NULL")
    .all() as ValuationRow[];
  const out = new Map<string, AssetValuation[]>();
  for (const r of rows) {
    const list = out.get(r.asset_id) ?? [];
    list.push(toValuation(r));
    out.set(r.asset_id, list);
  }
  return out;
}

/**
 * Record a valuation for an asset on a date. Because (asset_id, as_of_date) is
 * UNIQUE, an existing (even soft-deleted) row for that date is updated in place
 * and revived, so re-valuing a date replaces the prior value.
 */
export function recordValuation(input: NewValuationInput): AssetValuation {
  const db = getDb();
  const ts = now();
  const existing = db
    .prepare("SELECT * FROM asset_valuations WHERE asset_id = ? AND as_of_date = ?")
    .get(input.assetId, input.asOfDate) as ValuationRow | undefined;

  if (existing) {
    db.prepare(
      `UPDATE asset_valuations
         SET value_micros = @value_micros, source = @source, updated_at = @updated_at,
             deleted_at = NULL
       WHERE id = @id`
    ).run({
      id: existing.id,
      value_micros: input.valueMicros,
      source: input.source ?? null,
      updated_at: ts,
    });
    return toValuation({
      ...existing,
      value_micros: input.valueMicros,
      source: input.source ?? null,
      updated_at: ts,
      deleted_at: null,
    });
  }

  const row: ValuationRow = {
    id: randomUUID(),
    asset_id: input.assetId,
    as_of_date: input.asOfDate,
    value_micros: input.valueMicros,
    source: input.source ?? null,
    created_at: ts,
    updated_at: ts,
    deleted_at: null,
  };
  db.prepare(
    `INSERT INTO asset_valuations
       (id, asset_id, as_of_date, value_micros, source, created_at, updated_at, deleted_at)
     VALUES
       (@id, @asset_id, @as_of_date, @value_micros, @source, @created_at, @updated_at, @deleted_at)`
  ).run(row);
  return toValuation(row);
}

/** Soft-delete a single valuation. */
export function deleteValuation(id: string): void {
  const db = getDb();
  const ts = now();
  db.prepare("UPDATE asset_valuations SET deleted_at = ?, updated_at = ? WHERE id = ?").run(
    ts,
    ts,
    id
  );
}

// ---- Investment transactions (Option A) ----

interface InvTxRow {
  id: string;
  asset_id: string;
  account_id: string;
  date: string;
  action: string;
  quantity_micro: number;
  price_micros: number;
  fees_cents: number;
  cash_cents: number;
  cash_txn_id: string | null;
  income_txn_id: string | null;
  fee_txn_id: string | null;
  memo: string | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

function toInvTx(r: InvTxRow): InvestmentTransaction {
  return {
    id: r.id,
    assetId: r.asset_id,
    accountId: r.account_id,
    date: r.date,
    action: r.action as InvestmentTransaction["action"],
    quantityMicro: r.quantity_micro,
    priceMicros: r.price_micros,
    feesCents: r.fees_cents,
    cashCents: r.cash_cents,
    cashTxnId: r.cash_txn_id,
    incomeTxnId: r.income_txn_id,
    feeTxnId: r.fee_txn_id,
    memo: r.memo,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    deletedAt: r.deleted_at,
  };
}

/** Non-deleted investment transactions for one asset (chronological). */
export function investmentTxnsForAsset(assetId: string): InvestmentTransaction[] {
  const db = getDb();
  const rows = db
    .prepare(
      "SELECT * FROM investment_transactions WHERE deleted_at IS NULL AND asset_id = ? ORDER BY date, created_at"
    )
    .all(assetId) as InvTxRow[];
  return rows.map(toInvTx);
}

/** Non-deleted investment transactions for an account. */
export function investmentTxnsForAccount(accountId: string): InvestmentTransaction[] {
  const db = getDb();
  const rows = db
    .prepare(
      "SELECT * FROM investment_transactions WHERE deleted_at IS NULL AND account_id = ? ORDER BY date, created_at"
    )
    .all(accountId) as InvTxRow[];
  return rows.map(toInvTx);
}

/** ALL non-deleted investment transactions, grouped by assetId (for worth/holdings). */
export function allInvestmentTxnsByAsset(): Map<string, InvestmentTransaction[]> {
  const db = getDb();
  const rows = db
    .prepare("SELECT * FROM investment_transactions WHERE deleted_at IS NULL")
    .all() as InvTxRow[];
  const out = new Map<string, InvestmentTransaction[]>();
  for (const r of rows) {
    const list = out.get(r.asset_id) ?? [];
    list.push(toInvTx(r));
    out.set(r.asset_id, list);
  }
  return out;
}

/**
 * Map of transactionId -> trade display info, for the given cash/income leg
 * transaction ids. Joins the linked investment lot with its asset so the ledger
 * can show ticker/name/shares/price on Buy/Sell/Dividend/Reinvest/Grant rows.
 * A single lot may map to two transaction ids (its cash leg and its income leg).
 */
export function tradeInfoByTxnId(txnIds: string[]): Map<string, LedgerTradeInfo> {
  const out = new Map<string, LedgerTradeInfo>();
  if (txnIds.length === 0) return out;
  const db = getDb();
  const placeholders = txnIds.map(() => "?").join(",");
  const rows = db
    .prepare(
      `SELECT it.action        AS action,
              it.quantity_micro AS quantity_micro,
              it.price_micros   AS price_micros,
              it.cash_txn_id    AS cash_txn_id,
              it.income_txn_id  AS income_txn_id,
              a.symbol          AS symbol,
              a.name            AS asset_name
         FROM investment_transactions it
         JOIN assets a ON a.id = it.asset_id
        WHERE it.deleted_at IS NULL
          AND (it.cash_txn_id IN (${placeholders}) OR it.income_txn_id IN (${placeholders}))`
    )
    .all(...txnIds, ...txnIds) as Array<{
    action: string;
    quantity_micro: number;
    price_micros: number;
    cash_txn_id: string | null;
    income_txn_id: string | null;
    symbol: string | null;
    asset_name: string;
  }>;
  for (const r of rows) {
    const info: LedgerTradeInfo = {
      action: r.action as LedgerTradeInfo["action"],
      symbol: r.symbol,
      assetName: r.asset_name,
      units: r.quantity_micro / MICRO,
      // price_micros is per-share micro-cents => cents = /MICRO.
      pricePerUnitCents: Math.round(r.price_micros / MICRO),
    };
    for (const id of [r.cash_txn_id, r.income_txn_id]) {
      if (id && txnIds.includes(id)) out.set(id, info);
    }
  }
  return out;
}

/**
 * Record a trade (buy/sell/dividend/reinvest/grant) atomically:
 *  1. resolve or create the asset (inline security creation),
 *  2. compute signed shares, per-share micro-cents price, and the cash effect,
 *  3. write a linked cash `transactions` row (except reinvest, which nets to 0),
 *  4. insert the investment_transactions lot,
 *  5. upsert an asset_valuations row at the trade price (for buy/sell/reinvest).
 * All in one DB transaction so shares, cash, and valuation stay consistent.
 */
export function recordTrade(input: NewTradeInput): InvestmentTransaction {
  const db = getDb();
  const ts = now();

  const run = db.transaction((): InvestmentTransaction => {
    // 1. Resolve the asset.
    let assetId = input.assetId ?? null;
    if (!assetId) {
      if (!input.newAsset) throw new Error("recordTrade requires assetId or newAsset.");
      const created = createAsset({
        accountId: input.accountId,
        name: input.newAsset.name,
        assetClass: input.newAsset.assetClass ?? "security",
        symbol: input.newAsset.symbol,
        quantityMicro: 0, // securities derive quantity from lots
      });
      assetId = created.id;
    }

    // 2. Compute micro-units, price, gross, and cash legs.
    const units = input.units ?? 0;
    const signedUnits = input.action === "sell" ? -Math.abs(units) : Math.abs(units);
    // Buy/sell/reinvest/grant carry shares; a cash 'div' does not.
    const quantityMicro = input.action === "div" ? 0 : Math.round(signedUnits * MICRO);
    // pricePerUnitCents is per-share in cents; store as micro-cents per share.
    const priceMicros =
      input.action === "div" ? 0 : Math.round((input.pricePerUnitCents ?? 0) * MICRO);
    const feesCents = Math.max(0, input.feesCents ?? 0);
    // Gross value in cents = |units| * pricePerUnitCents.
    const grossCents = Math.round(Math.abs(units) * (input.pricePerUnitCents ?? 0));
    const cashDividend = input.cashCents ?? 0;

    // Option A: when a fee category is chosen, fees become a SEPARATE categorized
    // expense leg — excluded from the trade cash leg and from cost basis. When no
    // category is chosen, fees fold into the trade cash leg and cost basis (default).
    const expenseFees = !!input.feeCategoryId && feesCents > 0;
    const tradeFeesCents = expenseFees ? 0 : feesCents;

    // The TRADE (purchase/sale) cash leg — money that moves to acquire/dispose of
    // shares (buy/grant negative, sell positive, reinvest zero, div positive).
    const tradeCents = tradeCashCents(input.action, grossCents, tradeFeesCents, cashDividend);

    // The INCOME leg — categorized money coming IN, recorded as a separate cash
    // transaction so it shows up as income. grant => grant value (gross);
    // reinvest => the reinvested dividend (gross). A cash 'div' is itself income,
    // so it is recorded as one categorized income transaction (tradeCents) and
    // needs no separate leg here.
    const incomeCents =
      input.action === "grant" || input.action === "reinvest" ? grossCents : 0;

    // Net cash effect stored on the lot for reference/reversal.
    const cashCents = tradeCents + incomeCents;

    const insertCashTxn = (
      amountCents: number,
      intoAccount: boolean,
      payee: string,
      categoryId: string | null
    ): string => {
      const cashRow: TransactionRow = {
        id: randomUUID(),
        date: input.date,
        payee,
        memo: input.memo ?? null,
        amount_cents: Math.abs(amountCents),
        from_account_id: intoAccount ? null : input.accountId,
        to_account_id: intoAccount ? input.accountId : null,
        category_id: categoryId,
        cleared: ClearedState.Uncleared,
        reconciled: 0,
        import_id: null,
        created_at: ts,
        updated_at: ts,
        deleted_at: null,
      };
      db.prepare(
        `INSERT INTO transactions
           (id, date, payee, memo, amount_cents, from_account_id, to_account_id,
            category_id, cleared, reconciled, import_id, created_at, updated_at, deleted_at)
         VALUES
           (@id, @date, @payee, @memo, @amount_cents, @from_account_id, @to_account_id,
            @category_id, @cleared, @reconciled, @import_id, @created_at, @updated_at, @deleted_at)`
      ).run(cashRow);
      return cashRow.id;
    };

    // 3. Write cash transaction(s). The lot links to the primary (trade) leg;
    // the income leg (grant/reinvest) is a separate categorized transaction.
    const label =
      input.action === "buy"
        ? "Buy"
        : input.action === "sell"
          ? "Sell"
          : input.action === "div"
            ? "Dividend"
            : input.action === "grant"
              ? "Grant"
              : input.action === "add"
                ? "Add shares"
                : "Reinvest";

    let cashTxnId: string | null = null;
    let incomeTxnId: string | null = null;
    // Income leg first (grant/reinvest): categorized money IN.
    if (incomeCents > 0) {
      const incomeLabel = input.action === "grant" ? "Grant" : "Dividend";
      incomeTxnId = insertCashTxn(incomeCents, true, incomeLabel, input.categoryId ?? null);
    }
    // Trade leg: for a cash 'div', this IS the (categorized) income; otherwise it
    // is the uncategorized purchase/sale of shares.
    if (tradeCents !== 0) {
      const intoAccount = tradeCents > 0;
      const category = input.action === "div" ? input.categoryId ?? null : null;
      cashTxnId = insertCashTxn(tradeCents, intoAccount, label, category);
    } else if (input.action === "add") {
      // 'Add shares' has no cash movement, but we record a $0 cash transaction so
      // the opening/gift/transfer-in appears as a ledger line (with the security
      // + shares in its memo). It contributes 0 to the account balance.
      cashTxnId = insertCashTxn(0, true, label, null);
    }
    // Fee leg (Option A): a separate categorized expense when a fee category is set.
    let feeTxnId: string | null = null;
    if (expenseFees) {
      // Money OUT of the account, categorized to the chosen expense category.
      feeTxnId = insertCashTxn(-feesCents, false, `${label} fee`, input.feeCategoryId ?? null);
    }

    // 4. Insert the investment_transactions lot. `fees_cents` still records the fee
    // amount for reference; cost-basis logic excludes it when fee_txn_id is set
    // (fees were expensed, not capitalized).
    const row: InvTxRow = {
      id: randomUUID(),
      asset_id: assetId,
      account_id: input.accountId,
      date: input.date,
      action: input.action,
      quantity_micro: quantityMicro,
      price_micros: priceMicros,
      fees_cents: feesCents,
      cash_cents: cashCents + (expenseFees ? -feesCents : 0),
      cash_txn_id: cashTxnId,
      income_txn_id: incomeTxnId,
      fee_txn_id: feeTxnId,
      memo: input.memo ?? null,
      created_at: ts,
      updated_at: ts,
      deleted_at: null,
    };
    db.prepare(
      `INSERT INTO investment_transactions
         (id, asset_id, account_id, date, action, quantity_micro, price_micros,
          fees_cents, cash_cents, cash_txn_id, income_txn_id, fee_txn_id, memo, created_at, updated_at, deleted_at)
       VALUES
         (@id, @asset_id, @account_id, @date, @action, @quantity_micro, @price_micros,
          @fees_cents, @cash_cents, @cash_txn_id, @income_txn_id, @fee_txn_id, @memo, @created_at, @updated_at, @deleted_at)`
    ).run(row);

    // 5. Upsert a valuation at the trade price on the transaction date, for any
    //    action that carries a per-share price (buy/sell/reinvest/grant/add).
    if (priceMicros > 0) {
      recordValuation({
        assetId,
        asOfDate: input.date,
        valueMicros: priceMicros,
        source: "trade",
      });
    }

    return toInvTx(row);
  });

  return run();
}

/**
 * Soft-delete an investment transaction and its linked cash transaction (if any),
 * so shares and cash stay consistent.
 */
export function deleteInvestmentTxn(id: string): void {
  const db = getDb();
  const ts = now();
  const run = db.transaction(() => {
    const row = db
      .prepare("SELECT cash_txn_id, income_txn_id, fee_txn_id FROM investment_transactions WHERE id = ?")
      .get(id) as
      | { cash_txn_id: string | null; income_txn_id: string | null; fee_txn_id: string | null }
      | undefined;
    db.prepare(
      "UPDATE investment_transactions SET deleted_at = ?, updated_at = ? WHERE id = ?"
    ).run(ts, ts, id);
    for (const txnId of [row?.cash_txn_id, row?.income_txn_id, row?.fee_txn_id]) {
      if (txnId) {
        db.prepare("UPDATE transactions SET deleted_at = ?, updated_at = ? WHERE id = ?").run(
          ts,
          ts,
          txnId
        );
      }
    }
  });
}

/**
 * Import normalized investment-history rows into an account as trades. Securities
 * are matched to existing assets by (case-insensitive) name within the account,
 * or created once per distinct name. Each row becomes a recordTrade(buy|sell).
 * Returns the number of trades recorded. Runs as a single DB transaction.
 */
export function commitInvestmentImport(
  accountId: string,
  rows: InvestmentImportRow[]
): number {
  const db = getDb();
  const run = db.transaction((): number => {
    // Build a name -> assetId map from existing securities in this account.
    const existing = listAssets(accountId).filter((a) => a.assetClass === "security");
    const byName = new Map<string, string>();
    for (const a of existing) byName.set(a.name.toLowerCase(), a.id);

    let count = 0;
    for (const r of rows) {
      const key = r.securityName.toLowerCase();
      let assetId = byName.get(key);
      if (!assetId) {
        const created = createAsset({
          accountId,
          name: r.securityName,
          assetClass: "security",
          // Use the (decoded) name as a provisional symbol; the user can edit it.
          symbol: r.securityName,
          quantityMicro: 0,
        });
        assetId = created.id;
        byName.set(key, assetId);
      }
      recordTrade({
        accountId,
        assetId,
        date: r.date,
        action: r.action,
        units: r.units,
        pricePerUnitCents: r.pricePerUnitCents,
        memo: r.rawType,
      });
      count++;
    }
    return count;
  });
  return run();
}

