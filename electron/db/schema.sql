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
  type                  TEXT NOT NULL CHECK (type IN ('checking','savings','credit_card','loan','investment','asset')),
  currency              TEXT NOT NULL DEFAULT 'USD',
  opening_balance_cents INTEGER NOT NULL DEFAULT 0,
  opening_balance_date  TEXT,             -- ISO 8601 date for the opening balance (nullable)
  account_code          TEXT,             -- user-specifiable Account ID (external/bank id, nullable)
  interest_rate_bps     INTEGER,          -- annual rate in basis points (nullable)
  principal_cents       INTEGER,          -- original loan principal (nullable)
  term_months           INTEGER,          -- loan term (nullable)
  escrow_payment_cents  INTEGER,          -- monthly escrow portion for a mortgage payment (nullable)
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

-- Assets (Phase 1). A thing you own whose value changes over time independently
-- of transactions: securities (stocks, funds, ETFs), real estate, vehicles,
-- collectibles, etc. Belongs to an 'investment' or 'asset' account. Securities are
-- the special case that can be priced automatically (via `symbol` in a later phase);
-- everything else is valued manually or by appraisal.
--
-- Precision: quantity is stored in MICRO-UNITS (x1,000,000) so fractional shares and
-- single indivisible assets (quantity 1.0 => 1000000) both stay integer-based. A
-- valuation's per-unit value is likewise in micro-cents-ish units (see asset_valuations),
-- and an asset's worth in cents is round(quantity_micro * value_micros / 1e12).
CREATE TABLE IF NOT EXISTS assets (
  id             TEXT PRIMARY KEY,
  account_id     TEXT NOT NULL REFERENCES accounts(id),
  name           TEXT NOT NULL,                 -- 'Primary Home', '2019 Subaru', 'VTSAX'
  asset_class    TEXT NOT NULL DEFAULT 'other'  -- 'security'|'real_estate'|'vehicle'|'collectible'|'cash'|'other'
                   CHECK (asset_class IN ('security','real_estate','vehicle','collectible','cash','other')),
  symbol         TEXT,                          -- ticker for market-priced assets (nullable)
  quantity_micro INTEGER NOT NULL DEFAULT 1000000, -- shares x1e6; 1000000 = 1.0 for single assets
  metadata       TEXT,                          -- JSON blob: address, VIN, purchase info, appraiser, notes
  currency       TEXT NOT NULL DEFAULT 'USD',
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL,
  deleted_at     TEXT
);

CREATE INDEX IF NOT EXISTS idx_asset_account ON assets(account_id);

-- Point-in-time valuations for an asset. One row per asset per date; the most
-- recent (max as_of_date) is the current per-unit value. `value_micros` is the
-- per-unit value in MICRO-CENTS (cents-per-unit x 1e6 == dollars x 100 x 1e6), so
-- worth_cents = round(quantity_micro * value_micros / 1e12). Example: 12.5 shares
-- (quantity_micro 12,500,000) at $88.40/share (value_micros 8,840,000,000) =>
-- round(12,500,000 * 8,840,000,000 / 1e12) = 110,500 cents = $1,105.00.
CREATE TABLE IF NOT EXISTS asset_valuations (
  id            TEXT PRIMARY KEY,
  asset_id      TEXT NOT NULL REFERENCES assets(id),
  as_of_date    TEXT NOT NULL,                  -- ISO 8601 date
  value_micros  INTEGER NOT NULL,               -- per-unit value in micro-cents
  source        TEXT,                           -- 'manual'|'appraisal'|'stooq'|'yahoo'|... (nullable)
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  deleted_at    TEXT,
  UNIQUE (asset_id, as_of_date)
);

CREATE INDEX IF NOT EXISTS idx_valuation_asset ON asset_valuations(asset_id, as_of_date);

-- Investment transactions (Option A): buy/sell/dividend/reinvest lots that change
-- an asset's share count and/or move cash. Holdings share counts for security-class
-- assets are COMPUTED as the signed sum of quantity_micro across these rows (never
-- stored), consistent with BudgetLion's "balances are computed" principle.
--
--   action     effect on shares         cash movement (via linked cash txn)
--   ------     ----------------         -----------------------------------
--   buy        + quantity_micro         cash OUT  = shares*price + fees
--   sell       - quantity_micro         cash IN   = shares*price - fees
--   div        0 (cash dividend)        cash IN   = cash_cents - fees
--   reinvest   + quantity_micro         0 net (dividend immediately buys shares)
--
-- price_micros is per-share in MICRO-CENTS (dollars*100*1e6), same scale as
-- asset_valuations.value_micros. fees_cents and cash_cents are integer cents.
-- cash_txn_id links to the transactions row that carries the cash leg (nullable
-- for reinvest, which nets to zero cash). Each investment transaction records a
-- valuation implicitly at its price (repository upserts asset_valuations).
CREATE TABLE IF NOT EXISTS investment_transactions (
  id             TEXT PRIMARY KEY,
  asset_id       TEXT NOT NULL REFERENCES assets(id),
  account_id     TEXT NOT NULL REFERENCES accounts(id),
  date           TEXT NOT NULL,                 -- ISO 8601 date
  action         TEXT NOT NULL                  -- 'buy'|'sell'|'div'|'reinvest'|'grant'|'add'
                   CHECK (action IN ('buy','sell','div','reinvest','grant','add')),
  quantity_micro INTEGER NOT NULL DEFAULT 0,    -- shares x1e6, signed (buy/reinvest +, sell -)
  price_micros   INTEGER NOT NULL DEFAULT 0,    -- per-share micro-cents (0 for cash div)
  fees_cents     INTEGER NOT NULL DEFAULT 0,    -- commission/fees in cents (>=0)
  cash_cents     INTEGER NOT NULL DEFAULT 0,    -- signed cash effect on the account (cents)
  cash_txn_id    TEXT REFERENCES transactions(id), -- linked cash (trade) leg (nullable)
  income_txn_id  TEXT REFERENCES transactions(id), -- linked categorized income leg (grant/reinvest, nullable)
  fee_txn_id     TEXT REFERENCES transactions(id), -- linked categorized fee expense leg (nullable)
  memo           TEXT,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL,
  deleted_at     TEXT
);

CREATE INDEX IF NOT EXISTS idx_invtx_asset   ON investment_transactions(asset_id, date);
CREATE INDEX IF NOT EXISTS idx_invtx_account ON investment_transactions(account_id, date);
CREATE INDEX IF NOT EXISTS idx_invtx_cash    ON investment_transactions(cash_txn_id);
