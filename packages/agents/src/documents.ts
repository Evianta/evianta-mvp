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
      const wanted = options.pages ? new Set(options.pages) : null;
      const slice: DocumentSlice = {
        documentId,
        name: document.name,
        pages: [],
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
      return slice;
    },
  };
}
