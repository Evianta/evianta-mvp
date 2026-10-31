import type {
  DocumentRepository,
  ExtractionRepository,
  OwnerScope,
} from "@evianta/core";
import type { DocumentAccess, DocumentSlice } from "./agent.js";

const DEFAULT_MAX_CHARS = 20_000;
const MAX_CONCURRENT_DOCUMENT_READS = 4;
const tabularMimeTypes = new Set([
  "application/json",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "text/csv",
  "text/tab-separated-values",
]);

function isTabularDocument(document: {
  name: string;
  mimeType: string;
}): boolean {
  return (
    /\.(csv|tsv|xlsx?|json)$/i.test(document.name) ||
    tabularMimeTypes.has(document.mimeType.toLowerCase())
  );
}

async function mapBounded<T, R>(
  values: readonly T[],
  callback: (value: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = [];
  for (
    let start = 0;
    start < values.length;
    start += MAX_CONCURRENT_DOCUMENT_READS
  ) {
    results.push(
      ...(await Promise.all(
        values
          .slice(start, start + MAX_CONCURRENT_DOCUMENT_READS)
          .map(callback),
      )),
    );
  }
  return results;
}

/**
 * Bounded, owner-scoped document access. Only processed documents are
 * visible and every slice is capped so agents never receive whole files.
 */
export function createDocumentAccess(
  repositories: {
    documents: Pick<DocumentRepository, "listOwned" | "findOwned">;
    extractions: Pick<ExtractionRepository, "findForDocument">;
  },
  scope: OwnerScope,
  settings: {
    maxChars?: number;
    refreshTabularExtraction?: (
      documentId: string,
      scope: OwnerScope,
    ) => Promise<void>;
  } = {},
): DocumentAccess {
  return {
    async listAsync() {
      const documents = await repositories.documents.listOwned(scope);
      return documents
        .filter((document) => document.state === "ready")
        .map((document) => ({
          id: document.id,
          name: document.name,
          mimeType: document.mimeType,
          state: document.state,
        }));
    },
    async tablesAsync(documentIds) {
      const requested = new Set(documentIds);
      const documents = await repositories.documents.listOwned(scope);
      const ready = documents.filter(
        (document) => document.state === "ready" && requested.has(document.id),
      );
      const refreshTabularExtraction = settings.refreshTabularExtraction;
      if (refreshTabularExtraction) {
        const tabular = ready.filter(isTabularDocument);
        await mapBounded(tabular, (document) =>
          refreshTabularExtraction(document.id, scope),
        );
      }
      const extractions = await mapBounded(ready, (document) =>
        repositories.extractions.findForDocument(document.id, scope),
      );
      return ready.flatMap((document, index) =>
        (extractions[index]?.tables ?? []).map((table) => ({
          documentId: document.id,
          name: document.name,
          table,
        })),
      );
    },
    async sliceAsync(documentId, options = {}) {
      const document = await repositories.documents.findOwned(
        documentId,
        scope,
      );
      if (!document || document.state !== "ready") return null;
      const extraction = await repositories.extractions.findForDocument(
        documentId,
        scope,
      );
      if (!extraction) return null;
      let remaining =
        options.maxChars ?? settings.maxChars ?? DEFAULT_MAX_CHARS;
      if (!Number.isSafeInteger(remaining) || remaining < 1)
        throw new RangeError("maxChars must be a positive integer");
      const wanted = options.pages ? new Set(options.pages) : null;
      const slice: DocumentSlice = {
        documentId,
        name: document.name,
        pages: [],
        tables: [],
        truncated: false,
      };
      for (const page of extraction.pages) {
        const number = page.index + 1;
        if (wanted && !wanted.has(number)) continue;
        if (remaining <= 0) {
          slice.truncated = true;
          break;
        }
        const text = page.text.slice(0, remaining);
        if (text.length < page.text.length) slice.truncated = true;
        remaining -= text.length;
        slice.pages.push({ page: number, text });
      }
      for (const table of extraction.tables) {
        if (
          wanted &&
          (table.pageIndex === null || !wanted.has(table.pageIndex + 1))
        )
          continue;
        if (remaining <= 0) {
          slice.truncated = true;
          break;
        }
        let text = "";
        for (const row of [table.headers, ...table.rows]) {
          const line = `${JSON.stringify(row)}\n`;
          const included = line.slice(0, remaining);
          text += included;
          remaining -= included.length;
          if (included.length < line.length) {
            slice.truncated = true;
            break;
          }
        }
        slice.tables!.push({
          tableId: table.id,
          sheet:
            "sheet" in table && typeof table.sheet === "string"
              ? table.sheet
              : null,
          cellRange:
            "cellRange" in table && typeof table.cellRange === "string"
              ? table.cellRange
              : null,
          text,
        });
      }
      return slice;
    },
  };
}
