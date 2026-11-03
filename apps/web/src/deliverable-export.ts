import type { Case, Deliverable } from "@evianta/core";
import type { Content, TDocumentDefinitions } from "pdfmake/interfaces";

export type ExportFormat = "pdf" | "xlsx" | "json";
export type ExportContext = Pick<Case, "useCase" | "description">;

type ExportCell = string | number | boolean | null;
type ExportBlock =
  | { kind: "text"; text: string }
  | { kind: "heading"; text: string }
  | { kind: "table"; headers: string[]; rows: ExportCell[][] };

export const exportLabels: Record<ExportFormat, string> = {
  pdf: "Download PDF (.pdf)",
  xlsx: "Download Excel (.xlsx)",
  json: "Download JSON (.json)",
};

const reviewNote =
  "Draft for professional review. Not validated for government portal submission.";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function label(key: string): string {
  const words = key.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/[_-]/g, " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function isCell(value: unknown): value is string | number | boolean | null {
  return (
    value === null || ["string", "number", "boolean"].includes(typeof value)
  );
}

function cell(value: unknown): string {
  return value === null || value === undefined ? "" : String(value);
}

function tableFor(
  value: unknown,
): Extract<ExportBlock, { kind: "table" }> | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  if (value.every((row) => isRecord(row) && Object.values(row).every(isCell))) {
    const keys = [...new Set(value.flatMap((row) => Object.keys(row)))];
    if (keys.length === 0) return null;
    return {
      kind: "table",
      headers: keys.map(label),
      rows: value.map((row) => keys.map((key) => row[key] ?? null)),
    };
  }
  return null;
}

function blocksFor(value: unknown, title?: string): ExportBlock[] {
  const heading: ExportBlock[] = title
    ? [{ kind: "heading", text: title }]
    : [];
  if (isCell(value)) return [...heading, { kind: "text", text: cell(value) }];
  const table = tableFor(value);
  if (table) return [...heading, table];
  if (Array.isArray(value)) {
    return value.length === 0
      ? []
      : [
          ...heading,
          ...value.flatMap((item, index) =>
            blocksFor(item, isRecord(item) ? `Item ${index + 1}` : undefined),
          ),
        ];
  }
  if (isRecord(value)) {
    const columns = value.columns;
    const rows = value.rows;
    if (
      Array.isArray(columns) &&
      columns.length > 0 &&
      columns.every((column) => typeof column === "string") &&
      Array.isArray(rows) &&
      rows.length > 0 &&
      rows.every(
        (row) =>
          Array.isArray(row) &&
          row.length === columns.length &&
          row.every(isCell),
      )
    ) {
      return [
        ...heading,
        {
          kind: "table",
          headers: columns,
          rows,
        },
        ...Object.entries(value)
          .filter(([key]) => key !== "columns" && key !== "rows")
          .flatMap(([key, item]) => blocksFor(item, label(key))),
      ];
    }
    return [
      ...heading,
      ...Object.entries(value).flatMap(([key, item]) =>
        isCell(item)
          ? [{ kind: "text" as const, text: `${label(key)}: ${cell(item)}` }]
          : blocksFor(item, label(key)),
      ),
    ];
  }
  throw new Error("The deliverable contains unsupported export content.");
}

function sectionBlocks(deliverable: Deliverable): ExportBlock[] {
  return deliverable.sections.flatMap((section) => [
    { kind: "heading" as const, text: section.title },
    ...blocksFor(section.reviewerContent ?? section.content),
  ]);
}

function hasExplicitTable(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(hasExplicitTable);
  if (!isRecord(value)) return false;
  return Object.entries(value).some(
    ([key, item]) =>
      (["rows", "tables"].includes(key) &&
        Array.isArray(item) &&
        item.length > 0) ||
      hasExplicitTable(item),
  );
}

function requestsJson(description: string): boolean {
  return description
    .replace(/\b[\w-]+\.json\b/gi, "")
    .split(/[.\n;]+/)
    .some((sentence) => {
      if (
        /\b(?:no|not|without|avoid|exclude)\b[^,;.\n]*\bjson\b/i.test(
          sentence,
        ) ||
        /\bjson\b.{0,30}\b(?:reference|example|input|source)\b/i.test(sentence)
      )
        return false;
      return (
        /\b(?:export|output|return|deliver|download|generate|create|provide|prepare|need|want)\b.{0,60}\bjson\b/i.test(
          sentence,
        ) ||
        /\bjson\s+(?:output|file|payload|export|deliverable)\b/i.test(sentence)
      );
    });
}

export function deliverableExportFormats(
  deliverable: Deliverable,
  context?: ExportContext,
): ExportFormat[] {
  const formats: ExportFormat[] = ["pdf"];
  if (
    deliverable.format === "spreadsheet" ||
    deliverable.format === "dashboard" ||
    deliverable.sections.some(
      (section) =>
        section.kind === "table" ||
        hasExplicitTable(section.reviewerContent ?? section.content),
    ) ||
    sectionBlocks(deliverable).some(
      (block) =>
        block.kind === "table" &&
        block.rows.some((row) =>
          row.some((value) => typeof value === "number"),
        ),
    )
  )
    formats.push("xlsx");
  if (context && requestsJson(context.description)) formats.push("json");
  return formats;
}

