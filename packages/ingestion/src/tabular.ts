import type {
  ExtractedColumnType,
  ExtractedTable,
  ExtractionWarning,
} from "@evianta/core";
import Papa from "papaparse";
import * as XLSX from "xlsx";
import type { IngestionLimits } from "./config.js";
import { inspectZip } from "./detect.js";
import { IngestionError } from "./errors.js";

export interface ParsedTables {
  tables: ExtractedTable[];
  warnings: ExtractionWarning[];
}

const numberPattern =
  /^[-+]?(?:\d{1,3}(?:,\d{2,3})+|\d+)?(?:\.\d+)?(?:e[-+]?\d+)?$/i;
const isoDatePattern =
  /^\d{4}-\d{2}-\d{2}(?:[t ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:z|[+-]\d{2}:?\d{2})?)?$/i;
const dayMonthYearPattern = /^\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4}$/;

function inferType(values: readonly string[]): ExtractedColumnType {
  if (values.length === 0) return "empty";
  const cleaned = values.map((value) => value.trim().replace(/^[₹$€£]\s?/, ""));
  if (cleaned.every((value) => /\d/.test(value) && numberPattern.test(value))) {
    return "number";
  }
  if (cleaned.every((value) => /^(true|false)$/i.test(value))) return "boolean";
  if (
    cleaned.every(
      (value) => isoDatePattern.test(value) || dayMonthYearPattern.test(value),
    )
  ) {
    return "date";
  }
  return "string";
}

export function inferColumnTypes(
  columnCount: number,
  rows: readonly (readonly (string | null)[])[],
): ExtractedColumnType[] {
  return Array.from({ length: columnCount }, (_, column) =>
    inferType(
      rows
        .map((row) => row[column])
        .filter(
          (value): value is string => value !== null && value.trim() !== "",
        ),
    ),
  );
}

export function columnName(index: number): string {
  let name = "";
  for (let value = index + 1; value > 0; value = Math.floor((value - 1) / 26)) {
    name = String.fromCharCode(65 + ((value - 1) % 26)) + name;
  }
  return name;
}

function normalizeHeaders(
  row: readonly (string | null)[],
  width: number,
): string[] {
  const seen = new Map<string, number>();
  return Array.from({ length: width }, (_, index) => {
    const base = row[index]?.trim() || `column_${index + 1}`;
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    return count === 0 ? base : `${base}_${count + 1}`;
  });
}

function assertCellLimit(
  rowCount: number,
  columnCount: number,
  limit: number,
): void {
  if (rowCount > 0 && columnCount > Math.floor(limit / rowCount)) {
    throw new IngestionError(
      "Table exceeds the cell limit",
      "cell-limit-exceeded",
    );
  }
}

function buildTable(
  id: string,
  grid: readonly (readonly (string | null)[])[],
  limits: IngestionLimits,
  location: {
    sheet?: string;
    originRow?: number;
    originColumn?: number;
    cellReferences?: boolean;
    cellRange?: string;
  } = {},
  maxCells = limits.maxTableCells,
): ExtractedTable | null {
  const width = grid.reduce((max, row) => Math.max(max, row.length), 0);
  if (grid.length === 0 || width === 0) return null;
  if (width > limits.maxColumns) {
    throw new IngestionError(
      "Table has too many columns",
      "row-limit-exceeded",
    );
  }
  if (grid.length - 1 > limits.maxRows) {
    throw new IngestionError("Table has too many rows", "row-limit-exceeded");
  }
  assertCellLimit(grid.length, width, maxCells);
  const headers = normalizeHeaders(grid[0], width);
  const rows = grid.slice(1).map((row) =>
    Array.from({ length: width }, (_, index) => {
      const value = row[index];
      return value === undefined || value === null || value === ""
        ? null
        : value;
    }),
  );
  const originRow = location.originRow ?? 0;
  const originColumn = location.originColumn ?? 0;
  const cellRange = `${columnName(originColumn)}${originRow + 1}:${columnName(originColumn + width - 1)}${originRow + grid.length}`;
  return {
    id,
    pageIndex: null,
    headers,
    rows,
    columnTypes: inferColumnTypes(width, rows),
    ...(location.sheet ? { sheet: location.sheet } : {}),
    ...(location.cellReferences === false
      ? {}
      : { cellRange: location.cellRange ?? cellRange }),
  };
}

