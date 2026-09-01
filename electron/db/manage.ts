// Database lifecycle operations for the File menu: New, Open, Save As, Backup,
// Restore. A "database" is a FOLDER (a package on macOS) that contains
// `budgetlion.sqlite3` (plus -wal/-shm at runtime). Runs in the Electron main
// process (uses dialog, fs, adm-zip).

import { app, BrowserWindow, dialog } from "electron";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
} from "node:fs";
import { basename, join } from "node:path";
import AdmZip from "adm-zip";
import {
  DB_FILENAME,
  closeDb,
  currentDatabaseDir,
  getDb,
  setDatabaseDir,
} from "./index.js";
import { loadSettings, saveSettings } from "../settings.js";
import type { DbOpResult } from "../../src/shared/ipc.js";

/** Current database display name ("Default" for the OS default location). */
export function currentDbName(): string {
  return displayName(currentDatabaseDir());
}

/** The sqlite companion files that make up a database, if present. */
function dbFilesIn(dir: string): string[] {
  return [DB_FILENAME, `${DB_FILENAME}-wal`, `${DB_FILENAME}-shm`]
    .map((f) => join(dir, f))
    .filter((p) => existsSync(p));
}

function focusedWindow(): BrowserWindow | undefined {
  return BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
}

/**
 * Human-friendly name for a database folder. The OS default location (userData)
 * is shown as "Default" rather than its folder basename (which is the app name).
 */
function displayName(dir: string): string {
  return join(dir) === join(app.getPath("userData")) ? "Default" : basename(dir);
}

/** Persist the current DB dir and update the window title to its display name. */
function activate(dir: string): string {
  setDatabaseDir(dir);
  getDb(); // open (creates the file if new)
  const s = loadSettings();
  saveSettings({ ...s, currentDbDir: dir });
  const name = displayName(dir);
  const win = focusedWindow();
  if (win && !win.isDestroyed()) win.setTitle(`BudgetLion — ${name}`);
  return name;
}

/** On startup: adopt the saved DB dir if it exists; else default (userData). */
export function initDatabaseFromSettings(): void {
  const dir = loadSettings().currentDbDir;
  if (dir && existsSync(dir)) setDatabaseDir(dir);
}

/** Set the window title to the current DB name (called once the window exists). */
export function applyDbTitle(win: BrowserWindow): void {
  win.setTitle(`BudgetLion — ${displayName(currentDatabaseDir())}`);
}

/**
 * Open the database at the OS-specific default location (the app's userData
 * folder). Creates it if it doesn't exist yet.
 */
