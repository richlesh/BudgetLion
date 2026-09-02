// better-sqlite3 connection setup + schema initialization.
// Runs only in the Electron main process.

import Database from "better-sqlite3";
import { app } from "electron";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";

let db: Database.Database | null = null;

// The folder ("package") that holds the current database's files. A database is
// a directory containing `budgetlion.sqlite3` (+ -wal/-shm at runtime). Defaults
// to userData for backward compatibility with the original single-file layout.
let currentDir: string | null = null;

/** The database file name inside a database folder. */
export const DB_FILENAME = "budgetlion.sqlite3";

/** The folder currently backing the database (defaults to userData). */
export function currentDatabaseDir(): string {
  return currentDir ?? app.getPath("userData");
}

/**
 * Point the database at a new folder. Does NOT reopen; call closeDb() first and
 * getDb() afterwards (or use reopenDb) so the next getDb() opens the new file.
 */
export function setDatabaseDir(dir: string): void {
  currentDir = dir;
}

/** Resolve the on-disk path for the SQLite database file. */
function databasePath(): string {
  return join(currentDatabaseDir(), DB_FILENAME);
}

/** Absolute path to the current database file (for copy/backup operations). */
export function currentDatabaseFile(): string {
  return databasePath();
}

/** Locate schema.sql both in dev (dist-electron/electron/db) and packaged builds. */
function schemaPath(): string {
  // Compiled file sits at dist-electron/electron/db/index.js; schema.sql is copied alongside.
  return join(__dirname, "schema.sql");
}

export function getDb(): Database.Database {
  if (db) return db;

  const instance = new Database(databasePath());
  instance.pragma("journal_mode = WAL");
  instance.pragma("foreign_keys = ON");

  const schema = readFileSync(schemaPath(), "utf-8");
  instance.exec(schema);

  runMigrations(instance);
  seedDefaultCategories(instance);

  db = instance;
  return db;
}

/**
 * Lightweight, idempotent migrations for schema changes that CREATE TABLE IF NOT
 * EXISTS can't apply to pre-existing databases. Each step checks current state
 * before altering, so running it repeatedly is safe.
 */
