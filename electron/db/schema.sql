-- BudgetLion schema. Sync-ready double-entry (hybrid, Option B).
-- Design principles:
--   * UUID text primary keys (offline-safe, no autoincrement collisions across devices)
--   * created_at / updated_at ISO-8601 timestamps on every row
--   * soft deletes via deleted_at (deletions must sync too)
--   * money stored as INTEGER cents (no floating point)
--   * running balances are COMPUTED, never stored (avoids sync drift)

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS accounts (
  id                    TEXT PRIMARY KEY,
  name                  TEXT NOT NULL,
  type                  TEXT NOT NULL CHECK (type IN ('checking','savings','credit_card','loan')),
  currency              TEXT NOT NULL DEFAULT 'USD',
  opening_balance_cents INTEGER NOT NULL DEFAULT 0,
  opening_balance_date  TEXT,             -- ISO 8601 date for the opening balance (nullable)
  account_code          TEXT,             -- user-specifiable Account ID (external/bank id, nullable)
  interest_rate_bps     INTEGER,          -- annual rate in basis points (nullable)
  principal_cents       INTEGER,          -- original loan principal (nullable)
  term_months           INTEGER,          -- loan term (nullable)
  created_at            TEXT NOT NULL,
  updated_at            TEXT NOT NULL,
  deleted_at            TEXT
);

CREATE TABLE IF NOT EXISTS categories (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  parent_id  TEXT REFERENCES categories(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);

CREATE TABLE IF NOT EXISTS transactions (
  id              TEXT PRIMARY KEY,
  date            TEXT NOT NULL,                 -- ISO 8601
  payee           TEXT,
  memo            TEXT,
  amount_cents    INTEGER NOT NULL,              -- always >= 0; direction implied by from/to
  from_account_id TEXT REFERENCES accounts(id),  -- money leaves here (nullable)
  to_account_id   TEXT REFERENCES accounts(id),  -- money arrives here (nullable)
  category_id     TEXT REFERENCES categories(id),
  cleared         INTEGER NOT NULL DEFAULT 0,    -- 0 uncleared, 1 cleared, 2 reconciled
  import_id       TEXT,                          -- bank FITID for dedupe
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  deleted_at      TEXT,
  -- A transaction must touch at least one tracked account.
  CHECK (from_account_id IS NOT NULL OR to_account_id IS NOT NULL),
  CHECK (amount_cents >= 0)
);

CREATE INDEX IF NOT EXISTS idx_tx_from   ON transactions(from_account_id, date);
CREATE INDEX IF NOT EXISTS idx_tx_to     ON transactions(to_account_id, date);
CREATE INDEX IF NOT EXISTS idx_tx_import ON transactions(import_id);
CREATE INDEX IF NOT EXISTS idx_tx_date   ON transactions(date);
