#!/usr/bin/env python3
"""
BudgetLion stress-test / example data generator.

Interactive, prompt-driven tool that inserts random-but-reasonable transactions
into a BudgetLion SQLite database that you select.

Currently supports:
  0. Setup — create a NEW BudgetLion database and populate it with starting
     data captured from ~/Desktop/MyBudget (accounts + opening balances, the
     full category tree, physical Assets, and Work 401k securities with their
     share holdings), hard-coded into this program.
  1. Credit card purchases (charges only)
  2. Credit card payments (monthly statement interest on the carried balance +
     a transfer payment from a cash account, simulated month by month)
  3. Paychecks (recurring split income: gross + Federal/FICA/MO-state tax legs +
     a 401k transfer, plus a same-date SWPPX buy priced from Yahoo on that date)
  4. Mortgage/Loan payments (amortized P+I over years*12 payments at the loan
     rate; each payment splits into interest, a principal transfer to the loan,
     and an optional escrow transfer — choose no escrow for loans like auto)
  5. Escrow disbursements (yearly insurance + property-tax expenses paid out of
     the escrow account)
  6. BNPL / Installment plans (create a plan on an installment account, compute
     its installment from principal/APR/#payments, then post monthly payments
     from a funding account split into a plan-attributed principal transfer + an
     Interest:Expense leg)
  7. Transfers (recurring transfers between two tracked accounts, e.g. Checking
     -> Savings, N per month across a date range)

Design notes (verified against the BudgetLion schema/code):
  * A BudgetLion "database" is a folder (package) containing `budgetlion.sqlite3`.
  * Money is stored as INTEGER cents; `transactions.amount_cents` is always >= 0.
  * Direction is implied by from/to, NOT by sign:
      - A credit card CHARGE (spending, growing the debt) is an OUTFLOW:
          from_account_id = <card>, to_account_id = NULL
        (the app's owningSignedTotal treats this as -amount, i.e. debt grows;
         displaySign flips it to a positive charge statement-style.)
  * Every row uses a UUID text id, ISO-8601 created_at/updated_at, deleted_at NULL.
  * Running balances are COMPUTED by the app, so we only insert transactions rows.

Uses the Python standard library only (sqlite3, uuid, datetime, random).
"""

from __future__ import annotations

import json
import os
import random
import sqlite3
import sys
import urllib.parse
import urllib.request
import uuid
from dataclasses import dataclass
from datetime import date, datetime, timedelta, timezone

DB_FILENAME = "budgetlion.sqlite3"

# A tag written to transactions.import_id so a generated batch is easy to find
# and bulk-delete later (Search by payee/memo, or a manual SQL delete).
IMPORT_TAG_PREFIX = "stresstest"


# ---------------------------------------------------------------------------
# Curated payee -> category data. Fully offline; no external service needed.
# Each category maps to a list of realistic merchant names and a typical
# per-charge dollar range so generated amounts look natural per category.
# ---------------------------------------------------------------------------

@dataclass(frozen=True)
class CategorySpec:
    name: str            # BudgetLion category name (created if missing)
    payees: tuple[str, ...]
    low: float           # typical charge low (dollars)
    high: float          # typical charge high (dollars)


CATEGORY_DATA: tuple[CategorySpec, ...] = (
    CategorySpec(
        "Groceries",
        ("Whole Foods", "Trader Joe's", "Kroger", "Safeway", "Publix",
         "Aldi", "Costco", "Sprouts", "H-E-B", "Wegmans"),
        8.0, 220.0,
    ),
    CategorySpec(
        "Dining",
        ("Starbucks", "Chipotle", "Panera Bread", "Olive Garden", "Chick-fil-A",
         "Shake Shack", "Domino's Pizza", "Taco Bell", "Local Bistro", "The Corner Cafe"),
        4.0, 95.0,
    ),
    CategorySpec(
        "Gas/Fuel",
        ("Shell", "Chevron", "ExxonMobil", "BP", "Costco Gas", "Circle K", "76", "Marathon"),
        18.0, 85.0,
    ),
    CategorySpec(
        "Shopping",
        ("Amazon", "Target", "Walmart", "Best Buy", "IKEA", "Home Depot",
         "Lowe's", "Macy's", "Nordstrom", "Etsy"),
        6.0, 400.0,
    ),
    CategorySpec(
        "Entertainment",
        ("Netflix", "Spotify", "AMC Theatres", "Steam", "Hulu", "Disney+",
         "PlayStation Store", "Ticketmaster"),
        5.0, 120.0,
    ),
    CategorySpec(
        "Travel",
        ("Delta Air Lines", "United Airlines", "Marriott", "Hilton", "Airbnb",
         "Uber", "Lyft", "Hertz", "Expedia"),
        12.0, 650.0,
    ),
    CategorySpec(
        "Health",
        ("CVS Pharmacy", "Walgreens", "Rite Aid", "GNC", "24 Hour Fitness", "Planet Fitness"),
        6.0, 180.0,
    ),
    CategorySpec(
        "Utilities",  # this name matches a BudgetLion default seed category
        ("AT&T", "Verizon", "Comcast Xfinity", "T-Mobile", "City Water & Power"),
        30.0, 220.0,
    ),
)


# ---------------------------------------------------------------------------
# Setup data (Option 0). Captured from ~/Desktop/MyBudget on 2026-09-13 and
# hard-coded here so a brand-new empty database can be populated with a realistic
# starting point (accounts + opening balances, the full category tree, physical
# Assets, and Work 401k securities) without needing the source file present.
#
# Relationships are preserved via stable string KEYS (not the original UUIDs):
#   * category parent_key  -> another category's key
#   * account escrow_target 'acctkey:<name>' -> that account's key
#   * asset  account_key    -> an account's key
#   * valuation asset_key   -> an asset's key
# At insert time each row gets a fresh UUID and the keys are remapped, so setups
# are repeatable and never collide across databases.
# ---------------------------------------------------------------------------

SETUP_ACCOUNTS = [
    {"key": "Assets", "name": "Assets", "type": "asset", "currency": "USD",
     "opening_balance_cents": 0, "opening_balance_date": None, "account_code": None,
     "interest_rate_bps": None, "principal_cents": None, "term_months": None,
     "escrow_payment_cents": None, "escrow_target": None, "website_url": None,
     "notes": None, "payment_allocation": None},
    {"key": "Checking", "name": "Checking", "type": "checking", "currency": "USD",
     "opening_balance_cents": 0, "opening_balance_date": "2023-12-31", "account_code": None,
     "interest_rate_bps": None, "principal_cents": None, "term_months": None,
     "escrow_payment_cents": None, "escrow_target": None, "website_url": None,
     "notes": None, "payment_allocation": None},
    {"key": "MasterCard", "name": "MasterCard", "type": "credit_card", "currency": "USD",
     "opening_balance_cents": 0, "opening_balance_date": "2023-12-31", "account_code": None,
     "interest_rate_bps": 2799, "principal_cents": None, "term_months": None,
     "escrow_payment_cents": None, "escrow_target": None, "website_url": None,
     "notes": None, "payment_allocation": None},
    {"key": "Visa", "name": "Visa", "type": "credit_card", "currency": "USD",
     "opening_balance_cents": 0, "opening_balance_date": "2023-12-31", "account_code": None,
     "interest_rate_bps": 2999, "principal_cents": None, "term_months": None,
     "escrow_payment_cents": None, "escrow_target": None, "website_url": None,
     "notes": None, "payment_allocation": None},
    {"key": "Affirm", "name": "Affirm", "type": "installment", "currency": "USD",
     "opening_balance_cents": 0, "opening_balance_date": "2023-12-31", "account_code": None,
     "interest_rate_bps": None, "principal_cents": None, "term_months": None,
     "escrow_payment_cents": None, "escrow_target": None, "website_url": None,
     "notes": None, "payment_allocation": "per_plan"},
    {"key": "Work 401k", "name": "Work 401k", "type": "investment", "currency": "USD",
     "opening_balance_cents": 0, "opening_balance_date": "2023-12-31", "account_code": None,
     "interest_rate_bps": None, "principal_cents": None, "term_months": None,
     "escrow_payment_cents": None, "escrow_target": None, "website_url": None,
     "notes": None, "payment_allocation": None},
    {"key": "Auto", "name": "Auto", "type": "loan", "currency": "USD",
     "opening_balance_cents": -6000000, "opening_balance_date": "2024-01-13", "account_code": None,
     "interest_rate_bps": 700, "principal_cents": None, "term_months": None,
     "escrow_payment_cents": None, "escrow_target": None, "website_url": None,
     "notes": None, "payment_allocation": None},
    {"key": "Mortgage", "name": "Mortgage", "type": "loan", "currency": "USD",
     "opening_balance_cents": -50000000, "opening_balance_date": "2024-01-05", "account_code": None,
     "interest_rate_bps": 500, "principal_cents": None, "term_months": None,
     "escrow_payment_cents": 40000, "escrow_target": "acctkey:Mortgage Escrow",
     "website_url": None, "notes": None, "payment_allocation": None},
    {"key": "Mortgage Escrow", "name": "Mortgage Escrow", "type": "savings", "currency": "USD",
     "opening_balance_cents": 200000, "opening_balance_date": "2024-01-05", "account_code": None,
     "interest_rate_bps": None, "principal_cents": None, "term_months": None,
     "escrow_payment_cents": None, "escrow_target": None, "website_url": None,
     "notes": None, "payment_allocation": None},
    {"key": "Savings", "name": "Savings", "type": "savings", "currency": "USD",
     "opening_balance_cents": 0, "opening_balance_date": "2023-12-31", "account_code": None,
     "interest_rate_bps": None, "principal_cents": None, "term_months": None,
     "escrow_payment_cents": None, "escrow_target": None, "website_url": None,
     "notes": None, "payment_allocation": None},
]

# parent_key of None => top-level. Parents are inserted before children.
SETUP_CATEGORIES = [
    {"key": "Cash", "name": "Cash", "parent_key": None, "applicability": "both"},
    {"key": "Dining", "name": "Dining", "parent_key": None, "applicability": "expense"},
    {"key": "Entertainment", "name": "Entertainment", "parent_key": None, "applicability": "expense"},
    {"key": "Fee", "name": "Fee", "parent_key": None, "applicability": "expense"},
    {"key": "Gas/Fuel", "name": "Gas/Fuel", "parent_key": None, "applicability": "expense"},
    {"key": "Groceries", "name": "Groceries", "parent_key": None, "applicability": "expense"},
    {"key": "Health", "name": "Health", "parent_key": None, "applicability": "expense"},
    {"key": "Insurance", "name": "Insurance", "parent_key": None, "applicability": "expense"},
    {"key": "Investment", "name": "Investment", "parent_key": None, "applicability": "both"},
    {"key": "Mortgage", "name": "Mortgage", "parent_key": None, "applicability": "expense"},
    {"key": "Salary", "name": "Salary", "parent_key": None, "applicability": "income"},
    {"key": "Shopping", "name": "Shopping", "parent_key": None, "applicability": "expense"},
    {"key": "Taxes", "name": "Taxes", "parent_key": None, "applicability": "expense"},
    {"key": "Travel", "name": "Travel", "parent_key": None, "applicability": "expense"},
    {"key": "Utilities", "name": "Utilities", "parent_key": None, "applicability": "expense"},
    {"key": "Fee/Bank", "name": "Bank", "parent_key": "Fee", "applicability": "expense"},
    {"key": "Fee/Brokerage", "name": "Brokerage", "parent_key": "Fee", "applicability": "expense"},
    {"key": "Fee/Late", "name": "Late", "parent_key": "Fee", "applicability": "expense"},
    {"key": "Insurance/Auto", "name": "Auto", "parent_key": "Insurance", "applicability": "expense"},
    {"key": "Insurance/Home", "name": "Home", "parent_key": "Insurance", "applicability": "expense"},
    {"key": "Insurance/Life", "name": "Life", "parent_key": "Insurance", "applicability": "expense"},
    {"key": "Taxes/Federal", "name": "Federal", "parent_key": "Taxes", "applicability": "expense"},
    {"key": "Taxes/State", "name": "State", "parent_key": "Taxes", "applicability": "expense"},
    {"key": "Utilities/Digital", "name": "Digital", "parent_key": "Utilities", "applicability": "expense"},
    {"key": "Utilities/Electric", "name": "Electric", "parent_key": "Utilities", "applicability": "expense"},
    {"key": "Utilities/Gas", "name": "Gas", "parent_key": "Utilities", "applicability": "expense"},
    {"key": "Utilities/Phone", "name": "Phone", "parent_key": "Utilities", "applicability": "expense"},
    {"key": "Utilities/Water", "name": "Water", "parent_key": "Utilities", "applicability": "expense"},
]

