![app_icon_256](resources/app_icon_256.png)

# BudgetLion v1.1.0

A cross-platform personal-finance ledger with double-entry accounting, built with Electron, React, and SQLite.

*by Richard Lesh*

---

## Features

### Accounts
- **Account types** — Checking, Savings, Credit Card, Loan/Mortgage, Investment/Brokerage, and Asset
- **Opening balances** — Set an opening balance and date; shown as an editable, sortable ledger row
- **Loan/mortgage fields** — Annual interest rate (basis points, up to 3 decimal places), principal, and term
- **Liability sign convention** — Credit card and loan ledgers display charges as positive and payments as negative, statement-style, while stored data stays consistent
- **Balances** — Running balance per row and current balance per account in the sidebar

### Ledger
- **Fast, editable grid** — Inline editing of date, payee, memo, amount, and category (powered by AG Grid)
- **Type-ahead autocomplete** — Payee and Memo fields suggest completions from the account's prior transactions (in both the ledger and the New Transaction dialog)
- **Category / transfer picker** — A single popup lists income/expense categories (filtered by the transaction's direction) plus other accounts for transfers; keyboard navigable with the current value preselected
- **Transfers** — Move money between tracked accounts; the ledger auto-labels the payee as "To/From &lt;account&gt;"
- **Multi-select + Bulk Delete** — Shift-click for contiguous and Cmd/Ctrl-click for discontiguous selection, then right-click to bulk delete with confirmation
- **Right-click actions** — Copy a field, add a transaction to Recurring Rules, and more
- **Bulk category** — Right-click a multi-selection to reassign all rows to a category or transfer via a submenu
- **Undo / Redo** — Session-scoped, transaction-level undo/redo of adds, edits, deletes, and split changes (row-level snapshot journal; capped at 50 steps, cleared when the database changes)
- **Resizable, persistent columns** — Column widths are saved between sessions
- **Movable sidebar divider** — Drag to resize the accounts panel; the width persists

### Split Transactions
- Split a single transaction across multiple categories and/or transfer legs
- The ledger's Category cell shows "Split"; the Memo is auto-computed from the leg memos
- Hovering a split shows each leg on its own line
- View-only display on the counterparty (TO) side of a split transfer, with clear labeling
- **Split from anywhere** — Open the split editor from the ledger or from Search results
- **Loan payment auto-split** — Categorizing a payment to a loan account automatically splits it into interest (charged on the loan's balance as of the payment date) and principal, using the account's annual rate
- **Mortgage escrow** — Optional third auto-split leg for escrow, routed to a category or another account; interest is still charged on the loan balance and principal is the remainder

### Paychecks
- **Dedicated Paycheck entry** — A "New Paycheck" dialog records a stub as one balanced transaction: gross pay as income, each deduction as its own leg, and the net deposited into an account
- **Gross-as-income model** — Gross pay is recorded as income and taxes/insurance/retirement are real deduction legs, so they flow into your spending and income charts correctly
- **Per-deduction routing** — Each deduction goes to an expense category *or* a transfer to a tracked account (your choice), so pre-tax 401(k)/HSA can move into the matching account while taxes book as expenses
- **Employer contributions** — Optional employer-side contributions (e.g. a 401(k) match) are recorded as separate transfers into the target account, since they don't pass through net pay
- **Live net readout** — Gross − deductions = net deposit updates as you type, with validation that deductions can't exceed gross
- **Import from PDF** — Prefill the dialog from a downloaded pay-stub PDF: text is extracted and common labels (gross/net, federal/Social Security/Medicare/state tax, health/dental/vision, 401(k)/HSA/FSA) and amounts are parsed locally (deterministic, no AI or image upload); you review and assign a category or account to each line before saving

### Investments & Assets
- **Investment/Brokerage accounts** — Track securities alongside cash in the same account
- **Trades** — Buy/Sell dialog with bidirectional shares ⟷ price ⟷ amount; trade rows in the cash ledger show the security ticker, name, shares, and price
- **Stock grants & "Add shares"** — Record employer grants (with an income category) and add opening holdings, gifts, or transfers-in without a cash leg
- **Brokerage fees** — Optional fee expense category on trades
- **Holdings panel** — Per-account holdings with current valuation
- **Price fetching** — Opt-in automated quotes from Yahoo Finance (stocks, ETFs, many mutual funds) via a Settings toggle and a Refresh button; unresolved symbols fall back to manual entry, and symbols are only sent to the provider when fetching is enabled
- **Investment CSV import** — Import 401(k)-style transaction history into trades
- **Asset accounts** — Track non-security assets (e.g. property, collectibles) by valuation
- **Net worth** — Per-account worth combines cash balance with the current value of asset holdings

### Categories
- **Subcategories** — Parent:Child hierarchy with income / expense / both applicability
- **Inline rename** — Double-click a category name to edit its base name
- **Safe delete** — A trash button appears only for categories not used by any transaction, split, rule, or subcategory
- **Default categories** — A brand-new database is seeded with a starter set of income/expense categories (including Cash)
- Sorted category pick lists throughout the app

### Recurring Rules & Forecast
- Define recurring income/expenses/transfers (weekly, bi-weekly, monthly, yearly)
- Fixed, average-of-history, or last-amount estimation modes
- Loan amortization with principal/interest breakdown
- **Forecast panel** — Projected balance chart plus a projected ledger, with resizable, persistent columns

### Charts
- **Spending/Income pie** — Breakdown by category with an Expenses ⟷ Income toggle
- **Monthly bar chart** — Spending vs. income by month
- **Scope & date range** — Chart a single account or all accounts over any date range
- **Export** — Export any chart as PNG or SVG

### De-Duplicate Transactions
- Finds likely duplicate transactions in an account (same date, amount, and from/to accounts — transposed matches allowed for transfers)
- Similar payees/memos judged by the configured AI when available, or an exact/empty-field fallback otherwise
- Prompts whether to use AI (only when a provider is configured and responding)
- Review dialog shows both transactions side-by-side; you pick which to delete, or skip

### Search
- **Search dialog** — Filter across the whole database by account (default All), date range, payee, memo, category, and amount; empty fields are ignored
- Results open in a ledger-style view (grouped by account) that reuses the same table and inline-edit mechanisms
- Right-click actions and the Split editor work directly in Search results; scoping to a single account groups results under just that account

### Import & Export
- **Import transactions** — CSV (configurable column mapping), OFX/QFX, and QIF
- **Statement sign convention** — Optional "loan/credit-card conventions" toggle inverts amounts on import (defaults on for liability accounts)
- **Import safety check** — Warns after preview if the amount-sign distribution looks reversed for the account type
- **Duplicate detection** on import via bank FITID / synthesized keys
- **Export transactions** — CSV, QIF, PDF, and PNG; print the ledger
- **Accounts / Categories / Recurring Rules** — Export and import the full account, category, and recurring-rule set as JSON

### Databases
A database is a folder ("package") containing the SQLite file. From the **File** menu:
- **New DB…** — create and open a new empty database
- **Open…** — open an existing database folder; **Open Default DB** opens the default location
- **Save As…** — copy the current database to a new location and switch to it
- **Backup…** — write a ZIP archive of the current database
- **Restore…** — expand a backup ZIP into a new location and open it
- The last-opened database is reopened on launch, and its name is shown in the title bar

### AI Assistant
- Optional AI integration for smarter payee/memo similarity during de-duplication
- Works with OpenAI-compatible providers, Anthropic, Ollama, and custom endpoints
- Configured in Settings; the app falls back to deterministic matching when no AI is available

### Settings & Customization
- Light / dark theme
- Ledger and print/PDF fonts and sizes
- AI vendor, model, and API keys
- Opt-in automated price fetching for investment holdings
- Settings are saved to `~/.budgetlion-settings.json`

---

## Installation

### Prerequisites
- [Node.js](https://nodejs.org) (v24 or later)
- npm

### Setup
```bash
git clone https://github.com/richlesh/BudgetLion.git
cd BudgetLion
npm install
```

### Running
```bash
npm start
```

---

## Building Distribution Packages

```bash
# Individual builds
npm run dist:mac:x64       # macOS Intel
npm run dist:mac:arm64     # macOS Apple Silicon
npm run dist:win:x64       # Windows x64
npm run dist:win:arm64     # Windows ARM64
npm run dist:linux:x64     # Linux x64
npm run dist:linux:arm64   # Linux ARM64
```

Output files are placed in the `dist/` folder.

---

## Development

```bash
npm run dev         # Run the renderer (Vite) + Electron with hot reload
npm run build       # Build the renderer and Electron main process
npm run typecheck   # Type-check the renderer and Electron projects
```

The renderer lives in `src/` (React + Vite); the Electron main process, preload, database, and IPC live in `electron/`.

---

## Project Structure

```
BudgetLion/
├── electron/
│   ├── main/main.ts          # Electron main process entry
│   ├── preload/preload.ts    # contextBridge API (window.ledger)
│   ├── ipc/handlers.ts       # IPC request handlers
│   ├── db/
│   │   ├── index.ts          # better-sqlite3 connection + migrations
│   │   ├── repository.ts     # data-access layer
│   │   ├── undo.ts           # session-scoped undo/redo snapshot journal
│   │   ├── manage.ts         # New/Open/Save As/Backup/Restore
│   │   └── schema.sql        # database schema
│   ├── ai/                   # AI vendor config + similarity
│   ├── prices/               # opt-in Yahoo Finance price fetching
│   ├── dialogs.ts            # native menu + splash/about/license/settings
│   └── settings.ts           # settings persistence
├── src/
│   ├── App.tsx               # main React app
│   ├── components/           # ledger grid, dialogs, charts, search,
│   │                         #   holdings/investment panels, etc.
│   ├── core/                 # pure logic (balances, aggregate, recurring,
│   │                         #   dedupe, search, import/export, categories,
│   │                         #   worth, loan payment split)
│   └── shared/               # shared types + IPC contract
├── dialogs/                  # static HTML for splash/about/license/settings
├── resources/                # icons + ai-vendors.json
├── package.json              # npm/electron-builder config
├── LICENSE                   # GPL 3.0 license
└── .github/workflows/        # CI/CD build workflows
```

---

## Tech Stack

- [Electron](https://www.electronjs.org)
- [React](https://react.dev) + [Vite](https://vitejs.dev)
- [TypeScript](https://www.typescriptlang.org)
- [better-sqlite3](https://github.com/WiseLibs/better-sqlite3) — embedded SQLite database
- [AG Grid](https://www.ag-grid.com) — the editable ledger grid
- [Apache ECharts](https://echarts.apache.org) — charts and forecast graphs
- [PapaParse](https://www.papaparse.com) — CSV parsing
- [pdf.js](https://mozilla.github.io/pdf.js/) (pdfjs-dist) — local pay-stub PDF text extraction
- [adm-zip](https://github.com/cthackers/adm-zip) — database backup/restore archives

---

## License

GNU General Public License v3.0 — see [LICENSE](LICENSE) for details.

© 2026 Richard Lesh
