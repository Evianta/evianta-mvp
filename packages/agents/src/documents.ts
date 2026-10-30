import type {
  DocumentRepository,
  ExtractionRepository,
  OwnerScope,
} from "@evianta/core";
import type { DocumentAccess, DocumentSlice } from "./agent.js";

const DEFAULT_MAX_CHARS = 20_000;

/**
 * Bounded, owner-scoped document access. Only processed documents are
 * visible and every slice is capped so agents never receive whole files.
 */
export function createDocumentAccess(
  repositories: {
    documents: DocumentRepository;
    extractions: ExtractionRepository;
  },
  scope: OwnerScope,
  defaults: { maxChars?: number } = {},
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
        options.maxChars ?? defaults.maxChars ?? DEFAULT_MAX_CHARS;
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
