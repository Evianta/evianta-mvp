import type { DocumentMetadataRecord, OwnerScope } from "@evianta/core";
import { describe, expect, it, vi } from "vitest";
import { createDocumentAccess } from "../src/documents.js";

describe("createDocumentAccess", () => {
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
