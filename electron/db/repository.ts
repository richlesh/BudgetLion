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
} from "../../src/shared/types.js";
import { ClearedState } from "../../src/shared/types.js";
import { MICRO } from "../../src/shared/types.js";
import { tradeCashCents } from "../../src/core/worth.js";
import { getDb } from "./index.js";

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
    created_at: ts,
    updated_at: ts,
    deleted_at: null,
  };
  db.prepare(
    `INSERT INTO accounts
       (id, name, type, currency, account_code, opening_balance_cents, opening_balance_date,
        interest_rate_bps, principal_cents, term_months, created_at, updated_at, deleted_at)
     VALUES
       (@id, @name, @type, @currency, @account_code, @opening_balance_cents, @opening_balance_date,
        @interest_rate_bps, @principal_cents, @term_months, @created_at, @updated_at, @deleted_at)`
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
    import_id: input.importId ?? null,
    created_at: ts,
    updated_at: ts,
    deleted_at: null,
  };
  const insertTx = db.prepare(
    `INSERT INTO transactions
       (id, date, payee, memo, amount_cents, from_account_id, to_account_id,
        category_id, cleared, import_id, created_at, updated_at, deleted_at)
     VALUES
       (@id, @date, @payee, @memo, @amount_cents, @from_account_id, @to_account_id,
        @category_id, @cleared, @import_id, @created_at, @updated_at, @deleted_at)`
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
  run();
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
  run();
}

/** Soft delete so the deletion can sync. */
export function deleteTransaction(id: string): void {
  const db = getDb();
  const ts = now();
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
        `SELECT id, cash_txn_id, income_txn_id FROM investment_transactions
          WHERE deleted_at IS NULL AND (cash_txn_id = ? OR income_txn_id = ?)`
      )
      .all(id, id) as Array<{
      id: string;
      cash_txn_id: string | null;
      income_txn_id: string | null;
    }>;
    for (const lot of lots) {
      db.prepare(
        "UPDATE investment_transactions SET deleted_at = ?, updated_at = ? WHERE id = ?"
      ).run(ts, ts, lot.id);
      // Soft-delete the sibling leg(s) that weren't the one just deleted.
      for (const legId of [lot.cash_txn_id, lot.income_txn_id]) {
        if (legId && legId !== id) {
          db.prepare(
            "UPDATE transactions SET deleted_at = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL"
          ).run(ts, ts, legId);
        }
      }
    }
  });
  run();
}

// ---- Transaction splits ----

interface SplitRow {
  id: string;
  transaction_id: string;
  amount_cents: number;
  category_id: string | null;
  transfer_account_id: string | null;
  memo: string | null;
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
       (id, transaction_id, amount_cents, category_id, transfer_account_id, memo,
        created_at, updated_at, deleted_at)
     VALUES
       (@id, @transaction_id, @amount_cents, @category_id, @transfer_account_id, @memo,
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
    let count = 0;
    for (const input of rows) {
      const ts = now();
      insert.run({
        id: randomUUID(),
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
      count++;
    }
    return count;
  });

  return run(inputs);
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

// ---- Bulk import/export of accounts + categories (JSON data exchange) ----

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
        interest_rate_bps, principal_cents, term_months, created_at, updated_at, deleted_at)
     VALUES
       (@id, @name, @type, @currency, @account_code, @opening_balance_cents, @opening_balance_date,
        @interest_rate_bps, @principal_cents, @term_months, @created_at, @updated_at, @deleted_at)
     ON CONFLICT(id) DO UPDATE SET
       name = excluded.name, type = excluded.type, currency = excluded.currency,
       account_code = excluded.account_code,
       opening_balance_cents = excluded.opening_balance_cents,
       opening_balance_date = excluded.opening_balance_date,
       interest_rate_bps = excluded.interest_rate_bps,
       principal_cents = excluded.principal_cents,
       term_months = excluded.term_months,
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

    // The TRADE (purchase/sale) cash leg — money that moves to acquire/dispose of
    // shares (buy/grant negative, sell positive, reinvest zero, div positive).
    const tradeCents = tradeCashCents(input.action, grossCents, feesCents, cashDividend);

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
        import_id: null,
        created_at: ts,
        updated_at: ts,
        deleted_at: null,
      };
      db.prepare(
        `INSERT INTO transactions
           (id, date, payee, memo, amount_cents, from_account_id, to_account_id,
            category_id, cleared, import_id, created_at, updated_at, deleted_at)
         VALUES
           (@id, @date, @payee, @memo, @amount_cents, @from_account_id, @to_account_id,
            @category_id, @cleared, @import_id, @created_at, @updated_at, @deleted_at)`
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
    }

    // 4. Insert the investment_transactions lot.
    const row: InvTxRow = {
      id: randomUUID(),
      asset_id: assetId,
      account_id: input.accountId,
      date: input.date,
      action: input.action,
      quantity_micro: quantityMicro,
      price_micros: priceMicros,
      fees_cents: feesCents,
      cash_cents: cashCents,
      cash_txn_id: cashTxnId,
      income_txn_id: incomeTxnId,
      memo: input.memo ?? null,
      created_at: ts,
      updated_at: ts,
      deleted_at: null,
    };
    db.prepare(
      `INSERT INTO investment_transactions
         (id, asset_id, account_id, date, action, quantity_micro, price_micros,
          fees_cents, cash_cents, cash_txn_id, income_txn_id, memo, created_at, updated_at, deleted_at)
       VALUES
         (@id, @asset_id, @account_id, @date, @action, @quantity_micro, @price_micros,
          @fees_cents, @cash_cents, @cash_txn_id, @income_txn_id, @memo, @created_at, @updated_at, @deleted_at)`
    ).run(row);

    // 5. Upsert a valuation at the trade price (buy/sell/reinvest carry a price).
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
      .prepare("SELECT cash_txn_id, income_txn_id FROM investment_transactions WHERE id = ?")
      .get(id) as { cash_txn_id: string | null; income_txn_id: string | null } | undefined;
    db.prepare(
      "UPDATE investment_transactions SET deleted_at = ?, updated_at = ? WHERE id = ?"
    ).run(ts, ts, id);
    for (const txnId of [row?.cash_txn_id, row?.income_txn_id]) {
      if (txnId) {
        db.prepare("UPDATE transactions SET deleted_at = ?, updated_at = ? WHERE id = ?").run(
          ts,
          ts,
          txnId
        );
      }
    }
  });
  run();
}
