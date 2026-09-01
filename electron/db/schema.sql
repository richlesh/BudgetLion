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
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  parent_id     TEXT REFERENCES categories(id),
  applicability TEXT NOT NULL DEFAULT 'both'  -- 'income' | 'expense' | 'both'
                  CHECK (applicability IN ('income','expense','both')),
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  deleted_at    TEXT
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

-- Split line items for a transaction (Option 1: only present when a transaction
-- is split; unsplit transactions store their single category/counterparty inline).
-- amount_cents is SIGNED relative to the owning account (the transaction's from/to
-- perspective); splits must sum to the transaction's signed effect on that account.
-- Each split is EITHER a category leg (category_id) OR a transfer leg
-- (transfer_account_id), never both.
CREATE TABLE IF NOT EXISTS transaction_splits (
  id                  TEXT PRIMARY KEY,
  transaction_id      TEXT NOT NULL REFERENCES transactions(id),
  amount_cents        INTEGER NOT NULL,               -- signed (owning-account perspective)
  category_id         TEXT REFERENCES categories(id), -- category leg, OR
  transfer_account_id TEXT REFERENCES accounts(id),   -- transfer leg (the other account)
  memo                TEXT,
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL,
  deleted_at          TEXT,
  -- Exactly one leg type per split.
  CHECK ((category_id IS NULL) <> (transfer_account_id IS NULL))
);

CREATE INDEX IF NOT EXISTS idx_split_tx       ON transaction_splits(transaction_id);
CREATE INDEX IF NOT EXISTS idx_split_transfer ON transaction_splits(transfer_account_id);

-- Recurring payment rules (M4). Occurrences are PROJECTED (computed), never stored.
CREATE TABLE IF NOT EXISTS recurring_rules (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  amount_cents    INTEGER,                        -- required for 'fixed'; null for average/last
  estimate_mode   TEXT NOT NULL DEFAULT 'fixed'   -- 'fixed' | 'average' | 'last'
                    CHECK (estimate_mode IN ('fixed','average','last')),
  from_account_id TEXT REFERENCES accounts(id),   -- money leaves here (nullable)
  to_account_id   TEXT REFERENCES accounts(id),   -- money arrives here (nullable)
  category_id     TEXT REFERENCES categories(id),
  frequency       TEXT NOT NULL                   -- 'weekly'|'biweekly'|'monthly'|'yearly'
                    CHECK (frequency IN ('weekly','biweekly','monthly','yearly')),
  interval_count  INTEGER NOT NULL DEFAULT 1,     -- every N periods
  start_date      TEXT NOT NULL,                  -- ISO date
  end_date        TEXT,                           -- ISO date or null = indefinite
  day_of_month    INTEGER,                        -- monthly/yearly anchor (1-31)
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  deleted_at      TEXT,
  CHECK (from_account_id IS NOT NULL OR to_account_id IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS idx_rule_from ON recurring_rules(from_account_id);
CREATE INDEX IF NOT EXISTS idx_rule_to   ON recurring_rules(to_account_id);
