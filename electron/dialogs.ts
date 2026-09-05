// Splash / About / License / Settings dialog windows, native menu, and their IPC.
// Modeled on the NeuroPanther Chat pattern but adapted to BudgetLion.
//
// These dialog windows use nodeIntegration + no context isolation (like NeuroPanther)
// because they are small, static, fully-trusted local HTML files that talk to the
// main process directly via ipcRenderer. The main application window keeps the
// secure contextIsolation + preload setup.

import { app, BrowserWindow, ipcMain, Menu, shell, type MenuItemConstructorOptions } from "electron";
import { join } from "node:path";
import { loadSettings, saveSettings, type Settings } from "./settings.js";
import { loadVendors } from "./ai/vendors.js";
import { fetchModels, getModelsForVendor } from "./ai/models.js";

// License validation lives in plain CJS at the app root (shared with the dialog HTML).
const appRoot = app.getAppPath();
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { isValidLicense } = require(join(appRoot, "utilities.cjs")) as {
  isValidLicense: (key: string, userName: string) => boolean;
};

function dialogPath(name: string): string {
  return join(appRoot, "dialogs", name);
}

function iconPath(): string {
  return join(appRoot, "resources", "app_icon_256.png");
}

function appVersion(): string {
  return app.getVersion();
}

function centerOnParent(child: BrowserWindow, parent: BrowserWindow | null): void {
  if (!parent || parent.isDestroyed()) return;
  const [px, py] = parent.getPosition();
  const [pw, ph] = parent.getSize();
  const [w, h] = child.getSize();
  child.setPosition(Math.round(px + (pw - w) / 2), Math.round(py + (ph - h) / 2));
}

let mainWinRef: BrowserWindow | null = null;

// ---- Splash ----
let splashWin: BrowserWindow | null = null;
export function showSplash(): void {
  if (splashWin && !splashWin.isDestroyed()) return splashWin.focus();
  splashWin = new BrowserWindow({
    width: 340,
    height: 360,
    resizable: false,
    frame: false,
    alwaysOnTop: true,
    show: false,
    webPreferences: { nodeIntegration: true, contextIsolation: false },
  });
  splashWin.setMenuBarVisibility(false);
  splashWin.loadFile(dialogPath("splash.html"));
  splashWin.once("ready-to-show", () => splashWin?.show());
  splashWin.webContents.once("did-finish-load", () => {
    splashWin?.webContents.send("icon-path", iconPath());
    splashWin?.webContents.send("app-version", appVersion());
  });
  splashWin.on("closed", () => (splashWin = null));
}
ipcMain.on("splash-close", () => splashWin?.close());

// ---- About ----
let aboutWin: BrowserWindow | null = null;
function showAbout(): void {
  if (aboutWin && !aboutWin.isDestroyed()) return aboutWin.focus();
  aboutWin = new BrowserWindow({
    width: 340,
    height: 460,
    resizable: false,
    minimizable: false,
    maximizable: false,
    parent: mainWinRef ?? undefined,
    modal: true,
    show: false,
    webPreferences: { nodeIntegration: true, contextIsolation: false },
  });
  aboutWin.setMenuBarVisibility(false);
  aboutWin.loadFile(dialogPath("about.html"));
  aboutWin.once("ready-to-show", () => {
    centerOnParent(aboutWin!, mainWinRef);
    aboutWin!.show();
  });
  aboutWin.webContents.once("did-finish-load", () => {
    aboutWin?.webContents.send("icon-path", iconPath());
    aboutWin?.webContents.send("app-version", appVersion());
    const s = loadSettings();
    if (s.licenseKey && s.userName && isValidLicense(s.licenseKey, s.userName)) {
      aboutWin?.webContents.send("licensed");
    }
  });
  aboutWin.on("closed", () => (aboutWin = null));
}
ipcMain.handle("close-about", () => aboutWin?.close());

// ---- License ----
let licenseWin: BrowserWindow | null = null;
function openLicense(): void {
  if (licenseWin && !licenseWin.isDestroyed()) return licenseWin.focus();
  licenseWin = new BrowserWindow({
    width: 400,
    height: 300,
    resizable: false,
    parent: mainWinRef ?? undefined,
    modal: true,
    webPreferences: { nodeIntegration: true, contextIsolation: false },
  });
  licenseWin.setMenuBarVisibility(false);
  licenseWin.loadFile(dialogPath("license.html"));
  licenseWin.webContents.once("did-finish-load", () => {
    const s = loadSettings();
    licenseWin?.webContents.send("license-data", {
      key: s.licenseKey || "",
      userName: s.userName || "",
    });
  });
  licenseWin.on("closed", () => (licenseWin = null));
}
ipcMain.handle("license-save", (_e, { key, userName }: { key: string; userName: string }) => {
  if (!isValidLicense(key, userName)) return;
  const s = loadSettings();
  s.licenseKey = key.toUpperCase();
  s.userName = userName;
  saveSettings(s);
  licenseWin?.close();
});
ipcMain.handle("license-cancel", () => licenseWin?.close());

