import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import type { ImageInput } from "@evianta/ai";
import type { PositionedSpan } from "@evianta/core";
import { createCanvas } from "@napi-rs/canvas";
import {
  getDocument,
  type PDFDocumentProxy,
  type PDFPageProxy,
} from "pdfjs-dist/legacy/build/pdf.mjs";
import type { IngestionLimits } from "./config.js";
import { IngestionError, withTimeout } from "./errors.js";
import { boundedScale, encodeCanvas } from "./image.js";

const require = createRequire(import.meta.url);
const standardFontDataUrl = `${join(dirname(require.resolve("pdfjs-dist/package.json")), "standard_fonts")}/`;

export interface PdfPageContent {
  index: number;
  width: number;
  height: number;
  text: string;
  spans: PositionedSpan[];
  load: () => Promise<ImageInput>;
}

export interface OpenedPdf {
  pageCount: number;
  page(index: number): Promise<PdfPageContent>;
  close(): Promise<void>;
}

interface TextItemLike {
  str: string;
  hasEOL?: boolean;
  width: number;
  height: number;
  transform: number[];
}

const clamp = (value: number) => Math.min(1, Math.max(0, value));

function spanFor(
  item: TextItemLike,
  page: PDFPageProxy,
): PositionedSpan | null {
  const viewport = page.getViewport({ scale: 1 });
  const [a, b, c, d, x, y] = item.transform;
  const scaleX = Math.hypot(a, b);
  const scaleY = Math.hypot(c, d);
  if (!scaleX || !scaleY) return null;
  const width = item.width / scaleX;
  const height = (item.height || scaleY) / scaleY;
  const corners = [
    [0, 0],
    [width, 0],
    [0, height],
    [width, height],
  ].map(([u, v]) =>
    viewport.convertToViewportPoint(a * u + c * v + x, b * u + d * v + y),
  );
  const xs = corners.map((point) => point[0]);
  const ys = corners.map((point) => point[1]);
  const left = clamp(Math.min(...xs) / viewport.width);
  const top = clamp(Math.min(...ys) / viewport.height);
  const right = clamp(Math.max(...xs) / viewport.width);
  const bottom = clamp(Math.max(...ys) / viewport.height);
  if (right <= left || bottom <= top) return null;
  return {
    text: item.str,
    bbox: { x: left, y: top, width: right - left, height: bottom - top },
  };
}

/**
 * Opens a PDF with scripting, XFA and font loading disabled and decoded image
 * size bounded, then exposes per-page text layers with normalized positions
 * and an on-demand bounded raster for OCR.
 */
export async function openPdf(
  bytes: Uint8Array,
  limits: IngestionLimits,
): Promise<OpenedPdf> {
  // pdf.js transfers the buffer to its worker, so hand it a copy.
  const loadingTask = getDocument({
    data: new Uint8Array(bytes),
    enableXfa: false,
    disableFontFace: true,
    useSystemFonts: false,
    stopAtErrors: false,
    maxImageSize: limits.maxImagePixels,
    standardFontDataUrl,
    verbosity: 0,
  });
  let document: PDFDocumentProxy;
  try {
    document = await withTimeout(
      loadingTask.promise,
      limits.parserTimeoutMs,
      () => {
        void loadingTask.destroy();
      },
    );
  } catch (error) {
    await loadingTask.destroy();
    if (error instanceof IngestionError) throw error;
    throw new IngestionError("PDF could not be parsed", "parse-failed", {
      cause: error,
    });
  }
  if (document.numPages > limits.maxPages) {
    await loadingTask.destroy();
    throw new IngestionError(
      `PDF has ${document.numPages} pages; the limit is ${limits.maxPages}`,
      "page-limit-exceeded",
    );
  }

  return {
    pageCount: document.numPages,
    async page(index) {
      const page = await withTimeout(
        document.getPage(index + 1),
        limits.parserTimeoutMs,
      );
      const content = await withTimeout(
        page.getTextContent(),
        limits.parserTimeoutMs,
      );
      const items = content.items.filter(
        (item): item is TextItemLike & typeof item => "str" in item,
      );
      const text = items
        .map((item) => item.str + (item.hasEOL ? "\n" : ""))
        .join("")
        .replace(/[ \t]+\n/g, "\n")
        .trim();
      const spans = items
        .filter((item) => item.str.trim() !== "")
        .map((item) => spanFor(item, page))
        .filter((span): span is PositionedSpan => span !== null);
      const viewport = page.getViewport({ scale: 1 });
      return {
        index,
        width: viewport.width,
        height: viewport.height,
        text,
        spans,
        load: async () => {
          const scale = boundedScale(viewport, limits, 2);
          const scaled = page.getViewport({ scale });
          const canvas = createCanvas(
            Math.max(1, Math.ceil(scaled.width)),
            Math.max(1, Math.ceil(scaled.height)),
          );
          const context = canvas.getContext("2d");
          context.fillStyle = "#ffffff";
          context.fillRect(0, 0, canvas.width, canvas.height);
          const task = page.render({
            canvas: canvas as unknown as HTMLCanvasElement,
            viewport: scaled,
          });
          try {
            await withTimeout(task.promise, limits.parserTimeoutMs, () =>
              task.cancel(),
            );
          } catch (error) {
            if (error instanceof IngestionError) throw error;
            throw new IngestionError(
              "PDF page could not be rendered",
              "parse-failed",
              { cause: error },
            );
          }
          return encodeCanvas(canvas);
        },
      };
    },
    async close() {
      await loadingTask.destroy();
    },
  };
}
