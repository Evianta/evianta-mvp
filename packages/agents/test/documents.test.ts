import type {
  DocumentMetadataRecord,
  ExtractedDocument,
  OwnerScope,
} from "@evianta/core";
import { describe, expect, it, vi } from "vitest";
import {
  createDocumentAccess,
  extractionReliability,
} from "../src/documents.js";

describe("createDocumentAccess", () => {
  it("summarizes all page reliability and repeated warnings without copying their arrays", () => {
    const extraction: ExtractedDocument = {
      documentId: "long-document",
      kind: "text",
      method: "mixed",
      confidence: 0.9,
      pages: Array.from({ length: 200 }, (_, index) => ({
        index,
        text: "Source text",
        width: null,
        height: null,
        method: index === 199 ? "handwriting" : "pdf-text",
        confidence: index === 199 ? 0.4 : 1,
        spans: [],
      })),
      warnings: Array.from({ length: 200 }, (_, pageIndex) => ({
        code: "handwriting-needs-review",
        message: "Verify the original handwritten source.",
        pageIndex,
      })),
      tables: [],
      cacheIdentity: {
        contentHash: "hash",
        extractorVersion: "1",
        modelVersion: null,
      },
    };

    expect(extractionReliability(extraction)).toEqual({
      method: "mixed",
      confidence: 0.9,
      pageCount: 200,
      minimumPageConfidence: 0.4,
      hasHandwriting: true,
      warningCount: 200,
      warningCodes: ["handwriting-needs-review"],
    });
    expect(extraction.pages).toHaveLength(200);
    expect(extraction.warnings).toHaveLength(200);
    expect(extraction.pages[199]).toMatchObject({
      method: "handwriting",
      confidence: 0.4,
    });
  });

  it("refreshes only requested tabular documents with bounded concurrency", async () => {
    const scope: OwnerScope = { ownerId: "owner-1", caseId: "case-1" };
    const documents: DocumentMetadataRecord[] = Array.from(
      { length: 8 },
      (_, index) => ({
        id: `document-${index}`,
        caseId: scope.caseId,
        name: index === 6 ? "notes.pdf" : `sales-${index}.csv`,
        mimeType: index === 6 ? "application/pdf" : "text/csv",
        sizeBytes: 1,
        state: "ready",
        uploadedAt: "2026-10-30T00:00:00.000Z",
        processedAt: "2026-10-30T00:00:00.000Z",
        objectKey: `objects/${index}`,
        contentHash: `hash-${index}`,
      }),
    );
    const extractedDocumentIds: string[] = [];
    const findForDocument = vi.fn(async (documentId: string) => {
      extractedDocumentIds.push(documentId);
      return null;
    });
    const documentsRepository = {
      listOwned: vi.fn(async () => documents),
      findOwned: vi.fn(
        async (documentId: string) =>
          documents.find((document) => document.id === documentId) ?? null,
      ),
    };
    let activeRefreshes = 0;
    let maxActiveRefreshes = 0;
    const refreshedDocumentIds: string[] = [];
    const refreshTabularExtraction = vi.fn(async (documentId: string) => {
      refreshedDocumentIds.push(documentId);
      activeRefreshes++;
      maxActiveRefreshes = Math.max(maxActiveRefreshes, activeRefreshes);
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      activeRefreshes--;
    });
    const access = createDocumentAccess(
      {
        documents: documentsRepository,
        extractions: { findForDocument },
      },
      scope,
      { refreshTabularExtraction },
    );

    await access.tablesAsync(
      Array.from({ length: 7 }, (_, index) => `document-${index}`),
    );

    expect(extractedDocumentIds).toEqual(
      Array.from({ length: 7 }, (_, index) => `document-${index}`),
    );
    expect(refreshedDocumentIds).toEqual(
      Array.from({ length: 6 }, (_, index) => `document-${index}`),
    );
    expect(maxActiveRefreshes).toBeLessThanOrEqual(4);
  });
});
