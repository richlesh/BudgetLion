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

/** Build an AssetHolding (asset + latest valuation + computed cents) for one asset. */
export function holdingFor(asset: Asset, valuations: AssetValuation[]): AssetHolding {
  const latest = latestValuation(valuations);
  return {
    asset,
    latestValuation: latest,
    valueCents: assetValueCents(asset.quantityMicro, latest),
  };
}

/**
 * Compute holdings for every non-deleted asset, grouping the given valuations by
 * assetId. `valuationsByAsset` maps assetId -> its valuations (deleted rows are
 * ignored by latestValuation).
 */
export function holdingsForAssets(
  assets: Asset[],
  valuationsByAsset: Map<string, AssetValuation[]>
): AssetHolding[] {
  return assets
    .filter((a) => a.deletedAt == null)
    .map((a) => holdingFor(a, valuationsByAsset.get(a.id) ?? []));
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
