// Main-process Excel (.xls/.xlsx) reader. Runs in Node (Electron main) only.
// Parses a workbook's FIRST sheet into a row/column grid of stringified cells,
// so the renderer can reuse the exact same CSV column-mapping import flow.
//
// SheetJS (xlsx) is a CommonJS package and this file compiles to CommonJS, so a
// plain import works. No network, no macros are executed — cells are read as
// data only.
import * as XLSX from "xlsx";

/** True when a file name looks like an Excel workbook we can parse. */
export function isExcelFile(fileName: string): boolean {
  return /\.(xlsx|xlsm|xlsb|xls)$/i.test(fileName.trim());
}

/**
 * Read Excel bytes and return the first sheet as a string[][] grid. Dates are
 * emitted as ISO (yyyy-mm-dd) so the existing date parsing can handle them;
 * other cells use their displayed/formatted text. Fully-empty trailing rows are
 * dropped. Returns [] when the workbook has no sheets/rows.
 */
export function excelToGrid(bytes: Uint8Array): string[][] {
  const wb = XLSX.read(bytes, { type: "array", cellDates: true });
  const firstSheetName = wb.SheetNames[0];
  if (!firstSheetName) return [];
  const sheet = wb.Sheets[firstSheetName];
  if (!sheet) return [];

  // header:1 -> array-of-arrays (each row is an array of cell values in column
  // order). raw:true keeps native types so date cells arrive as Date objects
  // (cellDates) — normalized to ISO below — and numbers stay numeric; defval:""
  // keeps column alignment for blank cells; blankrows:false drops empty rows.
  const aoa = XLSX.utils.sheet_to_json<unknown[]>(sheet, {
    header: 1,
    raw: true,
    defval: "",
    blankrows: false,
  });

  const grid: string[][] = aoa.map((row) =>
    (Array.isArray(row) ? row : []).map((cell) => cellToString(cell))
  );

  // Trim trailing all-empty rows (SheetJS can pad to the used range).
  while (grid.length > 0 && grid[grid.length - 1].every((c) => c.trim() === "")) {
    grid.pop();
  }
  return grid;
}

/** Normalize a single cell value to a trimmed string; Date -> ISO yyyy-mm-dd. */
function cellToString(cell: unknown): string {
  if (cell == null) return "";
  if (cell instanceof Date) {
    // Use the local calendar date (spreadsheet dates are calendar dates, not
    // instants); avoid a UTC shift turning a date into the previous day.
    const y = cell.getFullYear();
    const m = String(cell.getMonth() + 1).padStart(2, "0");
    const d = String(cell.getDate()).padStart(2, "0");
    return `${y}-${m}-${d}`;
  }
  return String(cell).trim();
}
