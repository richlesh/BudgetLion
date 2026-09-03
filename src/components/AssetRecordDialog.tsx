import { useMemo, useState } from "react";
import type { Account, Asset, AssetClass } from "../shared/types";
import { parseCents } from "../core/money";
import { parseAssetMeta } from "../core/assetRecord";

/** The structured result the App turns into asset/valuation operations. */
export type AssetRecordSubmit =
  | {
      action: "buy";
      description: string;
      assetClass: AssetClass;
      model: string;
      serial: string;
      purchasePriceCents: number;
      purchaseDate: string;
    }
  | {
      action: "sell" | "lost";
      assetId: string;
      salePriceCents: number; // 0 for lost
      saleDate: string;
    };

interface Props {
  account: Account; // the asset account
  /** Currently held (non-disposed) items in this account, for Sell/Lost. */
  heldItems: Asset[];
  onCancel: () => void;
  onSubmit: (rec: AssetRecordSubmit) => void | Promise<void>;
}

type Action = "buy" | "sell" | "lost";

const ASSET_CLASSES: Array<{ value: AssetClass; label: string }> = [
  { value: "real_estate", label: "Real estate" },
  { value: "vehicle", label: "Vehicle" },
  { value: "collectible", label: "Collectible" },
  { value: "other", label: "Other" },
];

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Record an asset event for a pure-holdings asset account:
 *  - Buy:  create a new item (description/model/serial/purchase price+date).
 *  - Sell: dispose an existing item at a sale price + date.
 *  - Lost: dispose an existing item at $0.
 */
export function AssetRecordDialog({ account, heldItems, onCancel, onSubmit }: Props) {
  const [action, setAction] = useState<Action>("buy");
  // Buy fields.
  const [description, setDescription] = useState("");
  const [assetClass, setAssetClass] = useState<AssetClass>("other");
  const [model, setModel] = useState("");
  const [serial, setSerial] = useState("");
  const [price, setPrice] = useState("");
  const [date, setDate] = useState(today());
  // Sell/Lost fields.
  const [assetId, setAssetId] = useState("");
  const [error, setError] = useState<string | null>(null);

  const itemOptions = useMemo(
    () =>
      heldItems.map((a) => {
        const m = parseAssetMeta(a.metadata);
        const tag = [m.model, m.serial].filter(Boolean).join(" · ");
        return { id: a.id, label: tag ? `${a.name} (${tag})` : a.name };
      }),
    [heldItems]
  );

  async function submit() {
    setError(null);
    try {
      if (action === "buy") {
        if (!description.trim()) { setError("Enter a description."); return; }
        const cents = parseCents(price);
        if (cents == null || cents < 0) { setError("Enter a valid purchase price."); return; }
        if (!date) { setError("Choose a purchase date."); return; }
        await onSubmit({
          action: "buy",
          description: description.trim(),
          assetClass,
          model: model.trim(),
          serial: serial.trim(),
          purchasePriceCents: cents,
          purchaseDate: date,
        });
      } else {
        if (!assetId) { setError("Choose an item."); return; }
        if (!date) { setError("Choose a date."); return; }
        let cents = 0;
        if (action === "sell") {
          const c = parseCents(price);
          if (c == null || c < 0) { setError("Enter a valid sale price."); return; }
          cents = c;
        }
        await onSubmit({ action, assetId, salePriceCents: cents, saleDate: date });
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save the record.");
    }
  }

  const disposing = action === "sell" || action === "lost";

  return (
    <div className="dialog-backdrop" onClick={onCancel}>
      <div className="dialog" style={{ width: 520 }} onClick={(e) => e.stopPropagation()}>
        <h3>New Asset Record — {account.name}</h3>

        <div className="field">
          <label>Type</label>
          <select value={action} onChange={(e) => setAction(e.target.value as Action)}>
            <option value="buy">Buy (add an item)</option>
            <option value="sell">Sell (dispose at a price)</option>
            <option value="lost">Lost (dispose at $0)</option>
          </select>
        </div>

        {action === "buy" ? (
          <>
            <div className="field">
              <label>Description</label>
              <input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="e.g. 2019 Subaru Outback" />
            </div>
            <div className="field">
              <label>Class</label>
              <select value={assetClass} onChange={(e) => setAssetClass(e.target.value as AssetClass)}>
                {ASSET_CLASSES.map((c) => (
                  <option key={c.value} value={c.value}>{c.label}</option>
                ))}
              </select>
            </div>
            <div className="field">
              <label>Model number</label>
              <input value={model} onChange={(e) => setModel(e.target.value)} placeholder="Model (optional)" />
            </div>
            <div className="field">
              <label>Serial number</label>
              <input value={serial} onChange={(e) => setSerial(e.target.value)} placeholder="Serial (optional)" />
            </div>
            <div className="field">
              <label>Purchase price</label>
              <input value={price} onChange={(e) => setPrice(e.target.value)} placeholder="0.00" style={{ textAlign: "right" }} />
            </div>
            <div className="field">
              <label>Purchase date</label>
              <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
            </div>
          </>
        ) : (
          <>
            <div className="field">
              <label>Item</label>
              <select value={assetId} onChange={(e) => setAssetId(e.target.value)}>
                <option value="">— Choose item —</option>
                {itemOptions.map((o) => (
                  <option key={o.id} value={o.id}>{o.label}</option>
                ))}
              </select>
            </div>
            {action === "sell" && (
              <div className="field">
                <label>Sale price</label>
                <input value={price} onChange={(e) => setPrice(e.target.value)} placeholder="0.00" style={{ textAlign: "right" }} />
              </div>
            )}
            <div className="field">
              <label>{action === "sell" ? "Sale date" : "Lost date"}</label>
              <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
            </div>
            <div className="account-type">
              Disposing removes the item from holdings{action === "lost" ? " at $0" : ""}.
            </div>
          </>
        )}

        {error && <div className="error">{error}</div>}
        <div className="dialog-actions">
          <button className="secondary" onClick={onCancel}>Cancel</button>
          <button onClick={submit} disabled={disposing && itemOptions.length === 0}>
            {action === "buy" ? "Add item" : action === "sell" ? "Record sale" : "Mark lost"}
          </button>
        </div>
      </div>
    </div>
  );
}
