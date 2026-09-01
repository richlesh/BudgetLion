// better-sqlite3 connection setup + schema initialization.
// Runs only in the Electron main process.

import Database from "better-sqlite3";
import { app } from "electron";
import { readFileSync } from "node:fs";
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

  // categories.applicability: 'income' | 'expense' | 'both' (default 'both').
  const catCols = instance
    .prepare("PRAGMA table_info(categories)")
    .all() as Array<{ name: string }>;
  if (!catCols.some((c) => c.name === "applicability")) {
    instance.exec("ALTER TABLE categories ADD COLUMN applicability TEXT NOT NULL DEFAULT 'both'");
  }
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