SETUP_ASSETS = [
    {"key": "Assets::Kia SUV", "account_key": "Assets", "name": "Kia SUV",
     "asset_class": "vehicle", "symbol": None, "quantity_micro": 1000000,
     "metadata": '{"model":"EV9","serial":"VIN483483834843834","status":"held",'
                 '"purchasePriceCents":6500000,"purchaseDate":"2024-01-13"}'},
    {"key": "Assets::House", "account_key": "Assets", "name": "House",
     "asset_class": "real_estate", "symbol": None, "quantity_micro": 1000000,
     "metadata": '{"model":null,"serial":null,"status":"held",'
                 '"purchasePriceCents":55000000,"purchaseDate":"2024-01-05"}'},
    {"key": "Work 401k::S&P 500 INDEX", "account_key": "Work 401k", "name": "S&P 500 INDEX",
     "asset_class": "security", "symbol": "SWPPX", "quantity_micro": 0, "metadata": None},
    {"key": "Work 401k::AAPL", "account_key": "Work 401k", "name": "AAPL",
     "asset_class": "security", "symbol": "AAPL", "quantity_micro": 0, "metadata": None},
]

SETUP_VALUATIONS = [
    {"asset_key": "Assets::House", "as_of_date": "2024-01-05",
     "value_micros": 55000000000000, "source": "purchase"},
    {"asset_key": "Work 401k::AAPL", "as_of_date": "2023-12-31",
     "value_micros": 19253000000, "source": "trade"},
    {"asset_key": "Work 401k::S&P 500 INDEX", "as_of_date": "2023-12-31",
     "value_micros": 1218000000, "source": "trade"},
    {"asset_key": "Assets::Kia SUV", "as_of_date": "2024-01-13",
     "value_micros": 6500000000000, "source": "purchase"},
]

# Cash legs linked to the Work 401k "Add shares" investment transactions. These
# opening-holding adds carry no cash movement (amount 0), but the investment_txn
# rows require a linked cash transaction. Keyed so investment txns can remap them.
SETUP_INV_CASH_TXNS = [
    {"key": "cash:45402de9", "date": "2023-12-31", "payee": "Add shares",
     "memo": None, "amount_cents": 0, "from_account_key": None,
     "to_account_key": "Work 401k", "cleared": 0},
    {"key": "cash:ed123255", "date": "2023-12-31", "payee": "Add shares",
     "memo": None, "amount_cents": 0, "from_account_key": None,
     "to_account_key": "Work 401k", "cleared": 0},
]

# Investment transactions that establish the Work 401k share holdings. Holding
# share counts are the signed sum of quantity_micro across these rows, so without
# them the securities show 0 shares. 'add' = opening holdings (no cash movement).
SETUP_INVESTMENT_TXNS = [
    {"asset_key": "Work 401k::S&P 500 INDEX", "account_key": "Work 401k",
     "date": "2023-12-31", "action": "add", "quantity_micro": 32663000000,
     "price_micros": 1218000000, "fees_cents": 0, "cash_cents": 0,
     "cash_txn_key": "cash:ed123255", "memo": None},
    {"asset_key": "Work 401k::AAPL", "account_key": "Work 401k",
     "date": "2023-12-31", "action": "add", "quantity_micro": 234000000,
     "price_micros": 19253000000, "fees_cents": 0, "cash_cents": 0,
     "cash_txn_key": "cash:45402de9", "memo": None},
]


# ---------------------------------------------------------------------------
# Small prompt helpers
# ---------------------------------------------------------------------------

def prompt(text: str, default: str | None = None) -> str:
    suffix = f" [{default}]" if default is not None else ""
    while True:
        try:
            raw = input(f"{text}{suffix}: ").strip()
        except EOFError:
            print()
            sys.exit(1)
        if raw:
            return raw
        if default is not None:
            return default


def prompt_int(text: str, default: int | None = None, minimum: int = 1) -> int:
    while True:
        raw = prompt(text, str(default) if default is not None else None)
        try:
            value = int(raw.replace(",", ""))
        except ValueError:
            print("  Please enter a whole number.")
            continue
        if value < minimum:
            print(f"  Please enter a number >= {minimum}.")
            continue
        return value


def prompt_float(text: str, default: float | None = None, minimum: float = 0.01) -> float:
    while True:
        raw = prompt(text, str(default) if default is not None else None)
        try:
            value = float(raw.replace("$", "").replace(",", ""))
        except ValueError:
            print("  Please enter a dollar amount, e.g. 25 or 25.00.")
            continue
        if value < minimum:
            print(f"  Please enter an amount >= {minimum:.2f}.")
            continue
        return value


def prompt_date(text: str, default: str | None = None) -> date:
    while True:
        raw = prompt(text, default)
        try:
            return datetime.strptime(raw, "%Y-%m-%d").date()
        except ValueError:
            print("  Please use ISO date format YYYY-MM-DD, e.g. 2024-01-31.")


def prompt_yes_no(text: str, default: bool = True) -> bool:
    d = "Y/n" if default else "y/N"
    while True:
        raw = prompt(f"{text} ({d})", "").lower()
        if raw == "":
            return default
        if raw in ("y", "yes"):
            return True
        if raw in ("n", "no"):
            return False
        print("  Please answer y or n.")


# ---------------------------------------------------------------------------
# Database helpers
# ---------------------------------------------------------------------------

def resolve_db_path(user_path: str) -> str:
    """Accept either the .sqlite3 file or the package folder that contains it."""
    p = os.path.expanduser(user_path.strip().strip('"').strip("'"))
    if os.path.isdir(p):
        candidate = os.path.join(p, DB_FILENAME)
        if os.path.isfile(candidate):
            return candidate
        raise FileNotFoundError(f"No {DB_FILENAME} found in folder: {p}")
    if os.path.isfile(p):
        return p
    raise FileNotFoundError(f"Not found: {p}")


