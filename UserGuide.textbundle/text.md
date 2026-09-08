<div style="float: left;margin-right:10pt;">

![](assets/app_icon_256.png){width=256}

</div>

# BudgetLion User Guide

**Version 1.4.0**

BudgetLion is a cross-platform personal-finance ledger with double-entry accounting for Linux, macOS, and Windows. Track accounts, split transactions, forecast recurring income and expenses, and visualize your spending with confidence.

---

<div style="clear: left;">

## Table of Contents

- [Getting Started](#getting-started)
- [The Main Window](#the-main-window)
- [Menus](#menus)
- [Accounts](#accounts)
- [The Ledger](#the-ledger)
- [Entering Transactions](#entering-transactions)
- [Transfers](#transfers)
- [Split Transactions](#split-transactions)
- [Paychecks](#paychecks)
- [Investments & Assets](#investments--assets)
- [Categories](#categories)
- [Recurring Rules & Forecast](#recurring-rules--forecast)
- [Charts](#charts)
- [Reports](#reports)
- [Reconciling an Account](#reconciling-an-account)
- [De-Duplicate Transactions](#de-duplicate-transactions)
- [Search](#search)
- [Import & Export](#import--export)
- [Databases](#databases)
- [Settings](#settings)
- [AI Assistant](#ai-assistant)
- [Keyboard Shortcuts](#keyboard-shortcuts)
- [File Locations](#file-locations)
- [Platform Support](#platform-support)
- [Troubleshooting](#troubleshooting)
- [License Key](#license-key)
- [License](#license)

</div>

---

## Getting Started

When you launch BudgetLion, it reopens the last database you used (or creates a default one on first run) and shows the main window:

- **Left sidebar** — Your accounts, each with its current balance, plus buttons to add accounts, manage categories, and search.
- **Main area** — The ledger for the selected account, with a toolbar of quick-action icons across the top.

To begin tracking your finances:

1. Add an account with **File → New Account…** (for example, a Checking account) and set its opening balance.
2. Select the account in the sidebar to open its ledger.
3. Add transactions with **New Transaction** (⌘N / Ctrl+N), or import them from your bank with **Import Transactions** (⌘I / Ctrl+I).
4. Assign categories, set up recurring rules, and explore the charts and reports.

BudgetLion uses **double-entry accounting**: every transfer moves money between two tracked accounts, and every transaction keeps your books balanced.

<div style="text-align: center;">

![Main Window](assets/MainWindow.png){width=100%}

</div>

---

## The Main Window

### Accounts Sidebar

The sidebar lists your accounts. Each row shows:

- An **internet icon** to the left of the name — active when the account has a website URL saved (click it to open the site in your browser), greyed out otherwise.
- The **account name** and optional account ID.
- The account's **current balance** (for investment and asset accounts this is the net worth: cash plus the value of holdings).

Click an account to open its ledger. Right-click an account for actions such as editing it or deleting it (deletion is available only when the account has no transactions or holdings). Drag the divider between the sidebar and the ledger to resize the panel; the width is remembered between sessions.

Below the list are buttons for **+ Add Account**, **Categories…**, and **Search…**.

### Ledger Toolbar

The toolbar above the ledger provides quick-access icon buttons (each with a tooltip):

- **Charts** — Toggle the spending/income charts panel
- **Forecast** — Toggle the projected-balance forecast panel
- **Category Report** — Open the category report
- **Net Worth Report** — Open the net worth report
- **Print** — Print or save the ledger as PDF
- **Import** — Import transactions
- **Export** — Export transactions
- **New Transaction** — Add a transaction
- **New Paycheck** — Record a paycheck
- **Reconcile** — Reconcile the selected account

For investment and asset accounts, the toolbar and panels adapt (for example, an asset account shows a **+/- New Asset** button and a holdings view).

---

## Menus

BudgetLion uses a native application menu. On macOS the application menu is named **BudgetLion**; on Windows and Linux the same items appear under the leftmost menu.

### BudgetLion (Application) Menu

| Item | Description |
|------|-------------|
| About BudgetLion | Version and credits |
| Settings… (⌘, / Ctrl+,) | Open the settings dialog |
| License Key… | Enter or view your license key |
| Quit | Exit the application |

### File Menu

| Item | Shortcut | Description |
|------|----------|-------------|
| New DB… | — | Create and open a new empty database |
| Open DB… | ⌘O / Ctrl+O | Open an existing database folder |
| Open Default DB | — | Open the default database location |
| Save DB As… | ⇧⌘S / Ctrl+Shift+S | Copy the current database elsewhere and switch to it |
| Backup DB… | — | Write a ZIP backup of the current database |
| Restore DB… | — | Expand a backup ZIP into a new location and open it |
| New Account… | — | Create a new account |
| New Category… | — | Create a new category |
| Import Accounts/Categories… | — | Import accounts, categories, and recurring rules from JSON |
| Export Accounts/Categories… | — | Export accounts, categories, and recurring rules to JSON |

### Edit Menu

| Item | Shortcut |
|------|----------|
| Undo | ⌘Z / Ctrl+Z |
| Redo | ⇧⌘Z / Ctrl+Shift+Z |
| Cut / Copy / Paste / Select All | standard |

### Account Menu

| Item | Shortcut | Description |
|------|----------|-------------|
| New Transaction… | ⌘N / Ctrl+N | Add a transaction to the selected account |
| New Paycheck… | ⇧⌘P / Ctrl+Shift+P | Record a paycheck |
| New Asset… | — | Record an asset buy/sell/lost (asset accounts) |
| Delete Transaction… | — | Delete the selected transaction(s) |
| De-Duplicate Transactions | — | Find and review likely duplicates |
| Reconcile Account… | — | Reconcile the account against a statement |
| Search… | ⌘F / Ctrl+F | Search across the whole database |
| Add to Recurring… | — | Turn the selected transaction into a recurring rule |
| Recurring Rules… | ⌘R / Ctrl+R | Manage recurring rules |
| Print… | ⌘P / Ctrl+P | Print / save the ledger |
| Import Transactions… | ⌘I / Ctrl+I | Import transactions |
| Export Transactions… | ⌘E / Ctrl+E | Export transactions |

### View Menu

| Item | Shortcut | Description |
|------|----------|-------------|
| Toggle Charts | ⇧⌘C / Ctrl+Shift+C | Show/hide the charts panel |
| Toggle Forecast | ⇧⌘F / Ctrl+Shift+F | Show/hide the forecast panel |
| Category Report… | — | Open the category report |
| Net Worth Report… | — | Open the net worth report |

The View menu also includes standard Reload, Developer Tools, and Zoom items.

---

## Accounts

### Account Types

BudgetLion supports six account types:

| Type | Purpose |
|------|---------|
| Checking | Everyday spending account |
| Savings | Interest-bearing savings |
| Credit Card | Revolving credit (a liability) |
| Loan / Mortgage | Amortizing debt (a liability) |
| Investment / Brokerage | Cash plus securities (stocks, funds, ETFs) |
| Asset | Physical property, vehicles, collectibles (holdings only, no cash) |

### Creating and Editing an Account

Use **File → New Account…** to create an account, or right-click an existing account and choose **Edit** to change it.

An account has the following fields:

- **Name** and optional **Account ID** (an external/bank identifier)
- **Type** and **Currency** (ISO 4217, e.g. `USD`)
- **Opening balance** and **opening balance date** — shown as an editable, sortable row at the top of the ledger
- **Annual interest rate** — for Credit Card and Loan/Mortgage accounts (basis points, up to 3 decimal places)
- **Escrow payment** and **Escrow destination** — for mortgages (see [Split Transactions](#split-transactions))
- **Website URL** — an optional site/login link; the sidebar shows an internet icon that opens it in your browser
- **Notes** — free-form notes about the account

URLs in the Website URL and Notes fields are clickable in the account details view.

<div style="text-align: center;">

![Edit Account Dialog](assets/EditAccountDialog.png){width=50%}

</div>

### Liability Sign Convention

Credit card and loan ledgers display **charges as positive** and **payments as negative**, statement-style, so the ledger reads the way your statement does. The underlying stored data stays consistent regardless of how it is displayed.

### Deleting an Account

Right-click an account and choose delete. This is available only when the account has **no transactions or holdings** — clear or move its activity first.

---

## The Ledger

Selecting an account opens its ledger: a fast, editable grid (powered by AG Grid) with a running balance on every row.

### Editing Cells

Double-click a cell to edit it inline. You can edit the **date, payee, memo, amount, and category** directly in the grid.

- **Type-ahead autocomplete** — The Payee and Memo fields suggest completions from the account's prior transactions as you type.
- **Category / transfer picker** — Clicking the Category cell opens a single popup listing income/expense categories (filtered by the transaction's direction) plus other accounts for transfers. It is keyboard navigable, with the current value preselected — start typing to jump to a matching entry.
- **Resizable, persistent columns** — Drag column borders to resize; widths are saved between sessions.

### Selecting Rows

- **Shift-click** selects a contiguous range.
- **Cmd/Ctrl-click** adds or removes individual rows (discontiguous selection).

### Right-Click Actions

Right-click a row (or a multi-row selection) for actions such as:

- **Copy** a field value
- **Add to Recurring** — create a recurring rule from the transaction
- **Move to account** — reassign the transaction to another account
- **Bulk Category** — reassign every selected row to a category or transfer via a submenu (type to filter)
- **Bulk Delete** — delete the selected rows (with confirmation)

### Undo / Redo

BudgetLion keeps a session-scoped, transaction-level **undo/redo** history of adds, edits, deletes, and split changes (up to 50 steps). The history is cleared when you switch databases. Use **Edit → Undo** (⌘Z / Ctrl+Z) and **Edit → Redo** (⇧⌘Z / Ctrl+Shift+Z).

<div style="text-align: center;">

![Ledger](assets/Ledger.png){width=100%}

</div>

---

## Entering Transactions

### New Transaction Dialog

Open with **Account → New Transaction…** (⌘N / Ctrl+N) or the toolbar button. Enter the date, payee, memo, amount, and a category or transfer target. The dialog offers the same type-ahead payee/memo suggestions as the ledger.

If you create a transfer **to a loan account**, BudgetLion treats it as a loan payment and opens the split editor pre-filled with the interest/principal (and optional escrow) breakdown (see [Split Transactions](#split-transactions)).

### Deleting Transactions

Select one or more rows and use **Account → Delete Transaction…**, the row's trash button, or the right-click **Bulk Delete** action.

---

## Transfers

A transfer moves money between two tracked accounts. To create one, set a transaction's **Category** cell to another account instead of a category. The ledger auto-labels the payee as **"To \<account\>"** or **"From \<account\>"** depending on direction.

Transfers appear in both accounts' ledgers and keep your books balanced. The counterparty side of a transfer is shown but edited from the owning account.

---

## Split Transactions

A split divides a single transaction across multiple categories and/or transfer legs.

- The ledger's Category cell shows **"Split"**, and the Memo is auto-computed from the leg memos.
- Hovering a split shows each leg on its own line.
- You can open the split editor from the ledger or from Search results.

### Loan Payment Auto-Split

When you categorize a payment **to a loan account**, BudgetLion automatically splits it into **interest** (charged on the loan's balance as of the payment date, using the account's annual rate) and **principal** (the remainder).

### Mortgage Escrow

If a loan account has an **escrow payment** configured (in Edit Account), the auto-split adds a third **escrow** leg, routed to a category or another account. Interest is still charged on the loan balance, and principal is the remainder after interest and escrow.

<div style="text-align: center;">

![Split Editor](assets/SplitEditor.png){width=60%}

</div>

---

## Paychecks

Open **Account → New Paycheck…** (⇧⌘P / Ctrl+Shift+P) to record a pay stub as one balanced transaction.

- **Gross-as-income model** — Gross pay is recorded as income, and each tax/insurance/retirement deduction is its own leg, so they flow correctly into your spending and income charts.
- **Per-deduction routing** — Each deduction goes to an expense category *or* a transfer to a tracked account (your choice). For example, a pre-tax 401(k) or HSA contribution can transfer into the matching account, while taxes book as expenses.
- **Employer contributions** — Optional employer-side contributions (such as a 401(k) match) are recorded as separate transfers into the target account, since they don't pass through your net pay.
- **Live net readout** — Gross − deductions = net deposit updates as you type, and the dialog validates that deductions can't exceed gross.

### Import from PDF

You can prefill the dialog from a downloaded pay-stub PDF. BudgetLion extracts the text and parses common labels (gross/net, federal/Social Security/Medicare/state tax, health/dental/vision, 401(k)/HSA/FSA) and amounts **locally** — no AI or image upload. You review and assign a category or account to each line before saving.

### Editing a Paycheck

Double-click a paycheck's split in the ledger (or in Search) to reopen it in the Paycheck editor. The counterparty side opens read-only.

<div style="text-align: center;">

![Paycheck Dialog](assets/PaycheckDialog.png){width=60%}

</div>

---

## Investments & Assets

### Investment / Brokerage Accounts

Investment accounts track securities alongside cash in the same account.

- **Trades** — A Buy/Sell dialog links shares, price per share, and amount. You can **lock** any one of the three fields (hold it fixed) while editing the other two recomputes the third. Trade rows in the cash ledger show the security ticker, name, shares, and price.
- **Price-on-date lookup** — An internet-lookup button next to Price per Share fetches the security's closing price on the transaction date (opt-in Yahoo Finance; for weekends/holidays it uses the nearest prior trading day).
- **Stock grants & "Add shares"** — Record employer grants (with an income category) and add opening holdings, gifts, or transfers-in. "Add shares" appears as its own ledger line.
- **Brokerage fees** — An optional fee expense category on trades.

<div style="text-align: center;">

![New Investment Transaction](assets/NewInvestmentDialog.png){width=60%}

</div>

### Holdings Panel

For an investment account, the holdings panel lists each security with its shares, per-share price, and market value.

- Double-click a ticker or description to edit it inline.
- Double-click a Price cell to enter a per-share price as of a closing date; market value updates from the latest valuation.
- **Refresh prices** fetches opt-in quotes from Yahoo Finance for tickered holdings.
- **Symbol lookup** — Find a security's ticker by name from the holding's Symbol cell (opt-in Yahoo search).
- Right-click a holding for a **History** chart (with a Share Price ⟷ Total Value toggle and date-range selector) or the **Valuations editor**.

### Valuations Editor

Right-click a holding and choose **Edit Valuations…** to add, edit, or delete stored valuations (date + per-share price). For a tickered security, the add-row price auto-fills from Yahoo for the chosen date (opt-in) and re-fetches when you change the date, tagging the source as Yahoo or manual.

### Asset Accounts

Asset accounts track physical assets (property, vehicles, collectibles) as pure holdings with no cash.

Use the **+/- New Asset** button to record:

- **Buy** — add an item with a description, model number, serial number, and purchase price + date.
- **Sell** — dispose of an item at a sale price and date.
- **Lost** — dispose of an item at $0.

The holdings view shows Description, Model, Serial, Purchase Price, Purchased date, and Market Value, each editable by double-click. Each row has a trash button; if you delete an item that you actually sold or lost, BudgetLion warns you to record a **Sell** or **Lost** transaction instead so the disposition is captured.

### Net Worth

Per-account worth combines the cash balance with the current value of holdings. Investment and asset accounts show their worth in the sidebar and roll up into the Net Worth Report.

> **Price fetching is opt-in.** Automated quotes and symbol lookups from Yahoo Finance are off by default and enabled in Settings. Symbols are only sent to the provider when fetching is enabled, and unresolved symbols fall back to manual entry.

---

## Categories

Open the category manager with **Categories…** in the sidebar or **File → New Category…**.

- **Subcategories** — Organize spending with a Parent:Child hierarchy, each marked as applying to income, expense, or both.
- **Inline rename** — Double-click a category name to edit its base name.
- **Safe delete** — A trash button appears only for categories not used by any transaction, split, rule, or subcategory.
- **Default categories** — A brand-new database is seeded with a starter set of income/expense categories (including Cash).

Category pick lists are sorted throughout the app.

---

## Recurring Rules & Forecast

### Recurring Rules

Open **Account → Recurring Rules…** (⌘R / Ctrl+R) to define recurring income, expenses, and transfers.

- **Frequencies** — weekly, bi-weekly, monthly, or yearly.
- **Estimation modes** — fixed amount, average of history, or last amount.
- **Loan amortization** — recurring loan payments can project a principal/interest breakdown.

You can also create a rule from an existing transaction with the right-click **Add to Recurring** action.

### Forecast

Toggle the **Forecast** panel (⇧⌘F / Ctrl+Shift+F) to see a projected balance chart plus a projected ledger of upcoming recurring activity. The forecast ledger has resizable, persistent columns.

<div style="text-align: center;">

![Forecast](assets/Forecast.png){width=100%}

</div>

---

## Charts

Toggle the **Charts** panel (⇧⌘C / Ctrl+Shift+C) to visualize your finances.

- **Spending/Income pie** — Breakdown by category with an Expenses ⟷ Income toggle.
- **Monthly bar chart** — Spending vs. income by month.
- **Scope & date range** — Chart a single account or all accounts over any date range.
- **Export** — Save any chart as PNG or SVG.

<div style="text-align: center;">

![Charts](assets/Charts.png){width=100%}

</div>

---

## Reports

### Net Worth Report

Open **View → Net Worth Report…** for a one-page summary that groups accounts into **Assets** and **Liabilities**, with per-account values, subtotals, and total net worth (cash + holdings), sorted by account type then name. The report is printable or can be saved as PDF.

### Category Report

Open **View → Category Report…** to pick an income/expense category, an account (or **All Accounts**, defaulting to the currently selected account), and an optional date range. The report lists every matching transaction (including split legs) with a total, and is printable or saved as PDF.

---

## Reconciling an Account

Open **Account → Reconcile Account…** (or the Reconcile toolbar button) to reconcile the selected account against a statement. Check off cleared transactions and create an adjustment if needed so your recorded balance matches the statement.

Reconciled transactions are marked and locked against accidental edits of the date/amount/counterparty; a right-click **Un-reconcile** action clears that state for the selected rows.

---

## De-Duplicate Transactions

Open **Account → De-Duplicate Transactions** to find likely duplicate transactions in the selected account (same date, amount, and from/to accounts — transposed matches are allowed for transfers).

- Similar payees/memos are judged by the configured AI when available, or an exact/empty-field fallback otherwise.
- BudgetLion prompts whether to use AI (only when a provider is configured and responding).
- A review dialog shows both transactions side-by-side; you choose which to delete, or skip the pair.

<div style="text-align: center;">

![De-Duplicate Dialog](assets/DedupeDialog.png){width=60%}

</div>

---

## Search

Open **Account → Search…** (⌘F / Ctrl+F) to filter across the whole database.

- Filter by **account** (default All), **date range**, **payee**, **memo**, **category**, and **amount**. Empty fields are ignored.
- The category picker includes an **Uncategorized** option to find transactions with no category (transfers excluded).
- Results open in a ledger-style view grouped by account, reusing the same table and inline-edit mechanisms — including right-click actions and the split editor.

<div style="text-align: center;">

![Search Dialog](assets/SearchDialog.png){width=50%}

</div>

---

## Import & Export

### Importing Transactions

Open **Account → Import Transactions…** (⌘I / Ctrl+I).

Supported formats:

- **CSV** — with a configurable column mapping
- **Excel** — `.xls` / `.xlsx` (the first sheet is read into the same column-mapping flow as CSV)
- **OFX / QFX**
- **QIF**
- **Bank-statement PDF**

For an **investment account**, a chooser first asks whether you're importing **cash transactions** (into the account ledger, e.g. HSA spending) or **investment transactions** (trade history).

#### Column Mapping (CSV / Excel)

Map each column to a field (date, payee, memo, amount, etc.). A **"Amounts use loan / credit-card conventions"** toggle inverts amounts on import (defaulted on for liability accounts) so charges/payments land with the right sign.

#### PDF Statement Import

BudgetLion extracts the PDF's text **locally** and detects transactions with a deterministic heuristic parser (dates, amounts, and statement sections). You review the results in an **editable preview**, where you can fix any field and add rows before importing. A note reminds you of the ledger sign convention — **payments/credits are positive** and **charges/withdrawals are negative** — so you can toggle the invert option if amounts look reversed.

Optionally, **Extract with AI** sends the statement text to your configured provider and returns the transactions for the same review step (opt-in). Scanned/image-only PDFs have no text to read, so you can add rows manually or try the AI option.

#### Import Safety Features

- **Auto-categorize** — Imported transactions are assigned a category by matching a prior transaction with the same payee (most recent wins); otherwise they stay uncategorized.
- **Duplicate detection** — Duplicates are detected on import via bank FITID or synthesized keys.
- **Sign sanity check** — BudgetLion warns after preview if the amount-sign distribution looks reversed for the account type.

<div style="text-align: center;">

![Import Preview](assets/ImportPreview.png){width=75%}

</div>

### Exporting Transactions

Open **Account → Export Transactions…** (⌘E / Ctrl+E) to export the ledger as **CSV, QIF, PDF, or PNG**, or print it with **Account → Print…** (⌘P / Ctrl+P).

### Accounts / Categories / Recurring Rules (JSON)

Use **File → Export Accounts/Categories…** and **File → Import Accounts/Categories…** to move the full account, category, and recurring-rule set as JSON.

---

## Databases

A BudgetLion database is a folder ("package") containing a SQLite file. From the **File** menu:

| Item | Description |
|------|-------------|
| New DB… | Create and open a new empty database |
| Open DB… | Open an existing database folder |
| Open Default DB | Open the default database location |
| Save DB As… | Copy the current database to a new location and switch to it |
| Backup DB… | Write a ZIP archive of the database (also includes a JSON export of accounts, categories, and recurring rules) |
| Restore DB… | Expand a backup ZIP into a new location and open it |

The last-opened database reopens on launch, and its name is shown in the title bar.

---

## Settings

Open Settings from the **BudgetLion menu → Settings…** (⌘, / Ctrl+,).

### Appearance

| Setting | Description |
|---------|-------------|
| Theme | Light or dark |
| Default currency | ISO 4217 code (e.g. `USD`) |
| Ledger Font & Size | Font used in the ledger grid |
| Print / PDF Font & Size | Font used for printed and exported documents |

### Investments

| Setting | Description |
|---------|-------------|
| Fetch security prices online (Yahoo Finance) | Opt-in automated price quotes and symbol lookups for holdings (off by default) |

### AI

| Setting | Description |
|---------|-------------|
| Vendor | Choose your LLM provider |
| Model | Select the model (fetched when a valid key is entered) |
| API Key / credentials | Provider credentials (varies by vendor) |

Settings are saved to `~/.budgetlion-settings.json`.

<div style="text-align: center;">

![Settings Dialog](assets/SettingsDialog.png){width=50%}

</div>

---

## AI Assistant

AI integration in BudgetLion is **optional** and used for two features:

1. **Smarter de-duplication** — judging whether two transactions' payees/memos are similar.
2. **PDF statement extraction** — optionally extracting transactions from a statement PDF's text.

When no AI is configured, BudgetLion falls back to deterministic matching (for de-duplication) and on-device PDF text parsing.

### Supported Vendors

BudgetLion works with OpenAI-compatible providers, Anthropic, Ollama (local), and custom endpoints:

| Vendor | Vendor | Vendor |
|--------|--------|--------|
| OpenAI | Anthropic | Alibaba |
| DeepSeek | Meta | Google |
| Microsoft | Amazon | xAI |
| Groq | Perplexity | Mistral |
| Cerebras | IBM | Moonshot AI |
| Ollama (local) | Generic (OpenAI) | Generic (YAML) |

Configure the vendor, model, and API key in **Settings**.

> **Privacy note:** AI features only send data to your configured provider when you use them. De-duplication sends payee/memo pairs, and PDF extraction sends statement text — both only when you opt in. Price fetching sends security symbols to Yahoo Finance only when enabled.

---

## Keyboard Shortcuts

> On macOS, ⌘ is the Command key. On Windows and Linux, use Ctrl instead. ⇧ = Shift.

### File & Database

| Action | macOS | Windows/Linux |
|--------|-------|---------------|
| Open DB | ⌘O | Ctrl+O |
| Save DB As | ⇧⌘S | Ctrl+Shift+S |
| Settings | ⌘, | Ctrl+, |
| Quit | ⌘Q | Ctrl+Q |

### Editing

| Action | macOS | Windows/Linux |
|--------|-------|---------------|
| Undo | ⌘Z | Ctrl+Z |
| Redo | ⇧⌘Z | Ctrl+Shift+Z |
| Cut / Copy / Paste | ⌘X / ⌘C / ⌘V | Ctrl+X / Ctrl+C / Ctrl+V |

### Account & Transactions

| Action | macOS | Windows/Linux |
|--------|-------|---------------|
| New Transaction | ⌘N | Ctrl+N |
| New Paycheck | ⇧⌘P | Ctrl+Shift+P |
| Search | ⌘F | Ctrl+F |
| Recurring Rules | ⌘R | Ctrl+R |
| Import Transactions | ⌘I | Ctrl+I |
| Export Transactions | ⌘E | Ctrl+E |
| Print | ⌘P | Ctrl+P |

### View

| Action | macOS | Windows/Linux |
|--------|-------|---------------|
| Toggle Charts | ⇧⌘C | Ctrl+Shift+C |
| Toggle Forecast | ⇧⌘F | Ctrl+Shift+F |

---

## File Locations

| File | Location | Purpose |
|------|----------|---------|
| App settings | `~/.budgetlion-settings.json` | Theme, currency, fonts, AI configuration, price-fetch toggle, window state |
| Database folder | User-chosen (or the default location) | A "package" folder containing the SQLite database file |
| Backups | User-chosen | ZIP archives created by Backup DB… (include a JSON export of accounts, categories, and recurring rules) |

---

## Platform Support

| Platform | Status |
|----------|--------|
| macOS (Intel x64 and Apple Silicon ARM64) | Full support |
| Windows (x64 and ARM64) | Full support |
| Linux (x64 and ARM64) | Full support |

BudgetLion is built with Electron, React, and SQLite.

### Platform-Specific Notes

**macOS:**
- The application menu bar is in the system menu bar.
- About, Settings, License Key, and Quit are in the **BudgetLion** menu.

**Windows and Linux:**
- The same menu items appear under the leftmost **BudgetLion** menu.

---

## Troubleshooting

### Price Fetching Isn't Working

Automated price quotes and symbol lookups are **opt-in**. Enable **"Fetch security prices online (Yahoo Finance)"** in Settings. If a symbol can't be resolved, enter the price manually — unresolved symbols fall back to manual entry.

### AI Features Are Unavailable

AI is optional. If de-duplication or PDF AI extraction reports that AI isn't available, confirm you have selected a vendor and entered a valid model and API key in Settings. Without AI, BudgetLion uses deterministic matching and local PDF text parsing.

### PDF Import Found No Transactions

BudgetLion reads the PDF's text layer locally. Scanned or image-only statements have no text to read, so no transactions are detected — add rows manually in the preview, or try **Extract with AI**. If a statement's amounts import with the wrong sign, toggle the **"Amounts use loan / credit-card conventions"** option.

### Imported Amounts Look Reversed

In the import preview, amounts are shown in ledger convention — **payments/credits are positive** and **charges/withdrawals are negative**. If they look reversed, go back and toggle the **"Amounts use loan / credit-card conventions"** option.

### Resetting Settings

To reset all settings to defaults, quit BudgetLion and delete the settings file:

- `~/.budgetlion-settings.json`

Your financial data is stored separately in your database folder and is not affected.

---

### Feature Requests and Bug Reporting

You may report issues and request new features using our [GitHub issue tracker](https://github.com/richlesh/BudgetLion/issues).

---

## License Key

BudgetLion is free and open source software, but a license key helps support its continued development. Entering a key removes the registration reminder (the startup splash and the periodic AI-usage reminder) and shows your support for the project.

### Entering Your License Key

1. Open the **License Key** dialog:
   - **macOS:** BudgetLion menu → License Key
   - **Windows/Linux:** BudgetLion menu → License Key
2. Paste the email that you used to purchase the license key and the 16-character license key into the fields of the dialog.
3. If the email and license key are valid, the **Save** button will activate. Click it to save your license key in your settings file.

<div style="text-align: center;">

![License Key Dialog](assets/LicenseKeyDialog.png){width=50%}

</div>

Once activated, your license key is stored locally and remembered between sessions. If activation fails, double-check that the key was copied in full with no extra spaces.

### Why Support Open Source?

BudgetLion is released under the GNU General Public License v3.0, which means it is free to use, study, modify, and share. Open source software like this is often maintained by small teams or individuals who rely on community support to keep improving it.

Purchasing a license key — even though the software is free — directly funds:

- **Ongoing development** — New features, platform support, and other enhancements
- **Bug fixes and maintenance** — Keeping the app stable across macOS, Windows, and Linux
- **Long-term sustainability** — Ensuring the project remains actively maintained

If BudgetLion is useful to you, considering a license purchase is a meaningful way to help sustain the open source ecosystem.

---

## License

BudgetLion is © 2026 Glowing Cat Software, released under the GNU General Public License v3.0.
