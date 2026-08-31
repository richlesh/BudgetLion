// Data-access layer: maps between SQLite rows and shared domain types.
// Runs only in the Electron main process.

import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import type {
  Account,
  Category,
  NewAccountInput,
  NewCategoryInput,
  NewTransactionInput,
  Transaction,
  UpdateTransactionInput,
  UpdateAccountInput,
} from "../../src/shared/types.js";
import { ClearedState } from "../../src/shared/types.js";
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

export function createTransaction(input: NewTransactionInput): Transaction {
  const db = getDb();
  const ts = now();
  const row: TransactionRow = {
    id: randomUUID(),
    date: input.date,
    payee: input.payee ?? null,
    memo: input.memo ?? null,
    amount_cents: input.amountCents,
    from_account_id: input.fromAccountId ?? null,
    to_account_id: input.toAccountId ?? null,
    category_id: input.categoryId ?? null,
    cleared: input.cleared ?? ClearedState.Uncleared,
    import_id: input.importId ?? null,
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
  ).run(row);
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
  fields.push("updated_at = @updated_at");

  db.prepare(`UPDATE transactions SET ${fields.join(", ")} WHERE id = @id`).run(params);
}

/** Soft delete so the deletion can sync. */
export function deleteTransaction(id: string): void {
  const db = getDb();
  db.prepare("UPDATE transactions SET deleted_at = ?, updated_at = ? WHERE id = ?").run(
    now(),
    now(),
    id
  );
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
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

function toCategory(r: CategoryRow): Category {
  return {
    id: r.id,
    name: r.name,
    parentId: r.parent_id,
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
    created_at: ts,
    updated_at: ts,
    deleted_at: null,
  };
  db.prepare(
    `INSERT INTO categories (id, name, parent_id, created_at, updated_at, deleted_at)
     VALUES (@id, @name, @parent_id, @created_at, @updated_at, @deleted_at)`
  ).run(row);
  return toCategory(row);
}

// ---- Bulk import/export of accounts + categories (JSON data exchange) ----

/** All non-deleted accounts and categories, for JSON export. */
export function exportData(): { accounts: Account[]; categories: Category[] } {
  return { accounts: listAccounts(), categories: listCategories() };
}

/**
 * Upsert accounts and categories by id (preserving ids so transfer references
 * stay valid). Existing rows are updated; new rows are inserted. Returns counts.
 */
export function importData(data: {
  accounts?: Account[];
  categories?: Category[];
}): { accounts: number; categories: number } {
  const db = getDb();
  const ts = now();
  let accounts = 0;
  let categories = 0;

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
    `INSERT INTO categories (id, name, parent_id, created_at, updated_at, deleted_at)
     VALUES (@id, @name, @parent_id, @created_at, @updated_at, @deleted_at)
     ON CONFLICT(id) DO UPDATE SET
       name = excluded.name, parent_id = excluded.parent_id,
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
        created_at: c.createdAt ?? ts,
        updated_at: ts,
        deleted_at: c.deletedAt ?? null,
      });
      categories++;
    }
  });
  tx();
  return { accounts, categories };
}