def now_iso() -> str:
    # ISO-8601 with milliseconds + Z, matching the app's new Date().toISOString().
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.") + \
        f"{datetime.now(timezone.utc).microsecond // 1000:03d}Z"


def list_credit_card_accounts(conn: sqlite3.Connection) -> list[sqlite3.Row]:
    return conn.execute(
        """
        SELECT id, name, type, opening_balance_cents
        FROM accounts
        WHERE type = 'credit_card' AND deleted_at IS NULL
        ORDER BY name
        """
    ).fetchall()


def select_account(conn: sqlite3.Connection) -> sqlite3.Row:
    accounts = list_credit_card_accounts(conn)
    if not accounts:
        print("No credit card accounts found in this database. Create one in "
              "BudgetLion first, then re-run.")
        sys.exit(1)
    print("\nCredit card accounts:")
    for i, a in enumerate(accounts, start=1):
        print(f"  {i}. {a['name']}")
    while True:
        choice = prompt_int("Select an account by number", default=1, minimum=1)
        if 1 <= choice <= len(accounts):
            return accounts[choice - 1]
        print(f"  Please choose 1..{len(accounts)}.")


def list_accounts(conn: sqlite3.Connection,
                  types: tuple[str, ...] | None = None) -> list[sqlite3.Row]:
    """List non-deleted accounts, optionally filtered to specific account types."""
    cols = ("id, name, type, opening_balance_cents, opening_balance_date, "
            "interest_rate_bps, escrow_payment_cents, escrow_target")
    if types:
        placeholders = ",".join("?" for _ in types)
        return conn.execute(
            f"""
            SELECT {cols}
            FROM accounts
            WHERE deleted_at IS NULL AND type IN ({placeholders})
            ORDER BY name
            """,
            types,
        ).fetchall()
    return conn.execute(
        f"""
        SELECT {cols}
        FROM accounts
        WHERE deleted_at IS NULL
        ORDER BY name
        """
    ).fetchall()


def select_account_from(conn: sqlite3.Connection, label: str,
                        types: tuple[str, ...] | None = None) -> sqlite3.Row:
    """Prompt the user to choose one account (optionally filtered by type)."""
    accounts = list_accounts(conn, types)
    if not accounts:
        kinds = "/".join(types) if types else "any"
        print(f"No {kinds} accounts found in this database. Create one in "
              "BudgetLion first, then re-run.")
        sys.exit(1)
    print(f"\n{label}:")
    for i, a in enumerate(accounts, start=1):
        print(f"  {i}. {a['name']}  ({a['type']})")
    while True:
        choice = prompt_int("Select an account by number", default=1, minimum=1)
        if 1 <= choice <= len(accounts):
            return accounts[choice - 1]
        print(f"  Please choose 1..{len(accounts)}.")


def select_account_optional(conn: sqlite3.Connection, label: str,
                            types: tuple[str, ...] | None = None) -> sqlite3.Row | None:
    """Like select_account_from, but offers a '0. None' choice (returns None)."""
    accounts = list_accounts(conn, types)
    if not accounts:
        return None
    print(f"\n{label}:")
    print("  0. None")
    for i, a in enumerate(accounts, start=1):
        print(f"  {i}. {a['name']}  ({a['type']})")
    while True:
        choice = prompt_int("Select an account by number", default=0, minimum=0)
        if choice == 0:
            return None
        if 1 <= choice <= len(accounts):
            return accounts[choice - 1]
        print(f"  Please choose 0..{len(accounts)}.")


def balance_cents_asof(conn: sqlite3.Connection, account_id: str,
                       opening_balance_cents: int, opening_balance_date: str | None,
                       as_of: date) -> int:
    """Signed balance for an account through and including `as_of` (storage sign).

    Mirrors the app's convention: +amount when the account is the to-side (inflow),
    -amount when it is the from-side (outflow); plus the opening balance if its date
    is on or before `as_of`. Also folds in transfer split legs pointing at this
    account (rare for generated data, included for correctness).
    """
    iso = as_of.isoformat()
    total = 0
    if opening_balance_cents and (opening_balance_date is None
                                  or opening_balance_date <= iso):
        total += opening_balance_cents

    row = conn.execute(
        """
        SELECT
          COALESCE(SUM(CASE WHEN to_account_id   = ? THEN  amount_cents ELSE 0 END), 0)
        + COALESCE(SUM(CASE WHEN from_account_id = ? THEN -amount_cents ELSE 0 END), 0)
          AS bal
        FROM transactions
        WHERE deleted_at IS NULL AND date <= ?
          AND (from_account_id = ? OR to_account_id = ?)
        """,
        (account_id, account_id, iso, account_id, account_id),
    ).fetchone()
    total += int(row["bal"] or 0)

    # Transfer split legs whose counterparty is this account contribute their leg
    # amount from the counterparty's perspective; a leg amount is signed from the
    # OWNING account, so its effect on THIS account is the negation.
    leg = conn.execute(
        """
        SELECT COALESCE(SUM(-s.amount_cents), 0) AS bal
        FROM transaction_splits s
        JOIN transactions t ON t.id = s.transaction_id
        WHERE s.deleted_at IS NULL AND t.deleted_at IS NULL
          AND s.transfer_account_id = ? AND t.date <= ?
        """,
        (account_id, iso),
    ).fetchone()
    total += int(leg["bal"] or 0)
    return total


def ensure_interest_expense_category(conn: sqlite3.Connection) -> str:
    """Return the id of the Interest:Expense category, creating the tree if needed.

    Mirrors the app's ensureInterestCategories: a top-level 'Interest' (applicability
    'both') with an 'Expense' child (applicability 'expense'), matched
    case-insensitively so we reuse the app's own categories when present.
    """
    rows = conn.execute(
        "SELECT id, name, parent_id FROM categories WHERE deleted_at IS NULL"
    ).fetchall()
    parent = next((r for r in rows
                   if r["parent_id"] is None and (r["name"] or "").lower() == "interest"),
                  None)
    ts = now_iso()
    if parent is None:
        parent_id = str(uuid.uuid4())
        conn.execute(
            """INSERT INTO categories
               (id, name, parent_id, applicability, created_at, updated_at, deleted_at)
               VALUES (?, 'Interest', NULL, 'both', ?, ?, NULL)""",
            (parent_id, ts, ts),
        )
    else:
        parent_id = parent["id"]

    expense = next((r for r in rows
                    if r["parent_id"] == parent_id
                    and (r["name"] or "").lower() == "expense"), None)
    if expense is not None:
        return expense["id"]
    expense_id = str(uuid.uuid4())
    conn.execute(
        """INSERT INTO categories
           (id, name, parent_id, applicability, created_at, updated_at, deleted_at)
           VALUES (?, 'Expense', ?, 'expense', ?, ?, NULL)""",
        (expense_id, parent_id, ts, ts),
    )
    return expense_id


def ensure_categories(conn: sqlite3.Connection, specs: tuple[CategorySpec, ...],
                      dry_run: bool) -> dict[str, str]:
    """Return {category_name: category_id}, creating any missing expense categories.

    Matches existing categories by name (case-insensitive), reusing them so we
    never duplicate. New ones are created with applicability='expense', mirroring
    the app's own insert shape.
    """
    existing = {
        (row["name"] or "").lower(): row["id"]
        for row in conn.execute(
            "SELECT id, name FROM categories WHERE deleted_at IS NULL"
        ).fetchall()
    }
    result: dict[str, str] = {}
    ts = now_iso()
    for spec in specs:
        key = spec.name.lower()
        if key in existing:
            result[spec.name] = existing[key]
            continue
        new_id = str(uuid.uuid4())
        result[spec.name] = new_id
        if not dry_run:
            conn.execute(
                """
                INSERT INTO categories
                    (id, name, parent_id, applicability, created_at, updated_at, deleted_at)
                VALUES (?, ?, NULL, 'expense', ?, ?, NULL)
                """,
                (new_id, spec.name, ts, ts),
            )
        existing[key] = new_id  # so repeats in this run reuse it
    return result


# ---------------------------------------------------------------------------
# Generation
# ---------------------------------------------------------------------------

@dataclass
class GenParams:
    account_id: str
    account_name: str
    count: int
    start: date
    end: date
    amount_min: float
    amount_max: float
    seed: int | None


def random_date_in_range(rng: random.Random, start: date, end: date) -> date:
    span = (end - start).days
    return start + timedelta(days=rng.randint(0, span))


def pick_amount_cents(rng: random.Random, spec: CategorySpec,
                      floor_cents: int, ceil_cents: int) -> int:
    """Pick a natural-looking amount for the category, clamped to the user range.

    Uses a triangular distribution over the category's typical range (biased low,
    like real spending), then clamps into the user's overall [min, max] window.
    """
    lo = max(spec.low, floor_cents / 100.0)
    hi = min(spec.high, ceil_cents / 100.0)
    if lo > hi:
        # Category window falls entirely outside the user range: fall back to the
        # user range directly.
        lo, hi = floor_cents / 100.0, ceil_cents / 100.0
    mode = lo + (hi - lo) * 0.35
    dollars = rng.triangular(lo, hi, mode)
    cents = int(round(dollars * 100))
    return max(floor_cents, min(ceil_cents, cents))


def generate_rows(params: GenParams) -> list[tuple]:
    rng = random.Random(params.seed)
    floor_cents = int(round(params.amount_min * 100))
    ceil_cents = int(round(params.amount_max * 100))
    batch_tag = f"{IMPORT_TAG_PREFIX}-{uuid.uuid4().hex[:8]}"
    rows: list[tuple] = []
    for _ in range(params.count):
        spec = rng.choice(CATEGORY_DATA)
        payee = rng.choice(spec.payees)
        amount_cents = pick_amount_cents(rng, spec, floor_cents, ceil_cents)
        d = random_date_in_range(rng, params.start, params.end)
        ts = now_iso()
        # Credit card charge = OUTFLOW: from = card, to = NULL.
        rows.append((
            str(uuid.uuid4()),          # id
            d.isoformat(),              # date
            payee,                      # payee
            None,                       # memo
            amount_cents,               # amount_cents (>= 0)
            params.account_id,          # from_account_id (card)
            None,                       # to_account_id
            spec.name,                  # (placeholder) resolved to category_id later
            1,                          # cleared = cleared
            0,                          # reconciled
            batch_tag,                  # import_id
            ts, ts,                     # created_at, updated_at
        ))
    return rows, batch_tag


def insert_rows(conn: sqlite3.Connection, rows: list[tuple],
                category_ids: dict[str, str]) -> None:
    sql = """
        INSERT INTO transactions
            (id, date, payee, memo, amount_cents, from_account_id, to_account_id,
             category_id, cleared, reconciled, import_id, created_at, updated_at, deleted_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
    """
    prepared = []
    for r in rows:
        (rid, d, payee, memo, amt, from_id, to_id, cat_name,
         cleared, reconciled, import_id, created, updated) = r
        prepared.append((
            rid, d, payee, memo, amt, from_id, to_id,
            category_ids[cat_name], cleared, reconciled, import_id, created, updated,
        ))
    conn.executemany(sql, prepared)


# ---------------------------------------------------------------------------
# Flows
# ---------------------------------------------------------------------------

def credit_card_purchases_flow() -> None:
    print("\n=== Credit card purchases ===")
    db_input = prompt("Path to the BudgetLion database (folder or "
                      f"{DB_FILENAME})")
    try:
        db_path = resolve_db_path(db_input)
    except FileNotFoundError as e:
        print(f"  {e}")
        return

    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    try:
        account = select_account(conn)

        count = prompt_int("How many transactions to create", default=100)
        start = prompt_date("Start date (YYYY-MM-DD)", default="2024-01-01")
        end = prompt_date("End date (YYYY-MM-DD)", default=date.today().isoformat())
        if end < start:
            print("  End date is before start date; swapping them.")
            start, end = end, start
        amount_min = prompt_float("Minimum charge amount", default=2.0)
        amount_max = prompt_float("Maximum charge amount", default=400.0)
        if amount_max < amount_min:
            print("  Max is below min; swapping them.")
            amount_min, amount_max = amount_max, amount_min
        seed_raw = prompt("Random seed for reproducibility (blank = random)", default="")
        seed = int(seed_raw) if seed_raw.strip() else None

        params = GenParams(
            account_id=account["id"],
            account_name=account["name"],
            count=count,
            start=start,
            end=end,
            amount_min=amount_min,
            amount_max=amount_max,
            seed=seed,
        )

        rows, batch_tag = generate_rows(params)

        # Summary
        total_cents = sum(r[4] for r in rows)
        print("\n--- Summary ---")
        print(f"  Account:   {params.account_name}")
        print(f"  Count:     {params.count} charges")
        print(f"  Dates:     {params.start} .. {params.end}")
        print(f"  Amounts:   ${params.amount_min:,.2f} .. ${params.amount_max:,.2f}")
        print(f"  Total:     ${total_cents / 100:,.2f} of charges")
        print(f"  Batch tag: {batch_tag} (stored in import_id)")
        print("\n  Sample:")
        for r in rows[:5]:
            print(f"    {r[1]}  {r[2]:<22}  ${r[4] / 100:>8,.2f}  [{r[7]}]")
        if len(rows) > 5:
            print(f"    ... and {len(rows) - 5} more")

        if not prompt_yes_no("\nInsert these transactions now?", default=False):
            print("Aborted. Nothing was written.")
            return

        category_ids = ensure_categories(conn, CATEGORY_DATA, dry_run=False)
        with conn:  # single atomic transaction
            insert_rows(conn, rows, category_ids)
        print(f"\nDone. Inserted {len(rows)} charges into '{params.account_name}'.")
        print(f"To remove this batch later, delete transactions where "
              f"import_id = '{batch_tag}'.")
    finally:
        conn.close()


# ---------------------------------------------------------------------------
# Month / date helpers for the payments simulation
# ---------------------------------------------------------------------------

def clamp_day(year: int, month: int, day: int) -> date:
    """Return a valid date, clamping the day to the month's last day (e.g. 31 -> 30/28)."""
    if month == 12:
        first_next = date(year + 1, 1, 1)
    else:
        first_next = date(year, month + 1, 1)
    last_day = (first_next - timedelta(days=1)).day
    return date(year, month, min(day, last_day))


def add_month(year: int, month: int) -> tuple[int, int]:
    """Return (year, month) advanced by one month."""
    return (year + 1, 1) if month == 12 else (year, month + 1)


def prompt_day_of_month(text: str, default: int) -> int:
    while True:
        value = prompt_int(text, default=default, minimum=1)
        if 1 <= value <= 31:
            return value
        print("  Please enter a day between 1 and 31.")


def prompt_percent(text: str, default: float) -> float:
    while True:
        raw = prompt(text, str(default)).replace("%", "").strip()
        try:
            value = float(raw)
        except ValueError:
            print("  Please enter a percentage, e.g. 25 for 25%.")
            continue
        if 0 < value <= 100:
            return value
        print("  Please enter a percentage in (0, 100].")


def prompt_percent_or_zero(text: str, default: float) -> float:
    """Like prompt_percent but allows 0 (for interest-free / 0% APR plans)."""
    while True:
        raw = prompt(text, str(default)).replace("%", "").strip()
        try:
            value = float(raw)
        except ValueError:
            print("  Please enter a percentage, e.g. 0 or 15 for 15%.")
            continue
        if 0 <= value <= 100:
            return value
        print("  Please enter a percentage in [0, 100].")


def credit_card_payments_flow() -> None:
    print("\n=== Credit card payments ===")
    db_input = prompt("Path to the BudgetLion database (folder or "
                      f"{DB_FILENAME})")
    try:
        db_path = resolve_db_path(db_input)
    except FileNotFoundError as e:
        print(f"  {e}")
        return

    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    conn.isolation_level = None  # autocommit; we manage BEGIN/COMMIT explicitly
    conn.execute("PRAGMA foreign_keys = ON")
    try:
        # Accounts: pay FROM a cash account, TO the credit card.
        from_acct = select_account_from(
            conn, "Pay FROM which account (e.g. Checking)",
            types=("checking", "savings"),
        )
        card = select_account_from(
            conn, "Pay which credit card", types=("credit_card",),
        )
        if card["id"] == from_acct["id"]:
            print("  The from and card accounts must differ.")
            return

        # APR: use the card's stored rate, else prompt.
        rate_bps = card["interest_rate_bps"]
        if rate_bps is None:
            apr_pct = prompt_percent(
                f"'{card['name']}' has no interest rate set. Enter its APR "
                "(annual %)", default=19.99,
            )
            rate_bps = apr_pct * 100.0  # percent -> basis points
        monthly_rate = (rate_bps / 100.0 / 100.0) / 12.0  # bps -> fraction -> per-month
        print(f"  Using APR {rate_bps / 100.0:.3f}% "
              f"(monthly {monthly_rate * 100:.4f}%).")

        # Schedule inputs.
        statement_day = prompt_day_of_month(
            "Statement day of month (balance closes)", default=1)
        payment_day = prompt_day_of_month(
            "Payment day of month (paid the month AFTER the statement)", default=1)
        pay_pct = prompt_percent(
            "Percentage of the statement balance to pay each month", default=100.0)

        # Month range to simulate.
        start = prompt_date("Start month (any date in it, YYYY-MM-DD)",
                            default="2024-01-01")
        end = prompt_date("End month (any date in it, YYYY-MM-DD)",
                          default=date.today().isoformat())
        if (end.year, end.month) < (start.year, start.month):
            print("  End month is before start month; swapping them.")
            start, end = end, start

        batch_tag = f"{IMPORT_TAG_PREFIX}pay-{uuid.uuid4().hex[:8]}"

        # Simulate month by month. We insert as we go (within one transaction) so
        # each month's statement balance reflects the prior month's interest and
        # payment. Interest is charged on the balance carried over (unpaid) from
        # the previous month; the FIRST month has no prior carryover => no interest.
        interest_rows: list[tuple] = []   # card interest charges (from=card)
        payment_rows: list[tuple] = []    # transfers (from=checking, to=card)

        y, m = start.year, start.month
        prev_carryover_debt = 0           # positive dollars of debt carried unpaid
        first = True
        months_done = 0
        total_interest = 0
        total_paid = 0

        run = conn  # alias
        run.execute("BEGIN")
        try:
            interest_cat_id = ensure_interest_expense_category(run)
            while (y, m) <= (end.year, end.month):
                stmt_date = clamp_day(y, m, statement_day)
                ts = now_iso()

                # 1) Interest charge on the statement date for last month's unpaid
                #    balance (skip the first month).
                if not first and prev_carryover_debt > 0:
                    interest_cents = int(round(prev_carryover_debt * monthly_rate))
                    if interest_cents > 0:
                        rid = str(uuid.uuid4())
                        run.execute(
                            """INSERT INTO transactions
                               (id, date, payee, memo, amount_cents, from_account_id,
                                to_account_id, category_id, cleared, reconciled,
                                import_id, created_at, updated_at, deleted_at)
                               VALUES (?, ?, ?, ?, ?, ?, NULL, ?, 1, 0, ?, ?, ?, NULL)""",
                            (rid, stmt_date.isoformat(), "Interest Charge",
                             "Carried balance interest", interest_cents,
                             card["id"], interest_cat_id, batch_tag, ts, ts),
                        )
                        interest_rows.append((stmt_date.isoformat(), interest_cents))
                        total_interest += interest_cents

                # 2) Statement balance = card debt as of the statement date
                #    (includes charges already in the DB + interest just posted).
                bal = balance_cents_asof(
                    run, card["id"], card["opening_balance_cents"],
                    card["opening_balance_date"], stmt_date)
                statement_debt = -bal  # debt is stored negative; make positive
                if statement_debt < 0:
                    statement_debt = 0  # credit balance: nothing to pay

                # 3) Payment on the payment day of the FOLLOWING month. Skip it
                #    when it would fall past the requested end date (the last
                #    statement's payment lands in the month after `end`).
                py, pm = add_month(y, m)
                pay_date = clamp_day(py, pm, payment_day)
                pay_cents = int(round(statement_debt * (pay_pct / 100.0)))
                if pay_cents > 0 and pay_date <= end:
                    rid = str(uuid.uuid4())
                    ts2 = now_iso()
                    run.execute(
                        """INSERT INTO transactions
                           (id, date, payee, memo, amount_cents, from_account_id,
                            to_account_id, category_id, cleared, reconciled,
                            import_id, created_at, updated_at, deleted_at)
                           VALUES (?, ?, ?, NULL, ?, ?, ?, NULL, 1, 0, ?, ?, ?, NULL)""",
                        (rid, pay_date.isoformat(),
                         f"Payment To {card['name']}", pay_cents,
                         from_acct["id"], card["id"], batch_tag, ts2, ts2),
                    )
                    payment_rows.append((pay_date.isoformat(), pay_cents))
                    total_paid += pay_cents

                # 4) Carry the unpaid remainder into next month's interest base.
                prev_carryover_debt = max(0, statement_debt - pay_cents)
                first = False
                months_done += 1
                y, m = add_month(y, m)

            # Summary before committing.
            print("\n--- Summary ---")
            print(f"  From:            {from_acct['name']}")
            print(f"  Card:            {card['name']}")
            print(f"  Months:          {months_done} "
                  f"({start.year}-{start.month:02d} .. {end.year}-{end.month:02d})")
            print(f"  Statement day:   {statement_day}   Payment day: "
                  f"{payment_day} (following month)")
            print(f"  Pay percent:     {pay_pct:g}%")
            print(f"  Interest txns:   {len(interest_rows)}  "
                  f"totaling ${total_interest / 100:,.2f}")
            print(f"  Payment txns:    {len(payment_rows)}  "
                  f"totaling ${total_paid / 100:,.2f}")
            print(f"  Batch tag:       {batch_tag} (stored in import_id)")
            if payment_rows[:3] or interest_rows[:3]:
                print("\n  First few:")
                for d, c in interest_rows[:3]:
                    print(f"    {d}  Interest Charge     ${c / 100:>8,.2f}")
                for d, c in payment_rows[:3]:
                    print(f"    {d}  Payment             ${c / 100:>8,.2f}")

            if not prompt_yes_no("\nCommit these transactions now?", default=False):
                run.execute("ROLLBACK")
                print("Aborted. Nothing was written.")
                return
            run.execute("COMMIT")
        except Exception:
            run.execute("ROLLBACK")
            raise

        print(f"\nDone. Inserted {len(interest_rows)} interest charges and "
              f"{len(payment_rows)} payments.")
        print(f"To remove this batch later, delete transactions where "
              f"import_id = '{batch_tag}'.")
    finally:
        conn.close()


# ---------------------------------------------------------------------------
# Option 3: Paychecks. Generates a recurring paycheck as ONE split income
# transaction (gross income leg + tax deduction legs + a 401k transfer leg),
# plus a same-date SWPPX buy in the 401k for the transferred amount (shares
# derived from the Yahoo closing price on that date).
# ---------------------------------------------------------------------------

# Reasonable withholding rates applied to gross pay:
FICA_RATE = 0.0765          # Social Security 6.2% + Medicare 1.45%
FEDERAL_RATE = 0.12         # reasonable effective federal withholding
MISSOURI_STATE_RATE = 0.04  # reasonable effective MO state withholding


def fetch_yahoo_close_cents(symbol: str, on_date: date) -> tuple[int, date] | None:
    """Return (close_price_cents, actual_trading_date) for `symbol` on/just before
    `on_date`, from Yahoo Finance's public chart endpoint. Picks the last available
    daily close at or before the requested date (nearest prior trading day for
    weekends/holidays). Returns None if the symbol/data can't be resolved.
    """
    sym = symbol.strip().upper()
    # Window: a week before to the day after, to catch the nearest prior close.
    period1 = int(datetime(on_date.year, on_date.month, on_date.day,
                           tzinfo=timezone.utc).timestamp()) - 7 * 86400
    period2 = int(datetime(on_date.year, on_date.month, on_date.day,
                           tzinfo=timezone.utc).timestamp()) + 2 * 86400
    url = (f"https://query1.finance.yahoo.com/v8/finance/chart/"
           f"{urllib.parse.quote(sym)}?interval=1d&period1={period1}&period2={period2}")
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            data = json.loads(resp.read().decode("utf-8"))
    except Exception as e:
        print(f"  Yahoo lookup failed: {e}")
        return None
    chart = data.get("chart") or {}
    if chart.get("error"):
        return None
    result = (chart.get("result") or [None])[0]
    if not result:
        return None
    timestamps = result.get("timestamp") or []
    indicators = result.get("indicators") or {}
    quote = (indicators.get("quote") or [{}])[0]
    closes = quote.get("close") or []
    target = on_date
    best: tuple[int, date] | None = None
    for tstamp, close in zip(timestamps, closes):
        if close is None:
            continue
        d = datetime.fromtimestamp(tstamp, tz=timezone.utc).date()
        if d <= target:
            cents = int(round(close * 100))
            if best is None or d >= best[1]:
                best = (cents, d)
    return best


def ensure_category_path(conn: sqlite3.Connection, parent_name: str | None,
                         name: str, applicability: str) -> str:
    """Return the id of category `name` (optionally under `parent_name`), creating
    the parent and/or child as needed. Matches case-insensitively to reuse existing.
    """
    rows = conn.execute(
        "SELECT id, name, parent_id FROM categories WHERE deleted_at IS NULL"
    ).fetchall()
    ts = now_iso()
    parent_id = None
    if parent_name:
        parent = next((r for r in rows if r["parent_id"] is None
                       and (r["name"] or "").lower() == parent_name.lower()), None)
        if parent is None:
            parent_id = str(uuid.uuid4())
            conn.execute(
                """INSERT INTO categories (id, name, parent_id, applicability,
                   created_at, updated_at, deleted_at) VALUES (?, ?, NULL, 'both', ?, ?, NULL)""",
                (parent_id, parent_name, ts, ts),
            )
        else:
            parent_id = parent["id"]
    match = next((r for r in rows
                  if (r["name"] or "").lower() == name.lower()
                  and r["parent_id"] == parent_id), None)
    if match is not None:
        return match["id"]
    cid = str(uuid.uuid4())
    conn.execute(
        """INSERT INTO categories (id, name, parent_id, applicability,
           created_at, updated_at, deleted_at) VALUES (?, ?, ?, ?, ?, ?, NULL)""",
        (cid, name, parent_id, applicability, ts, ts),
    )
    return cid


def get_or_create_asset(conn: sqlite3.Connection, account_id: str, name: str,
                        symbol: str) -> str:
    """Return the id of the security `symbol` in `account_id`, creating it if absent."""
    row = conn.execute(
        """SELECT id FROM assets WHERE deleted_at IS NULL AND account_id = ?
           AND asset_class = 'security' AND UPPER(COALESCE(symbol,'')) = ?""",
        (account_id, symbol.upper()),
    ).fetchone()
    if row:
        return row["id"]
    aid = str(uuid.uuid4())
    ts = now_iso()
    conn.execute(
        """INSERT INTO assets (id, account_id, name, asset_class, symbol,
           quantity_micro, metadata, currency, created_at, updated_at, deleted_at)
           VALUES (?, ?, ?, 'security', ?, 0, NULL, 'USD', ?, ?, NULL)""",
        (aid, account_id, name, symbol.upper(), ts, ts),
    )
    return aid


def paycheck_dates(frequency: str, start: date, end: date,
                   pay_day: int, pay_day2: int | None) -> list[date]:
    """Enumerate pay dates from `start` through `end` for the given frequency.

    monthly    -> `pay_day` each month
    bimonthly  -> `pay_day` and `pay_day2` each month (semi-monthly)
    biweekly   -> every 14 days starting at `start`
    """
    dates: list[date] = []
    if frequency == "biweekly":
        d = start
        while d <= end:
            dates.append(d)
            d = d + timedelta(days=14)
        return dates
    # monthly / bimonthly iterate month by month
    y, m = start.year, start.month
    while (y, m) <= (end.year, end.month):
        days = [pay_day] if frequency == "monthly" else sorted(
            {pay_day, pay_day2 or pay_day})
        for dd in days:
            pd = clamp_day(y, m, dd)
            if start <= pd <= end:
                dates.append(pd)
        y, m = add_month(y, m)
    return sorted(dates)


def paychecks_flow() -> None:
    print("\n=== Paychecks ===")
    db_input = prompt("Path to the BudgetLion database (folder or "
                      f"{DB_FILENAME})")
    try:
        db_path = resolve_db_path(db_input)
    except FileNotFoundError as e:
        print(f"  {e}")
        return

    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    conn.isolation_level = None
    conn.execute("PRAGMA foreign_keys = ON")
    try:
        # Frequency.
        print("\nPay frequency:")
        print("  1. Monthly")
        print("  2. Bi-weekly (every 14 days)")
        print("  3. Bi-monthly (twice a month)")
        freq_choice = prompt_int("Select", default=1, minimum=1)
        frequency = {1: "monthly", 2: "biweekly", 3: "bimonthly"}.get(freq_choice)
        if frequency is None:
            print("Invalid choice.")
            return

        pay_day = pay_day2 = None
        if frequency == "monthly":
            pay_day = prompt_day_of_month("Pay day of month", default=1)
        elif frequency == "bimonthly":
            pay_day = prompt_day_of_month("First pay day of month", default=1)
            pay_day2 = prompt_day_of_month("Second pay day of month", default=15)

        start = prompt_date("Start date (YYYY-MM-DD)", default="2024-01-01")
        end = prompt_date("End date (YYYY-MM-DD)", default=date.today().isoformat())
        if end < start:
            print("  End date is before start date; swapping them.")
            start, end = end, start

        # Gross pay per paycheck.
        gross = prompt_float("Gross pay PER paycheck", default=5000.0)
        gross_cents = int(round(gross * 100))

        # Deposit account.
        deposit = select_account_from(
            conn, "Deposit paycheck INTO which account",
            types=("checking", "savings"))

        # 401k account + percentage (optional — choose None for no contribution).
        k401 = select_account_optional(
            conn, "401k account (choose None for no 401k contribution)",
            types=("investment",))
        if k401 is not None:
            k401_pct = prompt_percent("Percentage of gross to contribute to 401k",
                                      default=6.0)
        else:
            k401_pct = 0.0

        # Compute the per-paycheck breakdown.
        federal = int(round(gross_cents * FEDERAL_RATE))
        fica = int(round(gross_cents * FICA_RATE))
        state = int(round(gross_cents * MISSOURI_STATE_RATE))
        k401_amt = int(round(gross_cents * (k401_pct / 100.0))) if k401 is not None else 0
        net = gross_cents - federal - fica - state - k401_amt
        if net < 0:
            print("  Deductions exceed gross pay; reduce the 401k percentage.")
            return

        pdates = paycheck_dates(frequency, start, end, pay_day, pay_day2)
        if not pdates:
            print("  No pay dates fall in that range.")
            return

        # Look up SWPPX price once per DISTINCT date (cache) so shares are derived
        # from the actual closing price on each pay date. Only needed when there's
        # a 401k contribution to invest.
        price_cache: dict[date, tuple[int, date]] = {}
        if k401 is not None and k401_amt > 0:
            print(f"\nLooking up SWPPX closing prices for {len(set(pdates))} "
                  "pay date(s) from Yahoo…")
            missing: list[date] = []
            for d in sorted(set(pdates)):
                res = fetch_yahoo_close_cents("SWPPX", d)
                if res is None:
                    missing.append(d)
                else:
                    price_cache[d] = res
            if missing:
                print(f"  Could not get a SWPPX price for {len(missing)} date(s): "
                      f"{', '.join(str(x) for x in missing[:5])}"
                      + (" …" if len(missing) > 5 else ""))
                print("  Those paychecks will still post the 401k transfer, but the")
                print("  share purchase will be skipped for dates with no price.")

        payee = prompt("Employer name (payee)", default="Employer")

        print("\n--- Summary (per paycheck) ---")
        print(f"  Frequency:     {frequency}")
        print(f"  Pay dates:     {len(pdates)}  ({pdates[0]} .. {pdates[-1]})")
        print(f"  Gross:         ${gross_cents / 100:,.2f}")
        print(f"  Federal Tax:   ${federal / 100:,.2f}  ({FEDERAL_RATE * 100:g}%)")
        print(f"  FICA:          ${fica / 100:,.2f}  ({FICA_RATE * 100:g}%)")
        print(f"  MO State Tax:  ${state / 100:,.2f}  ({MISSOURI_STATE_RATE * 100:g}%)")
        if k401 is not None and k401_amt > 0:
            print(f"  401k:          ${k401_amt / 100:,.2f}  ({k401_pct:g}%) "
                  f"-> {k401['name']}")
        else:
            print("  401k:          none")
        print(f"  Net deposit:   ${net / 100:,.2f}  -> {deposit['name']}")
        sample = pdates[0]
        if sample in price_cache:
            pc, pd = price_cache[sample]
            shares = k401_amt / pc if pc else 0
            print(f"  SWPPX buy:     ${k401_amt / 100:,.2f} @ ${pc / 100:,.2f} "
                  f"(close {pd}) ≈ {shares:.4f} shares")

        if not prompt_yes_no("\nCreate these paychecks now?", default=False):
            print("Aborted. Nothing was written.")
            return

        conn.execute("BEGIN")
        try:
            # Ensure the categories we need exist.
            salary_cat = ensure_category_path(conn, None, "Salary", "income")
            federal_cat = ensure_category_path(conn, "Taxes", "Federal", "expense")
            state_cat = ensure_category_path(conn, "Taxes", "State", "expense")
            fica_cat = ensure_category_path(conn, "Taxes", "FICA", "expense")
            has_401k = k401 is not None and k401_amt > 0
            if has_401k:
                swppx_asset = get_or_create_asset(
                    conn, k401["id"], "S&P 500 INDEX", "SWPPX")
                investment_cat = ensure_category_path(conn, None, "Investment", "both")

            batch_tag = f"{IMPORT_TAG_PREFIX}pay-{uuid.uuid4().hex[:8]}"
            n_checks = 0
            n_buys = 0
            for d in pdates:
                iso = d.isoformat()
                ts = now_iso()
                # 1) The paycheck split transaction: to = deposit, amount = net.
                #    Legs are signed from the deposit account's perspective and
                #    sum to +net: +gross, -federal, -fica, -state, and (optional)
                #    -401k(transfer).
                tx_id = str(uuid.uuid4())
                conn.execute(
                    """INSERT INTO transactions
                       (id, date, payee, memo, amount_cents, from_account_id,
                        to_account_id, category_id, cleared, reconciled, import_id,
                        created_at, updated_at, deleted_at)
                       VALUES (?, ?, ?, ?, ?, NULL, ?, NULL, 1, 0, ?, ?, ?, NULL)""",
                    (tx_id, iso, payee,
                     f"Gross {gross_cents / 100:.2f} · Net {net / 100:.2f}",
                     net, deposit["id"], batch_tag, ts, ts),
                )
                legs = [
                    (gross_cents, salary_cat, None, "Gross pay"),
                    (-federal, federal_cat, None, "Federal Tax"),
                    (-fica, fica_cat, None, "FICA"),
                    (-state, state_cat, None, "Missouri State Tax"),
                ]
                if has_401k:
                    legs.append((-k401_amt, None, k401["id"], "401k"))
                for amt, cat, transfer, memo in legs:
                    conn.execute(
                        """INSERT INTO transaction_splits
                           (id, transaction_id, amount_cents, category_id,
                            transfer_account_id, memo, reconciled, plan_id,
                            created_at, updated_at, deleted_at)
                           VALUES (?, ?, ?, ?, ?, ?, 0, NULL, ?, ?, NULL)""",
                        (str(uuid.uuid4()), tx_id, amt, cat, transfer, memo, ts, ts),
                    )
                n_checks += 1

                # 2) Same-date SWPPX buy in the 401k for the transferred amount.
                if has_401k and d in price_cache and k401_amt > 0:
                    price_cents, _pd = price_cache[d]
                    if price_cents > 0:
                        shares = k401_amt / price_cents  # whole+fractional shares
                        quantity_micro = int(round(shares * 1_000_000))
                        price_micros = int(round(price_cents * 1_000_000))
                        # Cash leg: money OUT of the 401k to buy shares (from=401k),
                        # categorized as Investment.
                        cash_id = str(uuid.uuid4())
                        ts2 = now_iso()
                        conn.execute(
                            """INSERT INTO transactions
                               (id, date, payee, memo, amount_cents, from_account_id,
                                to_account_id, category_id, cleared, reconciled,
                                import_id, created_at, updated_at, deleted_at)
                               VALUES (?, ?, 'Buy', NULL, ?, ?, NULL, ?, 0, 0, ?, ?, ?, NULL)""",
                            (cash_id, iso, k401_amt, k401["id"], investment_cat,
                             batch_tag, ts2, ts2),
                        )
                        conn.execute(
                            """INSERT INTO investment_transactions
                               (id, asset_id, account_id, date, action, quantity_micro,
                                price_micros, fees_cents, cash_cents, cash_txn_id,
                                income_txn_id, fee_txn_id, memo, created_at, updated_at, deleted_at)
                               VALUES (?, ?, ?, ?, 'buy', ?, ?, 0, ?, ?, NULL, NULL, NULL, ?, ?, NULL)""",
                            (str(uuid.uuid4()), swppx_asset, k401["id"], iso,
                             quantity_micro, price_micros, -k401_amt, cash_id, ts2, ts2),
                        )
                        # Upsert a valuation at the trade price on that date.
                        conn.execute(
                            """INSERT INTO asset_valuations
                               (id, asset_id, as_of_date, value_micros, source,
                                created_at, updated_at, deleted_at)
                               VALUES (?, ?, ?, ?, 'trade', ?, ?, NULL)
                               ON CONFLICT(asset_id, as_of_date) DO UPDATE SET
                                 value_micros = excluded.value_micros,
                                 source = excluded.source,
                                 updated_at = excluded.updated_at""",
                            (str(uuid.uuid4()), swppx_asset, iso, price_micros, ts2, ts2),
                        )
                        n_buys += 1
            conn.execute("COMMIT")
        except Exception:
            conn.execute("ROLLBACK")
            raise

        print(f"\nDone. Created {n_checks} paychecks and {n_buys} SWPPX purchases.")
        print(f"To remove this batch later, delete transactions where "
              f"import_id = '{batch_tag}' (and their splits / investment rows).")
    finally:
        conn.close()


# ---------------------------------------------------------------------------
# Option 4: Mortgage payments. Amortizes a loan from its starting balance over
# years*12 monthly payments at the loan's annual rate, and posts each payment as
# a split owned by the paying account (an outflow) whose legs sum to -payment:
#   -principal -> transfer to the mortgage (loan) account
#   -interest  -> Interest:Expense category
#   -escrow    -> transfer to the escrow account
# ---------------------------------------------------------------------------

def amortized_payment_cents(principal_cents: int, monthly_rate: float,
                            n_payments: int) -> int:
    """Standard amortized principal+interest payment (excludes escrow), in cents."""
    if n_payments <= 0:
        return 0
    if monthly_rate <= 0:
        return int(round(principal_cents / n_payments))
    factor = (1 + monthly_rate) ** n_payments
    payment = principal_cents * monthly_rate * factor / (factor - 1)
    return int(round(payment))


def mortgage_payments_flow() -> None:
    print("\n=== Mortgage / Loan payments ===")
    db_input = prompt("Path to the BudgetLion database (folder or "
                      f"{DB_FILENAME})")
    try:
        db_path = resolve_db_path(db_input)
    except FileNotFoundError as e:
        print(f"  {e}")
        return

    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    conn.isolation_level = None
    conn.execute("PRAGMA foreign_keys = ON")
    try:
        payer = select_account_from(
            conn, "Pay FROM which account (e.g. Checking)",
            types=("checking", "savings"))
        loan = select_account_from(
            conn, "Mortgage / loan account", types=("loan",))
        escrow_acct = select_account_optional(
            conn, "Escrow account (choose None for loans with no escrow, "
                  "e.g. auto)", types=("checking", "savings"))

        # Starting balance magnitude (opening balance is stored negative for loans).
        start_balance = abs(loan["opening_balance_cents"] or 0)
        if start_balance <= 0:
            print("  The loan account has no (negative) opening balance to amortize.")
            return

        rate_bps = loan["interest_rate_bps"]
        if rate_bps is None:
            apr_pct = prompt_percent(
                f"'{loan['name']}' has no interest rate set. Enter its annual "
                "rate (%)", default=5.0)
            rate_bps = apr_pct * 100.0
        monthly_rate = (rate_bps / 10000.0) / 12.0

        years = prompt_int("Loan period in years", default=30, minimum=1)
        n_payments = years * 12

        # Escrow only applies when an escrow account was chosen. Use the loan's
        # stored monthly escrow if set, else prompt.
        escrow_cents = 0
        if escrow_acct is not None:
            stored = loan["escrow_payment_cents"]
            if stored is None:
                escrow_dollars = prompt_float(
                    "Monthly escrow amount (taxes + insurance)", default=0.0,
                    minimum=0.0)
                escrow_cents = int(round(escrow_dollars * 100))
            else:
                escrow_cents = stored

        pay_day = prompt_day_of_month("Payment day of month", default=1)
        start = prompt_date("First payment date (YYYY-MM-DD)", default="2024-02-01")
        end = prompt_date("Stop after this date (YYYY-MM-DD; blank-safe default is "
                          "the full term)",
                          default=(clamp_day(*_advance_months(start.year, start.month,
                                                              n_payments - 1),
                                             pay_day)).isoformat())

        payee = prompt("Payee (lender)", default=loan["name"])

        pi_payment = amortized_payment_cents(start_balance, monthly_rate, n_payments)
        total_payment = pi_payment + escrow_cents

        print("\n--- Summary ---")
        print(f"  From:            {payer['name']}")
        print(f"  Loan:            {loan['name']}  "
              f"(balance ${start_balance / 100:,.2f})")
        print(f"  Escrow account:  {escrow_acct['name'] if escrow_acct else 'None'}")
        print(f"  Rate:            {rate_bps / 100:.3f}% annual "
              f"({monthly_rate * 100:.5f}%/mo)")
        print(f"  Term:            {years} years ({n_payments} payments)")
        print(f"  P+I payment:     ${pi_payment / 100:,.2f}")
        print(f"  Escrow:          ${escrow_cents / 100:,.2f}")
        print(f"  Total payment:   ${total_payment / 100:,.2f}")
        print(f"  Starting:        {start}  (day {pay_day} each month)")
        print(f"  Stopping by:     {end}")

        if not prompt_yes_no("\nCreate these loan payments now?", default=False):
            print("Aborted. Nothing was written.")
            return

        conn.execute("BEGIN")
        try:
            interest_cat_id = ensure_interest_expense_category(conn)
            batch_tag = f"{IMPORT_TAG_PREFIX}mtg-{uuid.uuid4().hex[:8]}"
            balance = start_balance
            n_made = 0
            total_interest = 0
            total_principal = 0
            total_escrow = 0

            y, m = start.year, start.month
            for i in range(n_payments):
                pay_date = clamp_day(y, m, pay_day)
                if pay_date > end:
                    break
                if balance <= 0:
                    break
                # Interest on the current balance; principal = P+I - interest.
                interest = int(round(balance * monthly_rate)) if monthly_rate > 0 else 0
                principal = pi_payment - interest
                # On the last scheduled payment, pay off the exact remaining
                # balance so rounding never leaves a few cents behind. Also clamp
                # if principal would otherwise exceed the balance.
                if i == n_payments - 1 or principal > balance:
                    principal = balance
                if principal < 0:
                    principal = 0
                payment_total = principal + interest + escrow_cents
                ts = now_iso()

                # The payment transaction: from = payer, to = mortgage, amount = total.
                tx_id = str(uuid.uuid4())
                conn.execute(
                    """INSERT INTO transactions
                       (id, date, payee, memo, amount_cents, from_account_id,
                        to_account_id, category_id, cleared, reconciled, import_id,
                        created_at, updated_at, deleted_at)
                       VALUES (?, ?, ?, NULL, ?, ?, ?, NULL, 1, 0, ?, ?, ?, NULL)""",
                    (tx_id, pay_date.isoformat(), payee, payment_total,
                     payer["id"], loan["id"], batch_tag, ts, ts),
                )
                # Legs owned by the payer (outflow => negative), summing to -total.
                legs = [
                    (-principal, None, loan["id"], "Principal"),
                    (-interest, interest_cat_id, None, "Interest"),
                ]
                if escrow_cents > 0 and escrow_acct is not None:
                    legs.append((-escrow_cents, None, escrow_acct["id"], "Escrow"))
                for amt, cat, transfer, memo in legs:
                    conn.execute(
                        """INSERT INTO transaction_splits
                           (id, transaction_id, amount_cents, category_id,
                            transfer_account_id, memo, reconciled, plan_id,
                            created_at, updated_at, deleted_at)
                           VALUES (?, ?, ?, ?, ?, ?, 0, NULL, ?, ?, NULL)""",
                        (str(uuid.uuid4()), tx_id, amt, cat, transfer, memo, ts, ts),
                    )
                balance -= principal
                total_interest += interest
                total_principal += principal
                total_escrow += escrow_cents
                n_made += 1
                y, m = add_month(y, m)
            conn.execute("COMMIT")
        except Exception:
            conn.execute("ROLLBACK")
            raise

        print(f"\nDone. Created {n_made} loan payments.")
        print(f"  Principal paid: ${total_principal / 100:,.2f}   "
              f"Interest: ${total_interest / 100:,.2f}   "
              f"Escrow: ${total_escrow / 100:,.2f}")
        print(f"  Remaining balance: ${balance / 100:,.2f}")
        print(f"To remove this batch later, delete transactions where "
              f"import_id = '{batch_tag}' (and their splits).")
    finally:
        conn.close()


# ---------------------------------------------------------------------------
# Option 6: BNPL / Installment plans. Creates a loan_plans row on an installment
# account, computes its installment from principal/APR/#payments, then posts a
# monthly payment (from a funding account) as a split whose legs are plan-
# attributed: a principal transfer into the installment account (carrying plan_id)
# and an Interest:Expense leg for the month's accrued interest.
# ---------------------------------------------------------------------------

def installment_plans_flow() -> None:
    print("\n=== BNPL / Installment plans ===")
    db_input = prompt("Path to the BudgetLion database (folder or "
                      f"{DB_FILENAME})")
    try:
        db_path = resolve_db_path(db_input)
    except FileNotFoundError as e:
        print(f"  {e}")
        return

    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    conn.isolation_level = None
    conn.execute("PRAGMA foreign_keys = ON")
    try:
        acct = select_account_from(
            conn, "Installment / BNPL account", types=("installment",))
        funding = select_account_from(
            conn, "Pay FROM which account (e.g. Checking)",
            types=("checking", "savings"))

        label = prompt("Plan label (e.g. 'Wayfair couch')", default="Installment plan")
        principal = prompt_float("Initial principal (financed amount)", default=1200.0)
        principal_cents = int(round(principal * 100))
        apr_pct = prompt_percent_or_zero("Interest APR (%) (0 for interest-free)",
                                         default=0.0)
        rate_bps = int(round(apr_pct * 100))
        monthly_rate = (rate_bps / 10000.0) / 12.0
        orig = prompt_date("Origination date (YYYY-MM-DD)", default="2024-01-01")
        num_payments = prompt_int("Number of payments", default=12, minimum=1)
        end = prompt_date("Make payments until (YYYY-MM-DD)",
                          default=date.today().isoformat())

        # Computed installment (principal+interest amortized over num_payments).
        installment = amortized_payment_cents(principal_cents, monthly_rate, num_payments)

        # Enumerate monthly payment dates on the origination day-of-month, starting
        # the month AFTER origination, capped at num_payments and the end date.
        pay_dates: list[date] = []
        y, m = add_month(orig.year, orig.month)
        for _ in range(num_payments):
            d = clamp_day(y, m, orig.day)
            if d > end:
                break
            pay_dates.append(d)
            y, m = add_month(y, m)

        print("\n--- Summary ---")
        print(f"  Account:       {acct['name']}")
        print(f"  Funding:       {funding['name']}")
        print(f"  Plan:          {label}")
        print(f"  Principal:     ${principal_cents / 100:,.2f}")
        print(f"  APR:           {apr_pct:g}%  (monthly {monthly_rate * 100:.5f}%)")
        print(f"  Payments:      {num_payments} scheduled, "
              f"{len(pay_dates)} within range")
        print(f"  Installment:   ${installment / 100:,.2f}/mo")
        print(f"  Origination:   {orig}  (pay on day {orig.day})")
        print(f"  Until:         {end}")

        if not prompt_yes_no("\nCreate this plan and its payments now?",
                            default=False):
            print("Aborted. Nothing was written.")
            return

        conn.execute("BEGIN")
        try:
            interest_cat_id = ensure_interest_expense_category(conn)
            ts = now_iso()
            plan_id = str(uuid.uuid4())
            # Create the plan row.
            conn.execute(
                """INSERT INTO loan_plans
                   (id, account_id, label, origination_date, expiration_date,
                    principal_cents, rate_bps, num_payments, payment_cents,
                    purchase_category_id, purchase_txn_id, created_at, updated_at, deleted_at)
                   VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?, NULL, NULL, ?, ?, NULL)""",
                (plan_id, acct["id"], label, orig.isoformat(), principal_cents,
                 rate_bps, num_payments, installment, ts, ts),
            )

            batch_tag = f"{IMPORT_TAG_PREFIX}bnpl-{uuid.uuid4().hex[:8]}"
            balance = principal_cents
            n_made = 0
            total_interest = 0
            total_principal = 0
            for i, d in enumerate(pay_dates):
                if balance <= 0:
                    break
                iso = d.isoformat()
                interest = (int(round(balance * (rate_bps / 10000.0) / 12.0))
                            if rate_bps > 0 else 0)
                principal_leg = installment - interest
                # Last scheduled payment (or overrun) pays off the exact remainder.
                if i == num_payments - 1 or principal_leg > balance:
                    principal_leg = balance
                if principal_leg < 0:
                    principal_leg = 0
                applied = principal_leg + interest
                ts2 = now_iso()

                # Payment transaction: from = funding, to = NULL, amount = applied.
                tx_id = str(uuid.uuid4())
                conn.execute(
                    """INSERT INTO transactions
                       (id, date, payee, memo, amount_cents, from_account_id,
                        to_account_id, category_id, cleared, reconciled, import_id,
                        created_at, updated_at, deleted_at)
                       VALUES (?, ?, ?, NULL, ?, ?, NULL, NULL, 1, 0, ?, ?, ?, NULL)""",
                    (tx_id, iso, acct["name"], applied, funding["id"],
                     batch_tag, ts2, ts2),
                )
                # Principal leg: transfer into the installment account, tagged plan_id.
                conn.execute(
                    """INSERT INTO transaction_splits
                       (id, transaction_id, amount_cents, category_id,
                        transfer_account_id, memo, reconciled, plan_id,
                        created_at, updated_at, deleted_at)
                       VALUES (?, ?, ?, NULL, ?, ?, 0, ?, ?, ?, NULL)""",
                    (str(uuid.uuid4()), tx_id, -principal_leg, acct["id"],
                     f"Principal — {label}", plan_id, ts2, ts2),
                )
                # Interest leg: Interest:Expense, tagged plan_id.
                if interest > 0:
                    conn.execute(
                        """INSERT INTO transaction_splits
                           (id, transaction_id, amount_cents, category_id,
                            transfer_account_id, memo, reconciled, plan_id,
                            created_at, updated_at, deleted_at)
                           VALUES (?, ?, ?, ?, NULL, ?, 0, ?, ?, ?, NULL)""",
                        (str(uuid.uuid4()), tx_id, -interest, interest_cat_id,
                         f"Interest — {label}", plan_id, ts2, ts2),
                    )
                balance -= principal_leg
                total_interest += interest
                total_principal += principal_leg
                n_made += 1
            conn.execute("COMMIT")
        except Exception:
            conn.execute("ROLLBACK")
            raise

        print(f"\nDone. Created plan '{label}' and {n_made} payments.")
        print(f"  Principal paid: ${total_principal / 100:,.2f}   "
              f"Interest: ${total_interest / 100:,.2f}   "
              f"Remaining: ${balance / 100:,.2f}")
        print(f"To remove this batch later, delete transactions where "
              f"import_id = '{batch_tag}' (and their splits), and the loan_plans "
              f"row {plan_id}.")
    finally:
        conn.close()


# ---------------------------------------------------------------------------
# Option 7: Transfers. Recurring transfers between two tracked accounts (e.g.
# Checking -> Savings): N per month across a date range. A transfer sets both
# from/to and no category (internal movement, not spending or income).
# ---------------------------------------------------------------------------

def _monthly_spread_dates(start: date, end: date, per_month: int) -> list[date]:
    """`per_month` evenly-spaced days within each month across [start, end].

    For per_month=1 -> day 1; 2 -> days ~1 and ~15; N -> N evenly-spaced days.
    Dates outside [start, end] are dropped.
    """
    dates: list[date] = []
    # Choose day-of-month slots: evenly spaced in 1..28 (safe for every month).
    if per_month <= 1:
        slots = [1]
    else:
        step = 28 / per_month
        slots = sorted({max(1, min(28, int(round(1 + i * step)))) for i in range(per_month)})
    y, m = start.year, start.month
    while (y, m) <= (end.year, end.month):
        for dd in slots:
            d = clamp_day(y, m, dd)
            if start <= d <= end:
                dates.append(d)
        y, m = add_month(y, m)
    return sorted(dates)


def transfers_flow() -> None:
    print("\n=== Transfers ===")
    db_input = prompt("Path to the BudgetLion database (folder or "
                      f"{DB_FILENAME})")
    try:
        db_path = resolve_db_path(db_input)
    except FileNotFoundError as e:
        print(f"  {e}")
        return

    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    conn.isolation_level = None
    conn.execute("PRAGMA foreign_keys = ON")
    try:
        from_acct = select_account_from(
            conn, "Transfer FROM which account (e.g. Checking)",
            types=("checking", "savings"))
        to_acct = select_account_from(
            conn, "Transfer TO which account (e.g. Savings)",
            types=("checking", "savings"))
        if from_acct["id"] == to_acct["id"]:
            print("  The from and to accounts must differ.")
            return

        start = prompt_date("Start date (YYYY-MM-DD)", default="2024-01-01")
        end = prompt_date("End date (YYYY-MM-DD)", default=date.today().isoformat())
        if end < start:
            print("  End date is before start date; swapping them.")
            start, end = end, start
        per_month = prompt_int("Transfers per month", default=1, minimum=1)
        amount = prompt_float("Amount per transfer", default=500.0)
        amount_cents = int(round(amount * 100))

        tdates = _monthly_spread_dates(start, end, per_month)
        if not tdates:
            print("  No transfer dates fall in that range.")
            return

        print("\n--- Summary ---")
        print(f"  From:            {from_acct['name']}")
        print(f"  To:              {to_acct['name']}")
        print(f"  Per month:       {per_month}")
        print(f"  Amount each:     ${amount_cents / 100:,.2f}")
        print(f"  Count:           {len(tdates)}  ({tdates[0]} .. {tdates[-1]})")
        print(f"  Total moved:     ${amount_cents * len(tdates) / 100:,.2f}")

        if not prompt_yes_no("\nCreate these transfers now?", default=False):
            print("Aborted. Nothing was written.")
            return

        conn.execute("BEGIN")
        try:
            batch_tag = f"{IMPORT_TAG_PREFIX}xfer-{uuid.uuid4().hex[:8]}"
            payee = f"Transfer To {to_acct['name']}"
            for d in tdates:
                ts = now_iso()
                # A transfer: both from/to set, no category.
                conn.execute(
                    """INSERT INTO transactions
                       (id, date, payee, memo, amount_cents, from_account_id,
                        to_account_id, category_id, cleared, reconciled, import_id,
                        created_at, updated_at, deleted_at)
                       VALUES (?, ?, ?, NULL, ?, ?, ?, NULL, 1, 0, ?, ?, ?, NULL)""",
                    (str(uuid.uuid4()), d.isoformat(), payee, amount_cents,
                     from_acct["id"], to_acct["id"], batch_tag, ts, ts),
                )
            conn.execute("COMMIT")
        except Exception:
            conn.execute("ROLLBACK")
            raise

        print(f"\nDone. Created {len(tdates)} transfers "
              f"'{from_acct['name']}' -> '{to_acct['name']}'.")
        print(f"To remove this batch later, delete transactions where "
              f"import_id = '{batch_tag}'.")
    finally:
        conn.close()


def _advance_months(year: int, month: int, count: int) -> tuple[int, int]:
    """Return (year, month) advanced by `count` months."""
    total = (year * 12 + (month - 1)) + count
    return total // 12, (total % 12) + 1


# ---------------------------------------------------------------------------
# Option 5: Escrow disbursements. Yearly insurance and property-tax payments made
# OUT of the escrow account (categorized expenses), once per year on the same day
# of month across a date range.
# ---------------------------------------------------------------------------

def _yearly_dates(start: date, end: date) -> list[date]:
    """One date per year from `start` through `end`, keeping start's month/day
    (clamped for Feb 29)."""
    dates: list[date] = []
    y = start.year
    while True:
        d = clamp_day(y, start.month, start.day)
        if d > end:
            break
        if d >= start:
            dates.append(d)
        y += 1
    return dates


def escrow_disbursements_flow() -> None:
    print("\n=== Escrow disbursements (insurance + property tax) ===")
    db_input = prompt("Path to the BudgetLion database (folder or "
                      f"{DB_FILENAME})")
    try:
        db_path = resolve_db_path(db_input)
    except FileNotFoundError as e:
        print(f"  {e}")
        return

    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    conn.isolation_level = None
    conn.execute("PRAGMA foreign_keys = ON")
    try:
        escrow_acct = select_account_from(
            conn, "Pay FROM which escrow account", types=("checking", "savings"))

        # Insurance line.
        ins_payee = prompt("Insurance payee", default="Home Insurance Co")
        ins_start = prompt_date("Insurance start date (YYYY-MM-DD)",
                                default="2024-01-15")
        ins_end = prompt_date("Insurance end date (YYYY-MM-DD)",
                              default=date.today().isoformat())
        ins_amount = prompt_float("Insurance amount (per year)", default=1500.0)

        # Property tax line.
        tax_payee = prompt("Property tax payee", default="County Collector")
        tax_start = prompt_date("Property tax start date (YYYY-MM-DD)",
                                default="2024-12-15")
        tax_end = prompt_date("Property tax end date (YYYY-MM-DD)",
                              default=date.today().isoformat())
        tax_amount = prompt_float("Property tax amount (per year)", default=3600.0)

        ins_cents = int(round(ins_amount * 100))
        tax_cents = int(round(tax_amount * 100))
        if ins_end < ins_start:
            ins_start, ins_end = ins_end, ins_start
        if tax_end < tax_start:
            tax_start, tax_end = tax_end, tax_start

        ins_dates = _yearly_dates(ins_start, ins_end)
        tax_dates = _yearly_dates(tax_start, tax_end)

        print("\n--- Summary ---")
        print(f"  Escrow account:  {escrow_acct['name']}")
        print(f"  Insurance:       {ins_payee}  ${ins_cents / 100:,.2f}/yr  "
              f"× {len(ins_dates)}  ({ins_start} .. {ins_end}, day {ins_start.day})")
        print(f"  Property tax:    {tax_payee}  ${tax_cents / 100:,.2f}/yr  "
              f"× {len(tax_dates)}  ({tax_start} .. {tax_end}, day {tax_start.day})")
        if not ins_dates and not tax_dates:
            print("  No yearly dates fall in those ranges.")
            return

        if not prompt_yes_no("\nCreate these escrow disbursements now?", default=False):
            print("Aborted. Nothing was written.")
            return

        conn.execute("BEGIN")
        try:
            # Categories: Insurance:Home for insurance, Taxes:Property for property tax.
            ins_cat = ensure_category_path(conn, "Insurance", "Home", "expense")
            tax_cat = ensure_category_path(conn, "Taxes", "Property", "expense")
            batch_tag = f"{IMPORT_TAG_PREFIX}escrow-{uuid.uuid4().hex[:8]}"

            def post(d: date, payee: str, amount_cents: int, category_id: str) -> None:
                ts = now_iso()
                # Expense OUT of the escrow account: from = escrow, to = NULL.
                conn.execute(
                    """INSERT INTO transactions
                       (id, date, payee, memo, amount_cents, from_account_id,
                        to_account_id, category_id, cleared, reconciled, import_id,
                        created_at, updated_at, deleted_at)
                       VALUES (?, ?, ?, NULL, ?, ?, NULL, ?, 1, 0, ?, ?, ?, NULL)""",
                    (str(uuid.uuid4()), d.isoformat(), payee, amount_cents,
                     escrow_acct["id"], category_id, batch_tag, ts, ts),
                )

            n_ins = n_tax = 0
            for d in ins_dates:
                if ins_cents > 0:
                    post(d, ins_payee, ins_cents, ins_cat)
                    n_ins += 1
            for d in tax_dates:
                if tax_cents > 0:
                    post(d, tax_payee, tax_cents, tax_cat)
                    n_tax += 1
            conn.execute("COMMIT")
        except Exception:
            conn.execute("ROLLBACK")
            raise

        print(f"\nDone. Created {n_ins} insurance and {n_tax} property-tax "
              f"payments from '{escrow_acct['name']}'.")
        print(f"To remove this batch later, delete transactions where "
              f"import_id = '{batch_tag}'.")
    finally:
        conn.close()


# ---------------------------------------------------------------------------
# Option 0: Setup a new database from the hard-coded MyBudget starting data.
# ---------------------------------------------------------------------------

def find_schema_sql() -> str | None:
    """Locate electron/db/schema.sql relative to this script (repo layout)."""
    here = os.path.dirname(os.path.abspath(__file__))
    candidates = [
        os.path.join(here, "..", "electron", "db", "schema.sql"),
        os.path.join(here, "electron", "db", "schema.sql"),
    ]
    for c in candidates:
        if os.path.isfile(c):
            return os.path.abspath(c)
    return None


def insert_setup_data(conn: sqlite3.Connection) -> dict[str, int]:
    """Insert accounts, categories, assets, and valuations from the SETUP_* data.

    Regenerates UUIDs and remaps the key-based relationships. Runs inside the
    caller's open transaction. Returns counts inserted.
    """
    ts = now_iso()

    # 1) Accounts (two passes: create ids, then resolve escrow_target acctkey refs).
    acct_id: dict[str, str] = {a["key"]: str(uuid.uuid4()) for a in SETUP_ACCOUNTS}
    for a in SETUP_ACCOUNTS:
        escrow_target = a["escrow_target"]
        if escrow_target and escrow_target.startswith("acctkey:"):
            target_key = escrow_target.split("acctkey:", 1)[1]
            escrow_target = "acct:" + acct_id[target_key]
        conn.execute(
            """INSERT INTO accounts
               (id, name, type, currency, opening_balance_cents, opening_balance_date,
                account_code, interest_rate_bps, principal_cents, term_months,
                escrow_payment_cents, escrow_target, website_url, notes,
                payment_allocation, created_at, updated_at, deleted_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)""",
            (acct_id[a["key"]], a["name"], a["type"], a["currency"],
             a["opening_balance_cents"], a["opening_balance_date"], a["account_code"],
             a["interest_rate_bps"], a["principal_cents"], a["term_months"],
             a["escrow_payment_cents"], escrow_target, a["website_url"], a["notes"],
             a["payment_allocation"], ts, ts),
        )

    # 2) Categories (parents first — SETUP_CATEGORIES is already ordered that way).
    cat_id: dict[str, str] = {}
    for c in SETUP_CATEGORIES:
        cid = str(uuid.uuid4())
        cat_id[c["key"]] = cid
        parent_id = cat_id[c["parent_key"]] if c["parent_key"] else None
        conn.execute(
            """INSERT INTO categories
               (id, name, parent_id, applicability, created_at, updated_at, deleted_at)
               VALUES (?, ?, ?, ?, ?, ?, NULL)""",
            (cid, c["name"], parent_id, c["applicability"], ts, ts),
        )

    # 3) Assets (into their accounts).
    asset_id: dict[str, str] = {}
    for s in SETUP_ASSETS:
        aid = str(uuid.uuid4())
        asset_id[s["key"]] = aid
        conn.execute(
            """INSERT INTO assets
               (id, account_id, name, asset_class, symbol, quantity_micro, metadata,
                currency, created_at, updated_at, deleted_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, 'USD', ?, ?, NULL)""",
            (aid, acct_id[s["account_key"]], s["name"], s["asset_class"],
             s["symbol"], s["quantity_micro"], s["metadata"], ts, ts),
        )

    # 4) Valuations (per asset).
    for v in SETUP_VALUATIONS:
        conn.execute(
            """INSERT INTO asset_valuations
               (id, asset_id, as_of_date, value_micros, source, created_at, updated_at, deleted_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, NULL)""",
            (str(uuid.uuid4()), asset_id[v["asset_key"]], v["as_of_date"],
             v["value_micros"], v["source"], ts, ts),
        )

    # 5) Cash legs for the investment "add" transactions (amount 0, to = 401k).
    cash_id: dict[str, str] = {}
    for t in SETUP_INV_CASH_TXNS:
        tid = str(uuid.uuid4())
        cash_id[t["key"]] = tid
        conn.execute(
            """INSERT INTO transactions
               (id, date, payee, memo, amount_cents, from_account_id, to_account_id,
                category_id, cleared, reconciled, import_id, created_at, updated_at, deleted_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, 0, NULL, ?, ?, NULL)""",
            (tid, t["date"], t["payee"], t["memo"], t["amount_cents"],
             acct_id[t["from_account_key"]] if t["from_account_key"] else None,
             acct_id[t["to_account_key"]] if t["to_account_key"] else None,
             t["cleared"], ts, ts),
        )

    # 6) Investment transactions establishing the Work 401k holdings.
    for it in SETUP_INVESTMENT_TXNS:
        conn.execute(
            """INSERT INTO investment_transactions
               (id, asset_id, account_id, date, action, quantity_micro, price_micros,
                fees_cents, cash_cents, cash_txn_id, income_txn_id, fee_txn_id, memo,
                created_at, updated_at, deleted_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?, NULL)""",
            (str(uuid.uuid4()), asset_id[it["asset_key"]], acct_id[it["account_key"]],
             it["date"], it["action"], it["quantity_micro"], it["price_micros"],
             it["fees_cents"], it["cash_cents"],
             cash_id[it["cash_txn_key"]] if it["cash_txn_key"] else None,
             it["memo"], ts, ts),
        )

    return {
        "accounts": len(SETUP_ACCOUNTS),
        "categories": len(SETUP_CATEGORIES),
        "assets": len(SETUP_ASSETS),
        "valuations": len(SETUP_VALUATIONS),
        "investment_txns": len(SETUP_INVESTMENT_TXNS),
    }


def setup_flow() -> None:
    print("\n=== Setup a new database ===")
    print("Creates a brand-new BudgetLion database and populates it with the")
    print("MyBudget starting data: accounts (with opening balances), the full")
    print("category tree, physical Assets, and Work 401k securities.")

    schema = find_schema_sql()
    if not schema:
        print("  Could not find electron/db/schema.sql relative to this script.")
        print("  Run this from inside the BudgetLion repo so the schema can be found.")
        return

    folder = prompt("New database FOLDER to create (e.g. ~/Desktop/DemoBudget)")
    folder = os.path.expanduser(folder.strip().strip('"').strip("'"))
    if os.path.exists(folder) and os.listdir(folder):
        print(f"  Folder exists and is not empty: {folder}")
        print("  Choose a new, empty location so an existing database isn't touched.")
        return
    os.makedirs(folder, exist_ok=True)
    db_path = os.path.join(folder, DB_FILENAME)
    with open(schema, "r", encoding="utf-8") as f:
        schema_sql = f.read()

    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    conn.isolation_level = None
    try:
        conn.executescript(schema_sql)
        conn.execute("PRAGMA foreign_keys = ON")

        print("\nWill insert:")
        print(f"  Accounts:            {len(SETUP_ACCOUNTS)}")
        print(f"  Categories:          {len(SETUP_CATEGORIES)}")
        print(f"  Assets:              {len(SETUP_ASSETS)}")
        print(f"  Valuations:          {len(SETUP_VALUATIONS)}")
        print(f"  Investment txns:     {len(SETUP_INVESTMENT_TXNS)} "
              f"(Work 401k share holdings)")
        print(f"  Into:                {db_path}")
        if not prompt_yes_no("\nProceed?", default=True):
            conn.close()
            # Remove the freshly created (empty) database so nothing is left behind.
            try:
                os.remove(db_path)
                for ext in ("-wal", "-shm"):
                    if os.path.exists(db_path + ext):
                        os.remove(db_path + ext)
                if not os.listdir(folder):
                    os.rmdir(folder)
            except OSError:
                pass
            print("Aborted. Nothing was written.")
            return

        conn.execute("BEGIN")
        try:
            counts = insert_setup_data(conn)
            conn.execute("COMMIT")
        except Exception:
            conn.execute("ROLLBACK")
            raise
        print(f"\nDone. Inserted {counts['accounts']} accounts, "
              f"{counts['categories']} categories, {counts['assets']} assets, "
              f"{counts['valuations']} valuations, "
              f"{counts['investment_txns']} investment transactions.")
        print(f"Open this database in BudgetLion: {os.path.dirname(db_path)}")
    finally:
        conn.close()


TRANSACTION_TYPES = (
    ("Credit card purchases", credit_card_purchases_flow),
    ("Credit card payments", credit_card_payments_flow),
    ("Paychecks", paychecks_flow),
    ("Mortgage/Loan payments", mortgage_payments_flow),
    ("Escrow disbursements (insurance + property tax)", escrow_disbursements_flow),
    ("BNPL / Installment plans", installment_plans_flow),
    ("Transfers", transfers_flow),
)


def main() -> None:
    print("BudgetLion example / stress-test data generator")
    print("What would you like to do?\n")
    print("  0. Setup (populate a new/empty database with starting data)")
    for i, (label, _) in enumerate(TRANSACTION_TYPES, start=1):
        print(f"  {i}. {label}")
    choice = prompt_int("\nChoose by number", default=0, minimum=0)
    if choice == 0:
        setup_flow()
        return
    if not (1 <= choice <= len(TRANSACTION_TYPES)):
        print("Invalid choice.")
        return
    _, handler = TRANSACTION_TYPES[choice - 1]
    handler()


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print("\nCancelled.")
        sys.exit(1)
