![app_icon_256](resources/app_icon_256.png)

# BudgetLion v1.1.0

A cross-platform personal-finance ledger with double-entry accounting, built with Electron, React, and SQLite.

*by Richard Lesh*

---

## Features

### Accounts
- **Account types** — Checking, Savings, Credit Card, and Loan/Mortgage
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
- **Resizable, persistent columns** — Column widths are saved between sessions
- **Movable sidebar divider** — Drag to resize the accounts panel; the width persists

### Split Transactions
- Split a single transaction across multiple categories and/or transfer legs
- The ledger's Category cell shows "Split"; the Memo is auto-computed from the leg memos
- Hovering a split shows each leg on its own line
- View-only display on the counterparty (TO) side of a split transfer, with clear labeling

### Categories
- **Subcategories** — Parent:Child hierarchy with income / expense / both applicability
- **Inline rename** — Double-click a category name to edit its base name
- **Safe delete** — A trash button appears only for categories not used by any transaction, split, rule, or subcategory
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
│   │   ├── manage.ts         # New/Open/Save As/Backup/Restore
│   │   └── schema.sql        # database schema
│   ├── ai/                   # AI vendor config + similarity
│   ├── dialogs.ts            # native menu + splash/about/license/settings
│   └── settings.ts           # settings persistence
├── src/
│   ├── App.tsx               # main React app
│   ├── components/           # ledger grid, dialogs, charts, search, etc.
│   ├── core/                 # pure logic (balances, aggregate, recurring,
│   │                         #   dedupe, search, import/export, categories)
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
- [adm-zip](https://github.com/cthackers/adm-zip) — database backup/restore archives

---

## License

GNU General Public License v3.0 — see [LICENSE](LICENSE) for details.

© 2026 Richard Lesh
