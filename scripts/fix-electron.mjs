// Repairs node_modules/electron after install.
//
// Why this exists:
// On this machine, electron's own postinstall (install.js -> extract-zip) fails
// to fully extract the macOS Electron.app bundle, leaving node_modules/electron/dist
// with only "Electron.app" + "LICENSE" and no "version"/path.txt. That produces:
//   "Error: Electron failed to install correctly, please delete node_modules/electron..."
// The downloaded zip itself is valid, so we re-extract it with the system `unzip`,
// which handles the app-bundle symlinks correctly.
//
// This script is idempotent and a no-op when electron is already installed correctly.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const electronDir = path.join(root, "node_modules", "electron");

function log(msg) {
  console.log(`[fix-electron] ${msg}`);
}

if (!fs.existsSync(electronDir)) {
  log("node_modules/electron not present; skipping.");
  process.exit(0);
}

const pkg = JSON.parse(
  fs.readFileSync(path.join(electronDir, "package.json"), "utf8"),
);
const version = pkg.version;
const distDir = path.join(electronDir, "dist");
const versionFile = path.join(distDir, "version");
const pathTxt = path.join(electronDir, "path.txt");

function isInstalled() {
  try {
    const v = fs.readFileSync(versionFile, "utf8").replace(/^v/, "").trim();
    if (v !== version) return false;
    if (!fs.existsSync(pathTxt)) return false;
    const rel = fs.readFileSync(pathTxt, "utf8").trim();
    return fs.existsSync(path.join(distDir, rel));
  } catch {
    return false;
  }
}

if (isInstalled()) {
  log(`electron ${version} already installed correctly.`);
  process.exit(0);
}

log(`electron ${version} not fully installed; attempting repair...`);

// 1) Make sure the zip is in electron's cache. electron's install.js downloads
//    to the cache even when its extraction step fails, so run it first.
try {
  execFileSync(process.execPath, [path.join(electronDir, "install.js")], {
    stdio: "inherit",
  });
} catch {
  // install.js extraction may fail; the download to cache is what we need.
}

// 2) Locate the cached zip under ~/Library/Caches/electron (or platform equivalent).
const platform = process.platform;
const arch = process.arch;
const zipName = `electron-v${version}-${platform}-${arch}.zip`;

function cacheRoots() {
  const home = os.homedir();
  if (platform === "darwin") {
    return [path.join(home, "Library", "Caches", "electron")];
  }
  if (platform === "win32") {
    return [path.join(process.env.LOCALAPPDATA || home, "electron", "Cache")];
  }
  return [
    path.join(process.env.XDG_CACHE_HOME || path.join(home, ".cache"), "electron"),
  ];
}

function findZip() {
  for (const rootDir of cacheRoots()) {
    if (!fs.existsSync(rootDir)) continue;
    // Zip may sit directly in the cache root or in a hashed subdir.
    const direct = path.join(rootDir, zipName);
    if (fs.existsSync(direct)) return direct;
    for (const entry of fs.readdirSync(rootDir)) {
      const candidate = path.join(rootDir, entry, zipName);
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  return null;
}

const zip = findZip();
if (!zip) {
  log(`ERROR: could not find cached ${zipName}. Try: npm rebuild electron`);
  process.exit(1);
}
log(`extracting ${zip}`);

// 3) Extract with the system unzip (handles macOS app-bundle symlinks correctly).
fs.rmSync(distDir, { recursive: true, force: true });
fs.mkdirSync(distDir, { recursive: true });
if (platform === "win32") {
  // PowerShell Expand-Archive fallback for Windows.
  execFileSync(
    "powershell",
    [
      "-NoProfile",
      "-Command",
      `Expand-Archive -LiteralPath '${zip}' -DestinationPath '${distDir}' -Force`,
    ],
    { stdio: "inherit" },
  );
} else {
  execFileSync("unzip", ["-q", zip, "-d", distDir], { stdio: "inherit" });
}

// 4) Write path.txt (matches what electron's install.js would write).
const exeRel =
  platform === "darwin"
    ? "Electron.app/Contents/MacOS/Electron"
    : platform === "win32"
      ? "electron.exe"
      : "electron";
fs.writeFileSync(pathTxt, exeRel);

if (isInstalled()) {
  log(`repaired electron ${version}.`);
  process.exit(0);
}
log("ERROR: repair did not produce a valid installation.");
process.exit(1);