// ---- Settings ----
let settingsWin: BrowserWindow | null = null;
function openSettings(): void {
  if (settingsWin && !settingsWin.isDestroyed()) return settingsWin.focus();
  settingsWin = new BrowserWindow({
    width: 720,
    height: 480,
    resizable: true,
    parent: mainWinRef ?? undefined,
    modal: true,
    webPreferences: { nodeIntegration: true, contextIsolation: false },
  });
  settingsWin.setMenuBarVisibility(false);
  settingsWin.loadFile(dialogPath("settings.html"));
  settingsWin.on("closed", () => (settingsWin = null));
}
ipcMain.handle("settings-close", () => settingsWin?.close());
ipcMain.handle("settings-save", (_e, partial: Partial<Settings>) => {
  const s = { ...loadSettings(), ...partial };
  saveSettings(s);
  settingsWin?.close();
  // Notify the main window so it can re-theme live.
  mainWinRef?.webContents.send("settings-changed", s);
});

// ---- Shared IPC used by all dialogs + the main renderer ----
ipcMain.handle("settings-get", () => loadSettings());

// Settings + the AI vendor catalog, for the settings dialog's LLM section.
ipcMain.handle("settings-get-data", () => ({ settings: loadSettings(), VENDORS: loadVendors() }));

// Live model-list fetching for the settings LLM section (falls back to static lists).
ipcMain.handle("get-models-for-vendor", (_e, vendor: string) => getModelsForVendor(vendor));
ipcMain.handle(
  "fetch-models",
  (_e, opts: { vendor: string; apiKey?: string; baseURL?: string }) => fetchModels(opts)
);

// Programmatic settings patch used by the renderer (window bounds, column widths,
// etc.). Unlike "settings-save" this has no UI side effects (no window close) and
// returns the merged settings. It still broadcasts so live listeners stay in sync.
ipcMain.handle("settings-patch", (_e, partial: Partial<Settings>) => {
  const s = { ...loadSettings(), ...partial };
  saveSettings(s);
  mainWinRef?.webContents.send("settings-changed", s);
  return s;
});
ipcMain.handle("open-external", (_e, url: string) => shell.openExternal(url));