function pdfContent(block: ExportBlock): Content {
  if (block.kind === "heading") return { text: block.text, style: "heading" };
  if (block.kind === "text") return { text: block.text, margin: [0, 0, 0, 6] };
  const tables: Content[] = [];
  for (let start = 0; start < block.headers.length; start += 6) {
    const headers = block.headers.slice(start, start + 6);
    if (block.headers.length > 6)
      tables.push({
        text: `Columns ${start + 1}-${start + headers.length}`,
        fontSize: 9,
      });
    tables.push({
      table: {
        headerRows: 1,
        widths: headers.map(() => "*"),
        body: [
          headers.map((text) => ({ text, bold: true })),
          ...block.rows.map((row) => row.slice(start, start + 6).map(cell)),
        ],
      },
      layout: "lightHorizontalLines",
      fontSize: 9,
      margin: [0, 4, 0, 10],
    });
  }
  return tables;
}

export function deliverablePdfDefinition(
  deliverable: Deliverable,
): TDocumentDefinitions {
  return {
    info: { title: deliverable.title },
    pageSize: "A4",
    pageMargins: [40, 40, 40, 45],
    defaultStyle: { font: "Roboto", fontSize: 10, lineHeight: 1.2 },
    styles: { heading: { fontSize: 12, bold: true, margin: [0, 10, 0, 5] } },
    content: [
      {
        text: deliverable.title,
        fontSize: 18,
        bold: true,
        margin: [0, 0, 0, 8],
      },
      {
        text: reviewNote,
        fontSize: 9,
        color: "#555555",
        margin: [0, 0, 0, 10],
      },
      { text: deliverable.summary, margin: [0, 0, 0, 10] },
      ...sectionBlocks(deliverable).map(pdfContent),
    ],
    footer: (page, pages) => ({
      text: `Draft | Version ${deliverable.version} | Page ${page} of ${pages}`,
      alignment: "center",
      fontSize: 8,
      margin: [0, 12, 0, 0],
    }),
  };
}

export async function buildDeliverableExport(
  deliverable: Deliverable,
  format: ExportFormat,
  context?: ExportContext,
): Promise<{
  filename: string;
  mimeType: string;
  content: Uint8Array<ArrayBuffer>;
}> {
  if (!deliverableExportFormats(deliverable, context).includes(format))
    throw new Error("This file format is not appropriate for this task.");
  const filename =
    deliverable.title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "") || "deliverable";
  const base = `${filename}-v${deliverable.version}`;
  if (format === "pdf") {
    const [{ default: pdfMake }, { default: fonts }] = await Promise.all([
      import("pdfmake/build/pdfmake"),
      import("pdfmake/build/vfs_fonts"),
    ]);
    pdfMake.addVirtualFileSystem(fonts);
    const buffer = await pdfMake
      .createPdf(deliverablePdfDefinition(deliverable))
      .getBuffer();
    return {
      filename: `${base}.pdf`,
      mimeType: "application/pdf",
      content: new Uint8Array(buffer),
    };
  }
  if (format === "xlsx") {
    const { utils, write } = await import("xlsx");
    const workbook = utils.book_new();
    const blocks = sectionBlocks(deliverable);
    const rows: string[][] = [
      [deliverable.title],
      [reviewNote],
      [deliverable.summary],
    ];
    const tableNames = new Set(["summary"]);
    for (const block of blocks) {
      if (block.kind !== "table") rows.push([block.text]);
    }
    utils.book_append_sheet(workbook, utils.aoa_to_sheet(rows), "Summary");
    let title = "Data";
    for (const block of blocks) {
      if (block.kind === "heading") title = block.text;
      if (block.kind !== "table") continue;
      const cleanTitle = title.replace(/[\\/?*[\]:]/g, " ").trim() || "Data";
      let sheetName = cleanTitle.slice(0, 31);
      let suffix = 2;
      while (tableNames.has(sheetName.toLowerCase())) {
        const tail = ` ${suffix++}`;
        sheetName = cleanTitle.slice(0, 31 - tail.length) + tail;
      }
      tableNames.add(sheetName.toLowerCase());
      const worksheet = utils.aoa_to_sheet([block.headers, ...block.rows]);
      utils.book_append_sheet(workbook, worksheet, sheetName);
    }
    const buffer: ArrayBuffer = write(workbook, {
      bookType: "xlsx",
      type: "array",
    });
    return {
      filename: `${base}.xlsx`,
      mimeType:
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      content: new Uint8Array(buffer),
    };
  }
  return {
    filename: `${base}.json`,
    mimeType: "application/json;charset=utf-8",
    content: new TextEncoder().encode(
      JSON.stringify(
        {
          ...deliverable,
          sections: deliverable.sections.map((section) => ({
            ...section,
            content: section.reviewerContent ?? section.content,
          })),
          exportNotice: reviewNote,
        },
        null,
        2,
      ),
    ),
  };
}
