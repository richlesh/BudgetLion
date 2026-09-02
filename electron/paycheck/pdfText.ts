// Main-process PDF text extraction for paycheck stubs. Runs in Node (Electron
// main) only. Uses pdfjs-dist's legacy ESM build to pull the text layer out of a
// (digitally generated) pay-stub PDF. No OCR and no AI: scanned/image-only PDFs
// yield little or no text and fall back to manual entry in the dialog.
//
// pdfjs-dist@4 is ESM-only, but this file is compiled to CommonJS. A normal
// `import()` gets down-leveled by TypeScript to require(), which cannot load an
// .mjs module. The `new Function(...)` wrapper forces a genuine runtime dynamic
// import() that survives transpilation.
const dynamicImport = new Function("s", "return import(s);") as (s: string) => Promise<unknown>;

interface TextItem {
  str?: string;
  transform?: number[]; // [a,b,c,d,e,f]; e=x, f=y
}
interface TextContent {
  items: Array<TextItem | { type: string }>;
}
interface PDFPageProxy {
  getTextContent(): Promise<TextContent>;
}
interface PDFDocumentProxy {
  numPages: number;
  getPage(n: number): Promise<PDFPageProxy>;
}
interface PdfjsModule {
  getDocument(src: { data: Uint8Array; useSystemFonts?: boolean }): { promise: Promise<PDFDocumentProxy> };
  GlobalWorkerOptions: { workerSrc: string };
}

/**
 * Extract text from a PDF's bytes, reconstructing lines from the text-layer item
 * positions (pdfjs returns positioned glyphspans, not lines). Items are grouped
 * by their y coordinate (rounded) and ordered left-to-right, so a stub's
 * "Label   amount   ytd" row comes back as one line.
 */
export async function extractPdfText(bytes: Uint8Array): Promise<string> {
  const pdfjs = (await dynamicImport("pdfjs-dist/legacy/build/pdf.mjs")) as PdfjsModule;
  // In Node/Electron-main there's no DOM worker. Point workerSrc at the packaged
  // legacy worker module so pdfjs doesn't try (and fail) to spin up a fake worker.
  // This file compiles to CommonJS, so `require.resolve` is available at runtime.
  try {
    pdfjs.GlobalWorkerOptions.workerSrc = require.resolve(
      "pdfjs-dist/legacy/build/pdf.worker.mjs"
    );
  } catch {
    // If resolution fails, fall through; getDocument may still work in some envs.
  }

  const doc = await pdfjs.getDocument({ data: bytes, useSystemFonts: true }).promise;
  const out: string[] = [];

  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const content = await page.getTextContent();
    // Group text items into lines by rounded y position.
    const rows = new Map<number, Array<{ x: number; s: string }>>();
    for (const it of content.items) {
      const item = it as TextItem;
      if (typeof item.str !== "string" || item.str.length === 0) continue;
      const tf = item.transform ?? [1, 0, 0, 1, 0, 0];
      const x = tf[4] ?? 0;
      const y = Math.round(tf[5] ?? 0);
      const arr = rows.get(y) ?? [];
      arr.push({ x, s: item.str });
      rows.set(y, arr);
    }
    // Emit rows top-to-bottom (larger y first in PDF coordinate space).
    const ys = [...rows.keys()].sort((a, b) => b - a);
    for (const y of ys) {
      const cells = (rows.get(y) ?? []).sort((a, b) => a.x - b.x);
      out.push(cells.map((c) => c.s).join(" ").replace(/\s+/g, " ").trim());
    }
  }

  return out.join("\n");
}
