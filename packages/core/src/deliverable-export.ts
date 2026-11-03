import type { Case, Deliverable, WorkProduct } from "./domain.js";
import { savedWorkProduct } from "./domain.js";
import type { Content, TDocumentDefinitions } from "pdfmake/interfaces.js";

export type ExportFormat = "pdf" | "xlsx" | "json";
export type ExportContext = Pick<Case, "useCase" | "description">;

type ExportCell = string | number | boolean | null;
type ExportBlock =
  | { kind: "text"; text: string }
  | { kind: "heading"; text: string }
  | {
      kind: "table";
      headers: string[];
      rows: ExportCell[][];
      columnFormats?: WorkProduct["schedules"][number]["columnFormats"];
      currencyCode?: string;
    };

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
  if (deliverable.workProduct) {
    const product = savedWorkProduct(deliverable)!;
    return [
      { kind: "text", text: product.body },
      ...product.schedules.flatMap((schedule) => [
        { kind: "heading" as const, text: schedule.title },
        {
          kind: "table" as const,
          headers: schedule.columns,
          rows: schedule.rows,
          columnFormats: schedule.columnFormats,
          currencyCode: schedule.currencyCode,
        },
      ]),
      ...(product.sources.length
        ? [
            {
              kind: "heading" as const,
              text: "Referenced documents (upload originals separately)",
            },
            ...product.sources.map((source) => ({
              kind: "text" as const,
              text: source.reference,
            })),
          ]
        : []),
    ];
  }
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

function isInternalAnalysis(
  deliverable: Deliverable,
  context?: ExportContext,
): boolean {
  return (
    !deliverable.workProduct &&
    !!context &&
    ["msme-payment", "tax-notice"].includes(context.useCase) &&
    deliverable.sections.some(
      (section) => isRecord(section.content) && "taskId" in section.content,
    )
  );
}

export function deliverableExportFormats(
  deliverable: Deliverable,
  context?: ExportContext,
): ExportFormat[] {
  if (isInternalAnalysis(deliverable, context)) return [];
  if (deliverable.workProduct) {
    const formats: ExportFormat[] = ["pdf"];
    if (
      deliverable.workProduct.schedules.some((schedule) => schedule.rows.length)
    )
      formats.push("xlsx");
    if (context && requestsJson(context.description)) formats.push("json");
    return formats;
  }
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
      ...(!deliverable.workProduct
        ? [{ text: deliverable.summary, margin: [0, 0, 0, 10] } as Content]
        : []),
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
  if (isInternalAnalysis(deliverable, context)) {
    throw new Error(
      "This is internal analysis, not a drafted document. Prepare a document before exporting.",
    );
  }
  if (!deliverableExportFormats(deliverable, context).includes(format))
    throw new Error("This file format is not appropriate for this task.");
  if (deliverable.workProduct) {
    const text = JSON.stringify(sectionBlocks(deliverable)) + deliverable.title;
    const internalIds = [
      deliverable.id,
      deliverable.caseId,
      deliverable.runId,
      ...deliverable.sections.flatMap((section) => [
        section.id,
        ...section.findingIds,
        ...section.evidenceIds,
      ]),
      ...deliverable.workProduct.sources.map((source) => source.documentId),
    ];
    if (internalIds.some((id) => text.includes(id)))
      throw new Error(
        "The document contains internal identifiers. Remove them from the draft before exporting.",
      );
  }
  const filename =
    deliverable.title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "") || "deliverable";
  const base = `${filename}-v${deliverable.version}`;
  if (format === "pdf") {
    const [{ default: pdfMake }, { default: fonts }] = await Promise.all([
      import("pdfmake/build/pdfmake.js"),
      import("pdfmake/build/vfs_fonts.js"),
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
      ...(!deliverable.workProduct ? [[deliverable.summary]] : []),
    ];
    const tableNames = new Set(["summary"]);
    for (const block of blocks) {
      if (block.kind !== "table" && !deliverable.workProduct)
        rows.push([block.text]);
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
      const dataRows = block.rows.map((row) =>
        row.map((value, column) =>
          block.columnFormats?.[column] === "date" && typeof value === "string"
            ? (Date.parse(`${value}T00:00:00Z`) - Date.UTC(1899, 11, 30)) /
              86_400_000
            : value,
        ),
      );
      const worksheet = utils.aoa_to_sheet([block.headers, ...dataRows]);
      for (const [column, format] of (block.columnFormats ?? []).entries()) {
        for (let row = 1; row <= block.rows.length; row += 1) {
          const value = worksheet[utils.encode_cell({ r: row, c: column })];
          if (!value) continue;
          if (format === "currency")
            value.z = `"${block.currencyCode}" #,##0.00`;
          if (format === "date") value.z = "yyyy-mm-dd";
        }
      }
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
          ...(deliverable.workProduct
            ? {
                ...savedWorkProduct(deliverable),
                sources: deliverable.workProduct.sources.map((source) => ({
                  reference: source.reference,
                })),
              }
            : deliverable),
          ...(!deliverable.workProduct
            ? {
                sections: deliverable.sections.map((section) => ({
                  ...section,
                  content: section.reviewerContent ?? section.content,
                })),
              }
            : {}),
          exportNotice: reviewNote,
        },
        null,
        2,
      ),
    ),
  };
}

export async function buildGeneratedBundle(
  files: Array<{ filename: string; content: Uint8Array }>,
): Promise<Uint8Array<ArrayBuffer>> {
  if (!files.length) throw new Error("No generated files are available.");
  if (
    files.reduce((sum, file) => sum + file.content.byteLength, 0) >
    100 * 1024 * 1024
  )
    throw new Error(
      "The generated bundle exceeds 100 MB. Download documents individually.",
    );
  const { zipSync } = await import("fflate");
  const entries: Record<string, Uint8Array> = {};
  files.forEach((file, index) => {
    const name = file.filename.replace(/[^a-zA-Z0-9._-]/g, "-");
    entries[`${String(index + 1).padStart(2, "0")}-${name}`] = file.content;
  });
  return new Uint8Array(zipSync(entries));
}
