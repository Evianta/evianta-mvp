import { createCanvas } from "@napi-rs/canvas";
import { PDFDocument, StandardFonts } from "pdf-lib";
import UTIF from "utif2";
import * as XLSX from "xlsx";

/**
 * Synthetic ingestion fixtures, generated in-process so no binary blobs or
 * real customer documents are committed.
 */

export function scannedImage(
  lines: readonly string[],
  options: { width?: number; height?: number; handwriting?: boolean } = {},
): Buffer {
  const width = options.width ?? 600;
  const height = options.height ?? 300;
  const canvas = createCanvas(width, height);
  const context = canvas.getContext("2d");
  context.fillStyle = "#f4f1ea";
  context.fillRect(0, 0, width, height);
  context.fillStyle = "#1d1d1d";
  context.font = options.handwriting ? "italic 26px serif" : "22px sans-serif";
  lines.forEach((line, index) => {
    context.save();
    if (options.handwriting) context.rotate(-0.02 * (index + 1));
    context.fillText(line, 30, 60 + index * 40);
    context.restore();
  });
  return canvas.toBuffer("image/png");
}

export type PdfPageSpec =
  | { kind: "text"; lines: readonly string[] }
  | { kind: "scanned"; lines: readonly string[] };

export async function pdfFixture(
  pages: readonly PdfPageSpec[],
): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  for (const spec of pages) {
    const page = pdf.addPage([612, 792]);
    if (spec.kind === "text") {
      spec.lines.forEach((line, index) => {
        page.drawText(line, { x: 72, y: 720 - index * 20, size: 12, font });
      });
    } else {
      const image = await pdf.embedPng(
        scannedImage(spec.lines, { width: 612, height: 792 }),
      );
      page.drawImage(image, { x: 0, y: 0, width: 612, height: 792 });
    }
  }
  return pdf.save();
}

export const nativeTextPdf = () =>
  pdfFixture([
    {
      kind: "text",
      lines: [
        "Intimation under section 143(1)",
        "Assessment year 2024-25",
        "Demand: INR 48,200",
      ],
    },
    {
      kind: "text",
      lines: [
        "Annexure A: computation of demand",
        "Interest under section 234B",
      ],
    },
  ]);

export const scannedPdf = (pageCount = 1) =>
  pdfFixture(
    Array.from({ length: pageCount }, (_, index) => ({
      kind: "scanned" as const,
      lines: [`Scanned invoice page ${index + 1}`],
    })),
  );

export const mixedPdf = () =>
  pdfFixture([
    { kind: "text", lines: ["Show cause notice", "Reply due within 30 days"] },
    { kind: "scanned", lines: ["Annexure: purchase order copy"] },
    { kind: "text", lines: ["Signed by the assessing officer", "Ward 12(3)"] },
  ]);

export const plainImage = () =>
  scannedImage(["INVOICE 1042", "Total INR 1,18,000"]);

export const handwritingImage = () =>
  scannedImage(["Received goods in good condition", "- R. Sharma, 14 March"], {
    handwriting: true,
  });

export const csvFixture = () =>
  Buffer.from(
    'invoice,date,amount,paid\nINV-1,2026-01-05,1200.50,true\nINV-2,2026-02-11,"3,400",false\nINV-3,2026-03-02,,true\n',
  );

export function xlsxFixture(): Buffer {
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(
    workbook,
    XLSX.utils.aoa_to_sheet([
      ["Vendor", "Invoice", "Amount"],
      ["Acme Supplies", "A-17", 52000],
      ["Bharat Tools", "B-03", 18500],
    ]),
    "Ledger",
  );
  XLSX.utils.book_append_sheet(
    workbook,
    XLSX.utils.aoa_to_sheet([["Note"], ["Synthetic"]]),
    "Notes",
  );
  return XLSX.write(workbook, { type: "buffer", bookType: "xlsx" }) as Buffer;
}

export function tiffFixture(): Buffer {
  const width = 40;
  const height = 20;
  const rgba = new Uint8Array(width * height * 4).fill(255);
  for (let x = 5; x < 35; x += 1)
    rgba.set([0, 0, 0, 255], (10 * width + x) * 4);
  return Buffer.from(UTIF.encodeImage(rgba, width, height));
}

export function pngSize(bytes: Uint8Array): { width: number; height: number } {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}
