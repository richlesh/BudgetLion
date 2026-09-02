// In-memory, session-scoped undo/redo journal for transaction-level edits.
// Runs only in the Electron main process.
//
// Approach: row-level SNAPSHOT journal. Around each mutating operation we capture
// the full "before" and "after" row values (as stored) for every affected row in
// the covered tables (transactions + transaction_splits). Undo restores the
// "before" snapshot; redo restores the "after". Because every table uses soft
// deletes (deleted_at) and full-row storage, restoring is just writing the row
// back — a missing "before" (an insert) is undone by soft-deleting the row.
//
// Scope (v1): transactions + transaction_splits. Capped at 50 operations,
// undo + redo, cleared on DB open/switch.

import type Database from "better-sqlite3";
import { getDb } from "./index.js";

/** Tables the journal snapshots. Both are keyed by a text `id` PK. */
const TABLES = ["transactions", "transaction_splits"] as const;
type CoveredTable = (typeof TABLES)[number];

/** A stored row as a plain column->value map (or null if the row didn't exist). */
type RowSnapshot = Record<string, unknown> | null;

interface RowChange {
  table: CoveredTable;
  id: string;
  before: RowSnapshot;
  after: RowSnapshot;
}

interface UndoEntry {
  label: string;
  changes: RowChange[];
}

const CAP = 50;
const undoStack: UndoEntry[] = [];
const redoStack: UndoEntry[] = [];

// Re-entrancy: when a bulk operation wraps several already-wrapped mutations,
// the inner withUndo calls should NOT push their own entries — the outermost
// call captures the whole batch as one undo step. Depth > 0 means "inside a
// wrapper already".
let captureDepth = 0;

/** Clear both stacks (call on DB open/new/save-as/restore). */
export function clearUndo(): void {
  undoStack.length = 0;
  redoStack.length = 0;
}

export function canUndo(): boolean {
  return undoStack.length > 0;
}
export function canRedo(): boolean {
  return redoStack.length > 0;
}
/** Labels of the next undo/redo (for menu/UI), or null. */
export function undoState(): { canUndo: boolean; canRedo: boolean; undoLabel: string | null; redoLabel: string | null } {
  return {
    canUndo: undoStack.length > 0,
    canRedo: redoStack.length > 0,
    undoLabel: undoStack.length > 0 ? undoStack[undoStack.length - 1].label : null,
    redoLabel: redoStack.length > 0 ? redoStack[redoStack.length - 1].label : null,
  };
}

/** Read a single row from a covered table as a plain object, or null if absent. */
function readRow(db: Database.Database, table: CoveredTable, id: string): RowSnapshot {
  const row = db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(id) as
    | Record<string, unknown>
    | undefined;
  return row ?? null;
}

/**
 * Collect every transaction_splits id belonging to a set of transaction ids
 * (regardless of deleted state), so split changes are captured alongside their
 * parent transaction.
 */
function splitIdsForTxns(db: Database.Database, txIds: string[]): string[] {
  if (txIds.length === 0) return [];
  const placeholders = txIds.map(() => "?").join(",");
  const rows = db
    .prepare(`SELECT id FROM transaction_splits WHERE transaction_id IN (${placeholders})`)
    .all(...txIds) as Array<{ id: string }>;
  return rows.map((r) => r.id);
}

/** Snapshot the given transaction ids + their split rows into a map keyed by table|id. */
function snapshot(
  db: Database.Database,
  txIds: string[],
  splitIds: string[]
): Map<string, RowChange> {
  const map = new Map<string, RowChange>();
  for (const id of txIds) {
    map.set(`transactions|${id}`, { table: "transactions", id, before: null, after: null });
  }
  for (const id of splitIds) {
    map.set(`transaction_splits|${id}`, {
      table: "transaction_splits",
      id,
      before: null,
      after: null,
    });
  }
  return map;
}

