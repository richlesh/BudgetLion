// Electron main process entry point.

import { app, BrowserWindow } from "electron";
import { join } from "node:path";
import { closeDb, getDb } from "../db/index.js";
import { registerIpcHandlers } from "../ipc/handlers.js";
import { buildMenu, showSplash } from "../dialogs.js";
import { loadSettings, saveSettings } from "../settings.js";

const isDev = process.env.NODE_ENV === "development";

function createWindow(): void {
  // macOS uses the packaged .icns from the app bundle and ignores the
  // BrowserWindow icon, so only set it for Windows/Linux where the window
  // and taskbar icon come from this option.
  const windowIcon =
    process.platform === "darwin"
      ? undefined
      : join(app.getAppPath(), "resources", "app_icon_256.png");

  // Restore the last window size/position when available.
  const saved = loadSettings().windowBounds;

  const win = new BrowserWindow({
    width: saved?.width ?? 1200,
    height: saved?.height ?? 800,
    ...(saved && saved.x != null && saved.y != null ? { x: saved.x, y: saved.y } : {}),
    minWidth: 800,
    minHeight: 500,
    title: "BudgetLion",
    show: false,
    ...(windowIcon ? { icon: windowIcon } : {}),
    webPreferences: {
      // Compiled preload sits next to main.js at dist-electron/electron/preload/preload.js
      preload: join(__dirname, "..", "preload", "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false, // preload needs Node's contextBridge; sandbox off is standard for this setup
    },
  });

  if (isDev) {
    win.loadURL("http://localhost:5173");
    win.webContents.openDevTools({ mode: "detach" });
  } else {
    // Packaged renderer: dist/index.html relative to app root.
    win.loadFile(join(__dirname, "..", "..", "..", "dist", "index.html"));
  }

  win.once("ready-to-show", () => win.show());
  buildMenu(win);

  // Persist window bounds on resize/move (debounced) so they restore next launch.
  let boundsTimer: NodeJS.Timeout | null = null;
  const persistBounds = () => {
    if (boundsTimer) clearTimeout(boundsTimer);
    boundsTimer = setTimeout(() => {
      if (win.isDestroyed() || win.isMinimized()) return;
      const b = win.getBounds();
      const current = loadSettings();
      saveSettings({
        ...current,
        windowBounds: { width: b.width, height: b.height, x: b.x, y: b.y },
      });
    }, 400);
  };
  win.on("resize", persistBounds);
  win.on("move", persistBounds);
}

app.whenReady().then(() => {
  getDb(); // initialize schema on startup
  registerIpcHandlers();
  showSplash();
  createWindow();
});

// Closing the main window quits the app on all platforms (macOS included),
// rather than the macOS convention of staying resident with no windows.
app.on("window-all-closed", () => {
  app.quit();
});

app.on("will-quit", () => {
  closeDb();
});
