// Copies non-TS assets needed at runtime by the compiled Electron main process.
// Currently: electron/db/schema.sql -> dist-electron/electron/db/schema.sql
// Also writes a CommonJS type marker so dist-electron/*.js are loaded as CJS,
// even though the root package.json is "type": "module".
import { copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

const assets = [["electron/db/schema.sql", "dist-electron/electron/db/schema.sql"]];

for (const [src, dest] of assets) {
  const from = join(root, src);
  const to = join(root, dest);
  mkdirSync(dirname(to), { recursive: true });
  copyFileSync(from, to);
  console.log(`copied ${src} -> ${dest}`);
}

// Mark dist-electron as CommonJS.
const marker = join(root, "dist-electron", "package.json");
mkdirSync(dirname(marker), { recursive: true });
writeFileSync(marker, JSON.stringify({ type: "commonjs" }) + "\n");
console.log("wrote dist-electron/package.json (type: commonjs)");