/**
 * Run a covered mutation with undo capture. `txIds` are the transaction ids the
 * operation will touch (existing ones). `fn` performs the mutation and may return
 * additional (newly created) transaction ids to include in the snapshot.
 * Captures before/after for those transactions and all their split rows.
 */
export function withUndo(label: string, txIds: string[], fn: () => string[] | void): void {
  // Nested call (inside a bulk wrapper): just run; the outer call captures it all.
  if (captureDepth > 0) {
    fn();
    return;
  }
  const db = getDb();
  captureDepth++;
  try {
    // BEFORE: gather the ids we know about plus their current split rows.
    const beforeSplitIds = splitIdsForTxns(db, txIds);
    const changes = snapshot(db, txIds, beforeSplitIds);
    for (const c of changes.values()) c.before = readRow(db, c.table, c.id);

    // Run the mutation; collect any newly created transaction ids.
    const created = fn() || [];
    const allTxIds = Array.from(new Set([...txIds, ...created]));

    // AFTER: the affected transactions plus the (possibly new) set of split rows.
    const afterSplitIds = splitIdsForTxns(db, allTxIds);
    for (const id of created) {
      const k = `transactions|${id}`;
      if (!changes.has(k)) changes.set(k, { table: "transactions", id, before: null, after: null });
    }
    for (const id of afterSplitIds) {
      const k = `transaction_splits|${id}`;
      if (!changes.has(k))
        changes.set(k, { table: "transaction_splits", id, before: null, after: null });
    }
    for (const c of changes.values()) c.after = readRow(db, c.table, c.id);

    // Keep only rows that actually changed (before !== after by JSON).
    const real = Array.from(changes.values()).filter(
      (c) => JSON.stringify(c.before) !== JSON.stringify(c.after)
    );
    if (real.length === 0) return; // no-op mutation: don't record

    undoStack.push({ label, changes: real });
    if (undoStack.length > CAP) undoStack.shift();
    redoStack.length = 0; // a new action invalidates redo
  } finally {
    captureDepth--;
  }
}

/** Write a snapshot back into a table: upsert all columns, or hide via soft-delete
 *  when the target snapshot is null (the row should not exist in that state). */
function restore(db: Database.Database, change: RowChange, target: RowSnapshot): void {
  if (target === null) {
    // The row should be absent in this state. We never hard-delete; mark deleted.
    // (Only meaningful for rows that currently exist.)
    const exists = db.prepare(`SELECT 1 FROM ${change.table} WHERE id = ?`).get(change.id);
    if (exists) {
      const ts = new Date().toISOString();
      db.prepare(`UPDATE ${change.table} SET deleted_at = ?, updated_at = ? WHERE id = ?`).run(
        ts,
        ts,
        change.id
      );
    }
    return;
  }
  // Upsert every column from the snapshot (insert if missing, else overwrite).
  const cols = Object.keys(target);
  const placeholders = cols.map((c) => `@${c}`).join(", ");
  const updates = cols.map((c) => `${c} = @${c}`).join(", ");
  db.prepare(
    `INSERT INTO ${change.table} (${cols.join(", ")}) VALUES (${placeholders})
     ON CONFLICT(id) DO UPDATE SET ${updates}`
  ).run(target as Record<string, unknown>);
}

/** Undo the most recent operation. Returns false if nothing to undo. */
export function undo(): boolean {
  const entry = undoStack.pop();
  if (!entry) return false;
  const db = getDb();
  const run = db.transaction(() => {
    // Restore each row to its BEFORE state (reverse order for safety).
    for (let i = entry.changes.length - 1; i >= 0; i--) {
      restore(db, entry.changes[i], entry.changes[i].before);
    }
  });
  run();
  redoStack.push(entry);
  return true;
}

/** Redo the most recently undone operation. Returns false if nothing to redo. */
export function redo(): boolean {
  const entry = redoStack.pop();
  if (!entry) return false;
  const db = getDb();
  const run = db.transaction(() => {
    for (const c of entry.changes) restore(db, c, c.after);
  });
  run();
  undoStack.push(entry);
  return true;
}