function runMigrations(instance: Database.Database): void {
  const cols = instance
    .prepare("PRAGMA table_info(accounts)")
    .all() as Array<{ name: string }>;
  const hasOpeningDate = cols.some((c) => c.name === "opening_balance_date");
  if (!hasOpeningDate) {
    instance.exec("ALTER TABLE accounts ADD COLUMN opening_balance_date TEXT");
  }
  const hasAccountCode = cols.some((c) => c.name === "account_code");
  if (!hasAccountCode) {
    instance.exec("ALTER TABLE accounts ADD COLUMN account_code TEXT");
  }
  // Mortgage escrow portion of a loan payment (nullable INTEGER cents).
  if (!cols.some((c) => c.name === "escrow_payment_cents")) {
    instance.exec("ALTER TABLE accounts ADD COLUMN escrow_payment_cents INTEGER");
  }

  // categories.applicability: 'income' | 'expense' | 'both' (default 'both').
  const catCols = instance
    .prepare("PRAGMA table_info(categories)")
    .all() as Array<{ name: string }>;
  if (!catCols.some((c) => c.name === "applicability")) {
    instance.exec("ALTER TABLE categories ADD COLUMN applicability TEXT NOT NULL DEFAULT 'both'");
  }

  // investment_transactions.income_txn_id: link to the categorized income leg for
  // grant/reinvest (added after the table's initial release). ALTER ADD COLUMN is
  // safe here because it's a nullable column with no CHECK/constraint change.
  const invCols = instance
    .prepare("PRAGMA table_info(investment_transactions)")
    .all() as Array<{ name: string }>;
  if (invCols.length > 0 && !invCols.some((c) => c.name === "income_txn_id")) {
    instance.exec("ALTER TABLE investment_transactions ADD COLUMN income_txn_id TEXT");
  }
  if (invCols.length > 0 && !invCols.some((c) => c.name === "fee_txn_id")) {
    instance.exec("ALTER TABLE investment_transactions ADD COLUMN fee_txn_id TEXT");
  }

  // Widen investment_transactions.action CHECK to allow 'grant'. Like the accounts
  // CHECK, SQLite can't ALTER a constraint, so rebuild the table only when the
  // stored SQL still has the old (narrow) constraint. FK toggle is OUTSIDE the
  // transaction (PRAGMA foreign_keys is a no-op inside one).
  const invSql = (
    instance
      .prepare(
        "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'investment_transactions'"
      )
      .get() as { sql: string } | undefined
  )?.sql;
  if (invSql && (!invSql.includes("'grant'") || !invSql.includes("'add'"))) {
    instance.pragma("foreign_keys = OFF");
    const rebuild = instance.transaction(() => {
      instance.exec(`
        CREATE TABLE investment_transactions_new (
          id             TEXT PRIMARY KEY,
          asset_id       TEXT NOT NULL REFERENCES assets(id),
          account_id     TEXT NOT NULL REFERENCES accounts(id),
          date           TEXT NOT NULL,
          action         TEXT NOT NULL CHECK (action IN ('buy','sell','div','reinvest','grant','add')),
          quantity_micro INTEGER NOT NULL DEFAULT 0,
          price_micros   INTEGER NOT NULL DEFAULT 0,
          fees_cents     INTEGER NOT NULL DEFAULT 0,
          cash_cents     INTEGER NOT NULL DEFAULT 0,
          cash_txn_id    TEXT REFERENCES transactions(id),
          income_txn_id  TEXT REFERENCES transactions(id),
          fee_txn_id     TEXT REFERENCES transactions(id),
          memo           TEXT,
          created_at     TEXT NOT NULL,
          updated_at     TEXT NOT NULL,
          deleted_at     TEXT
        )
      `);
      instance.exec(`
        INSERT INTO investment_transactions_new
          (id, asset_id, account_id, date, action, quantity_micro, price_micros,
           fees_cents, cash_cents, cash_txn_id, income_txn_id, fee_txn_id, memo,
           created_at, updated_at, deleted_at)
        SELECT
           id, asset_id, account_id, date, action, quantity_micro, price_micros,
           fees_cents, cash_cents, cash_txn_id, income_txn_id, fee_txn_id, memo,
           created_at, updated_at, deleted_at
        FROM investment_transactions
      `);
      instance.exec("DROP TABLE investment_transactions");
      instance.exec("ALTER TABLE investment_transactions_new RENAME TO investment_transactions");
      instance.exec(
        "CREATE INDEX IF NOT EXISTS idx_invtx_asset   ON investment_transactions(asset_id, date)"
      );
      instance.exec(
        "CREATE INDEX IF NOT EXISTS idx_invtx_account ON investment_transactions(account_id, date)"
      );
      instance.exec(
        "CREATE INDEX IF NOT EXISTS idx_invtx_cash    ON investment_transactions(cash_txn_id)"
      );
    });
    try {
      rebuild();
      const violations = instance.pragma("foreign_key_check") as unknown[];
      if (violations.length > 0) {
        throw new Error(
          `investment_transactions migration left ${violations.length} foreign-key violation(s)`
        );
      }
    } finally {
      instance.pragma("foreign_keys = ON");
    }
  }

  // One-time (idempotent) cleanup of ORPHANED investment lots: a non-deleted lot
  // whose every linked cash/income transaction is deleted or missing. This can
  // happen for lots created before deleteTransaction cascaded to the lot — the
  // user deleted the cash leg from the ledger, leaving the lot (and thus its
  // computed shares) behind. Only lots with at least one leg reference and no
  // live leg are removed, so legitimately-linked lots are never touched.
  const invTableExists = instance
    .prepare(
      "SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'investment_transactions'"
    )
    .get() as { n: number };
  if (invTableExists.n > 0) {
    const ts = new Date().toISOString();
    instance
      .prepare(
        `UPDATE investment_transactions
            SET deleted_at = @ts, updated_at = @ts
          WHERE deleted_at IS NULL
            -- has at least one linked leg id
            AND (cash_txn_id IS NOT NULL OR income_txn_id IS NOT NULL OR fee_txn_id IS NOT NULL)
            -- and NO leg points to a live (non-deleted) transaction
            AND NOT EXISTS (
              SELECT 1 FROM transactions t
               WHERE t.deleted_at IS NULL
                 AND t.id IN (investment_transactions.cash_txn_id,
                              investment_transactions.income_txn_id,
                              investment_transactions.fee_txn_id)
            )`
      )
      .run({ ts });
  }
  const accountsSql = (
    instance
      .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'accounts'")
      .get() as { sql: string } | undefined
  )?.sql;
  if (accountsSql && !accountsSql.includes("'investment'")) {
    // SQLite requires the FK-rebuild dance in a specific order: PRAGMA foreign_keys
    // is a NO-OP inside a transaction, so it must be toggled OUTSIDE. See
    // https://sqlite.org/lang_altertable.html ("making other kinds of schema changes").
    // The new table keeps the name `accounts`, so child FKs remain valid after the
    // drop+rename; foreign_key_check verifies integrity before we re-enable FKs.
    instance.pragma("foreign_keys = OFF");
    const rebuild = instance.transaction(() => {
      instance.exec(`
        CREATE TABLE accounts_new (
          id                    TEXT PRIMARY KEY,
          name                  TEXT NOT NULL,
          type                  TEXT NOT NULL CHECK (type IN ('checking','savings','credit_card','loan','investment','asset')),
          currency              TEXT NOT NULL DEFAULT 'USD',
          opening_balance_cents INTEGER NOT NULL DEFAULT 0,
          opening_balance_date  TEXT,
          account_code          TEXT,
          interest_rate_bps     INTEGER,
          principal_cents       INTEGER,
          term_months           INTEGER,
          escrow_payment_cents  INTEGER,
          created_at            TEXT NOT NULL,
          updated_at            TEXT NOT NULL,
          deleted_at            TEXT
        )
      `);
      instance.exec(`
        INSERT INTO accounts_new
          (id, name, type, currency, opening_balance_cents, opening_balance_date,
           account_code, interest_rate_bps, principal_cents, term_months, escrow_payment_cents,
           created_at, updated_at, deleted_at)
        SELECT
           id, name, type, currency, opening_balance_cents, opening_balance_date,
           account_code, interest_rate_bps, principal_cents, term_months, escrow_payment_cents,
           created_at, updated_at, deleted_at
        FROM accounts
      `);
      instance.exec("DROP TABLE accounts");
      instance.exec("ALTER TABLE accounts_new RENAME TO accounts");
    });
    try {
      rebuild();
      // Verify no FK violations were introduced before turning enforcement back on.
      const violations = instance.pragma("foreign_key_check") as unknown[];
      if (violations.length > 0) {
        throw new Error(
          `accounts migration left ${violations.length} foreign-key violation(s)`
        );
      }
    } finally {
      instance.pragma("foreign_keys = ON");
    }
  }
}

