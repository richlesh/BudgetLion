// Asset holdings and net-worth computation. Pure, framework-agnostic.
//
// Value model (Phase 1) — UNITS ARE PRECISE, READ CAREFULLY:
//   * quantityMicro : quantity in MICRO-UNITS (shares/units x 1e6). 1.0 unit == 1_000_000.
//   * valueMicros   : per-unit value in MICRO-CENTS (cents per unit x 1e6), i.e.
//                     dollars_per_unit x 100 x 1e6. A $88.40/share price is
//                     88.40 x 100 x 1e6 = 8_840_000_000. A single indivisible asset
//                     worth $450,000 has quantityMicro 1_000_000 and valueMicros
//                     450000 x 100 x 1e6 = 45_000_000_000_000.
//   * worth_cents   = round(quantityMicro * valueMicros / 1e12), because
//                     (quantityMicro/1e6 units) * (valueMicros/1e6 cents-per-unit) = cents.
// Use microCentsPerUnitFromDollars()/dollarsFromMicroCentsPerUnit() to convert at the
// UI boundary so the scale is never applied by hand. All money stays integer-based;
// only the final division rounds to whole cents.

import type {
  Account,
  AccountWorth,
  Asset,
  AssetHolding,
  AssetValuation,
  InvestmentTransaction,
  SecurityHolding,
  Transaction,
  TransactionSplit,
} from "../shared/types";
import { MICRO } from "../shared/types";
import { currentBalance } from "./balances";

/** Account types whose worth includes asset holdings (not just cash). */
export function isValuedAccount(type: Account["type"]): boolean {
  return type === "investment" || type === "asset";
}

/** Convert a share/unit count (e.g. 12.5) to micro-units (12_500_000). */
export function quantityMicroFromUnits(units: number): number {
  return Math.round(units * MICRO);
}

/** Convert micro-units back to a unit count for display. */
export function unitsFromQuantityMicro(quantityMicro: number): number {
  return quantityMicro / MICRO;
}

/**
 * Convert a per-unit price in dollars (e.g. 88.40) to `valueMicros`
 * (micro-cents per unit): dollars x 100 (=> cents) x 1e6 (=> micro-cents).
 */
export function microCentsPerUnitFromDollars(dollarsPerUnit: number): number {
  return Math.round(dollarsPerUnit * 100 * MICRO);
}

/** Convert `valueMicros` (micro-cents per unit) back to a dollars-per-unit number. */
export function dollarsFromMicroCentsPerUnit(valueMicros: number): number {
  return valueMicros / 100 / MICRO;
}

/** The latest (max asOfDate) non-deleted valuation for an asset, or null. */
export function latestValuation(valuations: AssetValuation[]): AssetValuation | null {
  let best: AssetValuation | null = null;
  for (const v of valuations) {
    if (v.deletedAt != null) continue;
    if (best === null || v.asOfDate > best.asOfDate) best = v;
  }
  return best;
}

/**
 * Worth of one asset in cents given its latest per-unit valuation.
 * Returns 0 when there is no valuation. Uses Math.round for the final cents.
 */
export function assetValueCents(quantityMicro: number, latest: AssetValuation | null): number {
  if (!latest) return 0;
  // (quantityMicro * valueMicros) / (MICRO * MICRO) == cents
  return Math.round((quantityMicro * latest.valueMicros) / (MICRO * MICRO));
}

/**
 * Build an AssetHolding (asset + latest valuation + computed cents) for one asset.
 * For security assets, pass the asset's lots so shares are derived from them;
 * other asset classes use the stored quantityMicro (pass an empty lots array).
 */
export function holdingFor(
  asset: Asset,
  valuations: AssetValuation[],
  lots: InvestmentTransaction[] = []
): AssetHolding {
  const latest = latestValuation(valuations);
  const qtyMicro = effectiveQuantityMicro(asset, lots);
  return {
    asset,
    latestValuation: latest,
    valueCents: assetValueCents(qtyMicro, latest),
  };
}

/**
 * Compute holdings for every non-deleted asset. `valuationsByAsset` maps assetId
 * -> its valuations; `lotsByAsset` maps assetId -> its investment-transaction lots
 * (used only for security assets). Deleted rows are ignored downstream.
 */
export function holdingsForAssets(
  assets: Asset[],
  valuationsByAsset: Map<string, AssetValuation[]>,
  lotsByAsset: Map<string, InvestmentTransaction[]> = new Map()
): AssetHolding[] {
  return assets
    .filter((a) => a.deletedAt == null)
    .map((a) => holdingFor(a, valuationsByAsset.get(a.id) ?? [], lotsByAsset.get(a.id) ?? []));
}