export async function dbOpenDefault(): Promise<DbOpResult> {
  try {
    const dir = app.getPath("userData");
    closeDb();
    const name = activate(dir);
    return { ok: true, name };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * New DB: pick a location + name for a new folder, create it, and open a fresh
 * empty database there (closing the current one first).
 */
export async function dbNew(): Promise<DbOpResult> {
  const win = focusedWindow();
  const { canceled, filePath } = await dialog.showSaveDialog(win!, {
    title: "New Database",
    defaultPath: join(app.getPath("documents"), "MyBudget"),
    buttonLabel: "Create",
    properties: ["createDirectory"],
  });
  if (canceled || !filePath) return { ok: false, canceled: true };
  try {
    if (existsSync(join(filePath, DB_FILENAME))) {
      return { ok: false, error: "A database already exists at that location." };
    }
    mkdirSync(filePath, { recursive: true });
    closeDb();
    const name = activate(filePath); // getDb() creates the empty schema
    return { ok: true, name };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * Open: pick an existing database folder and switch to it. The folder must
 * contain budgetlion.sqlite3.
 */
export async function dbOpen(): Promise<DbOpResult> {
  const win = focusedWindow();
  const { canceled, filePaths } = await dialog.showOpenDialog(win!, {
    title: "Open Database",
    defaultPath: app.getPath("documents"),
    buttonLabel: "Open",
    properties: ["openDirectory", "treatPackageAsDirectory"],
  });
  if (canceled || filePaths.length === 0) return { ok: false, canceled: true };
  const dir = filePaths[0];
  try {
    if (!existsSync(join(dir, DB_FILENAME))) {
      return { ok: false, error: "That folder does not contain a BudgetLion database." };
    }
    closeDb();
    const name = activate(dir);
    return { ok: true, name };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * Save As: pick a new folder location, copy the current database files into it,
 * and open the copy (leaving the original intact).
 */
export async function dbSaveAs(): Promise<DbOpResult> {
  const win = focusedWindow();
  const { canceled, filePath } = await dialog.showSaveDialog(win!, {
    title: "Save Database As",
    defaultPath: join(app.getPath("documents"), `${basename(currentDatabaseDir())}-copy`),
    buttonLabel: "Save",
    properties: ["createDirectory"],
  });
  if (canceled || !filePath) return { ok: false, canceled: true };
  try {
    const srcDir = currentDatabaseDir();
    if (join(filePath) === join(srcDir)) {
      return { ok: false, error: "Choose a different location than the current database." };
    }
    // Close so WAL is checkpointed and files are consistent before copying.
    closeDb();
    mkdirSync(filePath, { recursive: true });
    for (const f of dbFilesIn(srcDir)) {
      copyFileSync(f, join(filePath, basename(f)));
    }
    const name = activate(filePath); // open the copy
    return { ok: true, name };
  } catch (e) {
    // Best-effort: reopen the original so the app stays usable.
    getDb();
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * Backup: pick a .zip path, close the DB, zip the database files, then reopen
 * the current database.
 */
export async function dbBackup(): Promise<DbOpResult> {
  const win = focusedWindow();
  const { canceled, filePath } = await dialog.showSaveDialog(win!, {
    title: "Backup Database",
    defaultPath: join(app.getPath("documents"), `${basename(currentDatabaseDir())}-backup.zip`),
    buttonLabel: "Backup",
    filters: [{ name: "Zip Archive", extensions: ["zip"] }],
  });
  if (canceled || !filePath) return { ok: false, canceled: true };
  const dir = currentDatabaseDir();
  try {
    closeDb();
    const zip = new AdmZip();
    for (const f of dbFilesIn(dir)) {
      zip.addLocalFile(f);
    }
    zip.writeZip(filePath);
    return { ok: true, name: basename(dir) };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  } finally {
    // Reopen the current database regardless of outcome.
    getDb();
  }
}

/**
 * Restore: pick a backup .zip, pick a new folder location, extract the archive
 * there, and open it as the working database.
 */
export async function dbRestore(): Promise<DbOpResult> {
  const win = focusedWindow();
  const pick = await dialog.showOpenDialog(win!, {
    title: "Restore From Backup",
    defaultPath: app.getPath("documents"),
    buttonLabel: "Choose Backup",
    properties: ["openFile"],
    filters: [{ name: "Zip Archive", extensions: ["zip"] }],
  });
  if (pick.canceled || pick.filePaths.length === 0) return { ok: false, canceled: true };
  const zipPath = pick.filePaths[0];

  const save = await dialog.showSaveDialog(win!, {
    title: "Restore To",
    defaultPath: join(app.getPath("documents"), basename(zipPath).replace(/\.zip$/i, "")),
    buttonLabel: "Restore",
    properties: ["createDirectory"],
  });
  if (save.canceled || !save.filePath) return { ok: false, canceled: true };
  const dir = save.filePath;

  try {
    mkdirSync(dir, { recursive: true });
    const zip = new AdmZip(zipPath);
    zip.extractAllTo(dir, /* overwrite */ true);
    if (!existsSync(join(dir, DB_FILENAME))) {
      // The archive may contain a nested folder; try to locate the db file.
      const nested = findDbFileDir(dir);
      if (!nested) {
        return { ok: false, error: "The backup did not contain a BudgetLion database." };
      }
      closeDb();
      const name = activate(nested);
      return { ok: true, name };
    }
    closeDb();
    const name = activate(dir);
    return { ok: true, name };
  } catch (e) {
    getDb(); // keep the app usable
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** Find a directory (root or one level down) that contains the db file. */
function findDbFileDir(root: string): string | null {
  if (existsSync(join(root, DB_FILENAME))) return root;
  try {
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        const sub = join(root, entry.name);
        if (existsSync(join(sub, DB_FILENAME))) return sub;
      }
      if (entry.isFile() && entry.name === DB_FILENAME) return root;
    }
  } catch {
    // ignore
  }
  return null;
}