/**
 * Seed a helpful default category tree on a BRAND-NEW database (only when the
 * categories table is completely empty). Never runs again after that, so it can't
 * fight user edits/deletions or re-add removed categories. Parents are created
 * first, then their children reference them.
 */
function seedDefaultCategories(instance: Database.Database): void {
  const count = (
    instance.prepare("SELECT COUNT(*) AS n FROM categories").get() as { n: number }
  ).n;
  if (count > 0) return; // existing DB — leave categories alone

  const ts = new Date().toISOString();
  const insert = instance.prepare(
    `INSERT INTO categories (id, name, parent_id, applicability, created_at, updated_at, deleted_at)
     VALUES (@id, @name, @parent_id, @applicability, @created_at, @updated_at, NULL)`
  );

  type Applic = "income" | "expense" | "both";
  const addTop = (name: string, applicability: Applic): string => {
    const id = randomUUID();
    insert.run({ id, name, parent_id: null, applicability, created_at: ts, updated_at: ts });
    return id;
  };
  const addChild = (parentId: string, name: string, applicability: Applic): void => {
    insert.run({
      id: randomUUID(),
      name,
      parent_id: parentId,
      applicability,
      created_at: ts,
      updated_at: ts,
    });
  };

  // Default tree (parent applicability + child applicabilities as specified).
  const defaults: Array<{
    name: string;
    applicability: Applic;
    children?: Array<{ name: string; applicability: Applic }>;
  }> = [
    {
      name: "Fee",
      applicability: "expense",
      children: [
        { name: "Brokerage", applicability: "expense" },
        { name: "Bank", applicability: "expense" },
        { name: "Late", applicability: "expense" },
      ],
    },
    {
      name: "Insurance",
      applicability: "expense",
      children: [
        { name: "Auto", applicability: "expense" },
        { name: "Life", applicability: "expense" },
        { name: "Home", applicability: "expense" },
      ],
    },
    { name: "Mortgage", applicability: "expense" },
    { name: "Salary", applicability: "income" },
    {
      name: "Taxes",
      applicability: "expense",
      children: [
        { name: "Federal", applicability: "expense" },
        { name: "State", applicability: "expense" },
      ],
    },
    {
      name: "Utilities",
      applicability: "expense",
      children: [
        { name: "Electric", applicability: "expense" },
        { name: "Gas", applicability: "expense" },
        { name: "Water", applicability: "expense" },
        { name: "Phone", applicability: "expense" },
        { name: "Digital", applicability: "expense" },
      ],
    },
  ];

  const seed = instance.transaction(() => {
    for (const top of defaults) {
      const parentId = addTop(top.name, top.applicability);
      for (const child of top.children ?? []) addChild(parentId, child.name, child.applicability);
    }
  });
  seed();
}

export function closeDb(): void {
  if (db) {
    db.close();
    db = null;
  }
}

/** Close the current connection so the next getDb() opens at the current dir. */
export function reopenDb(): Database.Database {
  closeDb();
  return getDb();
}