/**
 * Net worth of a single account.
 *   cashCents     = opening balance + signed transaction effects (split-aware)
 *   holdingsCents = sum of the account's asset holding values (0 for cash accounts)
 *   worthCents    = cashCents + holdingsCents
 */
export function accountWorth(
  account: Account,
  transactions: Transaction[],
  splitsByTx: Map<string, TransactionSplit[]>,
  holdings: AssetHolding[]
): AccountWorth {
  const cashCents = currentBalance(account, transactions, splitsByTx);
  const holdingsCents = isValuedAccount(account.type)
    ? holdings.reduce((sum, h) => sum + h.valueCents, 0)
    : 0;
  return {
    accountId: account.id,
    cashCents,
    holdingsCents,
    worthCents: cashCents + holdingsCents,
  };
}

/** Total net worth across accounts = sum of each account's worthCents. */
export function totalNetWorthCents(worths: AccountWorth[]): number {
  return worths.reduce((sum, w) => sum + w.worthCents, 0);
}

// ---- Investment transactions (Option A): shares & cost basis from lots ----

/**
 * Net shares (in micro-units) held for a security, as the signed sum of its
 * non-deleted investment-transaction lots. Buy/reinvest add, sell subtracts,
 * cash dividends contribute 0 shares.
 */
export function sharesMicroFromLots(lots: InvestmentTransaction[]): number {
  return lots.reduce((s, l) => (l.deletedAt == null ? s + l.quantityMicro : s), 0);
}

/**
 * Average-cost basis (in cents) of the shares still held. Buys and reinvestments
 * add cost (shares*price + fees); sells remove cost proportionally at the running
 * average; cash dividends don't affect basis. Lots are processed in date order.
 */
export function costBasisFromLots(lots: InvestmentTransaction[]): number {
  const ordered = lots
    .filter((l) => l.deletedAt == null)
    .slice()
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  let shares = 0; // micro-units
  let basis = 0; // cents
  for (const l of ordered) {
    if (l.action === "buy" || l.action === "reinvest") {
      // Cost of acquired shares = shares*price + fees.
      const cost = Math.round((l.quantityMicro * l.priceMicros) / (MICRO * MICRO)) + l.feesCents;
      shares += l.quantityMicro;
      basis += cost;
    } else if (l.action === "sell") {
      const sold = -l.quantityMicro; // quantityMicro is negative for sells
      const avgPerMicro = shares > 0 ? basis / shares : 0;
      const removed = Math.round(avgPerMicro * sold);
      shares -= sold;
      basis -= removed;
      if (shares <= 0) {
        shares = 0;
        basis = 0;
      }
    }
    // 'div' (cash): no share/basis change.
  }
  return Math.max(0, basis);
}

/**
 * Build a SecurityHolding for one security asset from its lots and valuations.
 * Shares come from the lots; market value uses the latest valuation price.
 */
export function securityHolding(
  asset: Asset,
  lots: InvestmentTransaction[],
  valuations: AssetValuation[]
): SecurityHolding {
  const sharesMicro = sharesMicroFromLots(lots);
  const latest = latestValuation(valuations);
  const marketValueCents = assetValueCents(sharesMicro, latest);
  return {
    asset,
    sharesMicro,
    costBasisCents: costBasisFromLots(lots),
    latestValuation: latest,
    marketValueCents,
  };
}

/**
 * The effective quantity (micro-units) of an asset: for security assets the net
 * shares from lots; for all other classes the stored quantityMicro. Pass the
 * asset's lots (empty for non-securities).
 */
export function effectiveQuantityMicro(asset: Asset, lots: InvestmentTransaction[]): number {
  return asset.assetClass === "security" ? sharesMicroFromLots(lots) : asset.quantityMicro;
}

/**
 * Signed cash effect (cents) on the account for a proposed trade, given the
 * gross value (units*price, in cents) and fees. Used to preview the "cash amount"
 * in the UI and to write the linked cash transaction.
 *   buy      -> -(gross + fees)
 *   sell     -> +(gross - fees)
 *   div      -> +(cashDividend - fees)
 *   reinvest ->  0 (dividend immediately buys shares)
 */
export function tradeCashCents(
  action: InvestmentTransaction["action"],
  grossCents: number,
  feesCents: number,
  cashDividendCents = 0
): number {
  switch (action) {
    case "buy":
      return -(grossCents + feesCents);
    case "sell":
      return grossCents - feesCents;
    case "div":
      return cashDividendCents - feesCents;
    case "reinvest":
      return 0;
  }
}