// ---- Native application menu ----
export function buildMenu(mainWin: BrowserWindow): void {
  mainWinRef = mainWin;
  const isMac = process.platform === "darwin";

  const template: MenuItemConstructorOptions[] = [
    {
      label: app.name,
      submenu: [
        { label: "About BudgetLion", click: showAbout },
        { type: "separator" },
        { label: "Settings…", accelerator: "CmdOrCtrl+,", click: openSettings },
        { label: "License Key…", click: openLicense },
        { type: "separator" },
        ...(isMac
          ? ([{ role: "hide" }, { role: "hideOthers" }, { role: "unhide" }, { type: "separator" }] as MenuItemConstructorOptions[])
          : []),
        { role: "quit" },
      ],
    },
    {
      label: "File",
      submenu: [
        {
          label: "New DB…",
          click: () => BrowserWindow.getFocusedWindow()?.webContents.send("menu-db-new"),
        },
        {
          label: "Open DB…",
          accelerator: "CmdOrCtrl+O",
          click: () => BrowserWindow.getFocusedWindow()?.webContents.send("menu-db-open"),
        },
        {
          label: "Open Default DB",
          click: () => BrowserWindow.getFocusedWindow()?.webContents.send("menu-db-open-default"),
        },
        {
          label: "Save DB As…",
          accelerator: "CmdOrCtrl+Shift+S",
          click: () => BrowserWindow.getFocusedWindow()?.webContents.send("menu-db-save-as"),
        },
        {
          label: "Backup DB…",
          click: () => BrowserWindow.getFocusedWindow()?.webContents.send("menu-db-backup"),
        },
        {
          label: "Restore DB…",
          click: () => BrowserWindow.getFocusedWindow()?.webContents.send("menu-db-restore"),
        },
        { type: "separator" },
        {
          label: "New Account…",
          click: () => BrowserWindow.getFocusedWindow()?.webContents.send("menu-new-account"),
        },
        {
          label: "New Category…",
          click: () => BrowserWindow.getFocusedWindow()?.webContents.send("menu-new-category"),
        },
        { type: "separator" },
        {
          label: "Import Accounts/Categories…",
          click: () => BrowserWindow.getFocusedWindow()?.webContents.send("menu-import-data"),
        },
        {
          label: "Export Accounts/Categories…",
          click: () => BrowserWindow.getFocusedWindow()?.webContents.send("menu-export-data"),
        },
        { type: "separator" },
        isMac ? { role: "close" } : { role: "quit" },
      ],
    },
    {
      label: "Edit",
      submenu: [
        {
          label: "Undo",
          accelerator: "CmdOrCtrl+Z",
          click: () => BrowserWindow.getFocusedWindow()?.webContents.send("menu-undo"),
        },
        {
          label: "Redo",
          accelerator: "CmdOrCtrl+Shift+Z",
          click: () => BrowserWindow.getFocusedWindow()?.webContents.send("menu-redo"),
        },
        { type: "separator" },
        { role: "cut" },
        { role: "copy" },
        { role: "paste" },
        { role: "selectAll" },
      ],
    },
    {
      label: "Account",
      submenu: [
        {
          id: "acct-new-transaction",
          label: "New Transaction…",
          accelerator: "CmdOrCtrl+N",
          click: () => BrowserWindow.getFocusedWindow()?.webContents.send("menu-new-transaction"),
        },
        {
          id: "acct-new-paycheck",
          label: "New Paycheck…",
          accelerator: "CmdOrCtrl+Shift+P",
          click: () => BrowserWindow.getFocusedWindow()?.webContents.send("menu-new-paycheck"),
        },
        {
          id: "acct-new-asset",
          label: "New Asset…",
          click: () => BrowserWindow.getFocusedWindow()?.webContents.send("menu-new-asset"),
        },
        { type: "separator" },
        {
          label: "Delete Transaction…",
          click: () => BrowserWindow.getFocusedWindow()?.webContents.send("menu-delete-transaction"),
        },
        {
          label: "De-Duplicate Transactions",
          click: () => BrowserWindow.getFocusedWindow()?.webContents.send("menu-dedupe"),
        },
        {
          label: "Reconcile Account…",
          click: () => BrowserWindow.getFocusedWindow()?.webContents.send("menu-reconcile"),
        },
        { type: "separator" },
        {
          label: "Search…",
          accelerator: "CmdOrCtrl+F",
          click: () => BrowserWindow.getFocusedWindow()?.webContents.send("menu-search"),
        },
        { type: "separator" },
        {
          label: "Add to Recurring…",
          click: () => BrowserWindow.getFocusedWindow()?.webContents.send("menu-add-to-recurring"),
        },
        {
          label: "Recurring Rules…",
          accelerator: "CmdOrCtrl+R",
          click: () => BrowserWindow.getFocusedWindow()?.webContents.send("menu-recurring"),
        },
        { type: "separator" },
        {
          label: "Print…",
          accelerator: "CmdOrCtrl+P",
          click: () => BrowserWindow.getFocusedWindow()?.webContents.send("menu-print"),
        },
        { type: "separator" },
        {
          label: "Import Transactions…",
          accelerator: "CmdOrCtrl+I",
          click: () => BrowserWindow.getFocusedWindow()?.webContents.send("menu-import"),
        },
        {
          label: "Export Transactions…",
          accelerator: "CmdOrCtrl+E",
          click: () => BrowserWindow.getFocusedWindow()?.webContents.send("menu-export"),
        },
      ],
    },
    {
      label: "View",
      submenu: [
        {
          label: "Toggle Charts",
          accelerator: "CmdOrCtrl+Shift+C",
          click: () => BrowserWindow.getFocusedWindow()?.webContents.send("menu-toggle-charts"),
        },
        {
          label: "Toggle Forecast",
          accelerator: "CmdOrCtrl+Shift+F",
          click: () => BrowserWindow.getFocusedWindow()?.webContents.send("menu-toggle-forecast"),
        },
        {
          label: "Category Report…",
          click: () => BrowserWindow.getFocusedWindow()?.webContents.send("menu-category-report"),
        },
        {
          label: "Net Worth Report…",
          click: () => BrowserWindow.getFocusedWindow()?.webContents.send("menu-net-worth-report"),
        },
        { type: "separator" },
        { role: "reload" },
        {
          label: "Toggle Developer Tools",
          accelerator: isMac ? "Cmd+Option+I" : "Ctrl+Shift+I",
          click: () => BrowserWindow.getFocusedWindow()?.webContents.toggleDevTools(),
        },
        { type: "separator" },
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
      ],
    },
    {
      label: "Window",
      submenu: [
        { role: "minimize" },
        ...(isMac ? ([{ role: "zoom" }, { type: "separator" }, { role: "front" }] as MenuItemConstructorOptions[]) : []),
      ],
    },
    {
      label: "Help",
      submenu: [
        {
          label: "Online Help",
          click: () => shell.openExternal("https://glowingcat.com/BudgetLion.html"),
        },
      ],
    },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));

  // Enable/disable the account-entry items based on the selected account's type,
  // pushed from the renderer whenever the selection changes. Asset accounts allow
  // only "New Asset…"; all other (or no) accounts allow Transaction/Paycheck.
  ipcMain.removeAllListeners("account-type-changed");
  ipcMain.on("account-type-changed", (_e, type: string | null) => {
    const menu = Menu.getApplicationMenu();
    if (!menu) return;
    const isAsset = type === "asset";
    const set = (id: string, enabled: boolean) => {
      const item = menu.getMenuItemById(id);
      if (item) item.enabled = enabled;
    };
    set("acct-new-transaction", !isAsset);
    set("acct-new-paycheck", !isAsset);
    set("acct-new-asset", isAsset);
  });
}