export function parseDelimited(
  text: string,
  delimiter: "," | "\t",
  limits: IngestionLimits,
): ParsedTables {
  const result = Papa.parse<string[]>(text.replace(/^\uFEFF/, ""), {
    delimiter,
    header: false,
    skipEmptyLines: "greedy",
    dynamicTyping: false,
    // Read one row past the limit so oversize input is rejected, not truncated.
    preview: limits.maxRows + 2,
  });
  if (result.data.length > limits.maxRows + 1) {
    throw new IngestionError("Table has too many rows", "row-limit-exceeded");
  }
  const warnings: ExtractionWarning[] = result.errors
    .slice(0, 20)
    .map((error) => ({
      code: "delimited-parse-issue",
      message: `Row ${(error.row ?? 0) + 1}: ${error.message}`,
      pageIndex: null,
    }));
  const table = buildTable("table-1", result.data, limits);
  return { tables: table ? [table] : [], warnings };
}

export function parseWorkbook(
  bytes: Uint8Array,
  limits: IngestionLimits,
  isZip: boolean,
): ParsedTables {
  if (isZip) inspectZip(bytes, limits);
  let workbook: XLSX.WorkBook;
  try {
    workbook = XLSX.read(bytes, {
      type: "array",
      dense: true,
      cellFormula: false,
      cellHTML: false,
      cellStyles: false,
      bookVBA: false,
      sheetRows: limits.maxRows + 2,
    });
  } catch (error) {
    throw new IngestionError(
      "Spreadsheet could not be parsed",
      "parse-failed",
      { cause: error },
    );
  }
  if (workbook.SheetNames.length > limits.maxSheets) {
    throw new IngestionError(
      "Workbook has too many sheets",
      "row-limit-exceeded",
    );
  }
  const tables: ExtractedTable[] = [];
  const warnings: ExtractionWarning[] = [];
  let remainingCells = limits.maxTableCells;
  workbook.SheetNames.forEach((sheetName, index) => {
    const sheet = workbook.Sheets[sheetName];
    const fullRange = sheet?.["!fullref"] ?? sheet?.["!ref"];
    if (!sheet || !fullRange) return;
    const full = XLSX.utils.decode_range(fullRange);
    const rowCount = full.e.r - full.s.r + 1;
    const columnCount = full.e.c - full.s.c + 1;
    if (
      full.e.r - full.s.r > limits.maxRows ||
      full.e.r >= limits.maxRows + 2 ||
      full.e.c - full.s.c + 1 > limits.maxColumns
    ) {
      throw new IngestionError(
        `Sheet ${sheetName} exceeds the table limits`,
        "row-limit-exceeded",
      );
    }
    const availableCells = remainingCells;
    assertCellLimit(rowCount, columnCount, availableCells);
    remainingCells -= rowCount * columnCount;
    const grid = XLSX.utils.sheet_to_json<(string | null)[]>(sheet, {
      header: 1,
      raw: false,
      defval: null,
      blankrows: false,
    });
    const range = XLSX.utils.decode_range(sheet["!ref"] ?? fullRange);
    const table = buildTable(
      `sheet-${index + 1}`,
      grid,
      limits,
      {
        sheet: sheetName,
        cellRange: XLSX.utils.encode_range(range),
      },
      availableCells,
    );
    if (table) tables.push(table);
    else {
      warnings.push({
        code: "empty-sheet",
        message: `Sheet ${sheetName} is empty`,
        pageIndex: null,
      });
    }
  });
  return { tables, warnings };
}

export type ParsedJson =
  | { kind: "tabular"; tables: ExtractedTable[] }
  | { kind: "text"; text: string };

function cellValue(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean")
    return String(value);
  return JSON.stringify(value);
}

export function parseJson(text: string, limits: IngestionLimits): ParsedJson {
  let value: unknown;
  try {
    value = JSON.parse(text.replace(/^\uFEFF/, ""));
  } catch (error) {
    throw new IngestionError(
      "JSON document could not be parsed",
      "parse-failed",
      { cause: error },
    );
  }
  const isRecord = (item: unknown): item is Record<string, unknown> =>
    Boolean(item) && typeof item === "object" && !Array.isArray(item);
  if (Array.isArray(value) && value.length > 0 && value.every(isRecord)) {
    if (value.length > limits.maxRows) {
      throw new IngestionError("Table has too many rows", "row-limit-exceeded");
    }
    const headers: string[] = [];
    const seen = new Set<string>();
    for (const row of value) {
      for (const key of Object.keys(row)) {
        if (seen.has(key)) continue;
        seen.add(key);
        headers.push(key);
        if (headers.length > limits.maxColumns) {
          throw new IngestionError(
            "Table has too many columns",
            "row-limit-exceeded",
          );
        }
      }
    }
    assertCellLimit(value.length + 1, headers.length, limits.maxTableCells);
    const grid = [
      headers,
      ...value.map((row) => headers.map((header) => cellValue(row[header]))),
    ];
    const table = buildTable("table-1", grid, limits, {
      cellReferences: false,
    });
    return { kind: "tabular", tables: table ? [table] : [] };
  }
  return { kind: "text", text: JSON.stringify(value, null, 2) };
}
