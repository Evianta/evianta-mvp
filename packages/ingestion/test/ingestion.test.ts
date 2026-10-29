import { createHash, randomUUID } from "node:crypto";
import {
  AdmissionRejectedError,
  createAi,
  MockProvider,
  type ModelSettings,
  type UsageAccounting,
  type UsageAttempt,
} from "@evianta/ai";
import {
  CaseSchema,
  syntheticWorkflowFixtures,
  type DocumentMetadataRecord,
  type OwnerScope,
} from "@evianta/core";
import { createInMemoryStore, InMemoryDocumentStore } from "@evianta/store";
import { describe, expect, it, vi } from "vitest";
import {
  createDocumentIngestion,
  createMuseOcrBackend,
  handwritingWarningCode,
  incompleteWarningCode,
  IngestionError,
  isIncomplete,
  lowConfidenceWarningCode,
  pageNotExtractedWarningCode,
  requiresReview,
  type IngestionOptions,
  type OcrBackend,
} from "../src/index.js";
import {
  csvFixture,
  handwritingImage,
  mixedPdf,
  nativeTextPdf,
  plainImage,
  pngSize,
  scannedPdf,
  tiffFixture,
  xlsxFixture,
} from "./fixtures.js";

const ownerScope: OwnerScope = { ownerId: "owner-1", caseId: "case-1" };
const usageContext = { userId: "owner-1", caseId: "case-1" };
const mimeTypes = {
  pdf: "application/pdf",
  png: "image/png",
  tiff: "image/tiff",
  csv: "text/csv",
  json: "application/json",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
} as const;

const ocrResponse = (text: string, method = "ocr", confidence = 0.95) =>
  JSON.stringify({ text, method, confidence });

interface HarnessOptions {
  responses?: string[];
  failure?: Error;
  accounting?: Partial<UsageAccounting>;
  models?: Partial<ModelSettings>;
  ingestion?: IngestionOptions;
  modelVersion?: string;
  ocr?: OcrBackend | null;
}

function createHarness(options: HarnessOptions = {}) {
  const store = createInMemoryStore();
  const storage = new InMemoryDocumentStore(50 * 1024 * 1024);
  const provider = new MockProvider({
    responses: options.responses,
    failure: options.failure,
  });
  const generate = vi.spyOn(provider, "generateStructured");
  const recorded: UsageAttempt[] = [];
  const accounting: UsageAccounting = {
    mode: "admitted",
    admit: vi.fn(async () => undefined),
    record: vi.fn(async (attempt: UsageAttempt) => {
      recorded.push(attempt);
    }),
    cancel: vi.fn(async () => undefined),
    ...options.accounting,
  };
  const ai = createAi({
    provider,
    accounting,
    models: {
      provider: "mock",
      sparkModel: "mock-spark",
      wonderModel: "mock-wonder",
      ...options.models,
    },
  });
  const ocr =
    options.ocr === undefined
      ? createMuseOcrBackend({
          ai,
          modelVersion: options.modelVersion ?? "mock-spark",
        })
      : options.ocr;
  const build = (ingestion = options.ingestion, backend = ocr) =>
    createDocumentIngestion({
      documents: store.repositories.documents,
      extractions: store.repositories.extractions,
      storage,
      ocr: backend,
      options: ingestion,
    });

  async function addCase(caseId = ownerScope.caseId, ownerId = "owner-1") {
    await store.repositories.cases.insert(
      CaseSchema.parse({
        ...syntheticWorkflowFixtures.dataAnalysis.case,
        id: caseId,
        title: caseId,
        ownerId,
        isSample: false,
        synthetic: true,
        sourceCaseId: null,
      }),
    );
  }

  async function addDocument(
    bytes: Uint8Array,
    mimeType: string,
    name: string,
    scope: OwnerScope = ownerScope,
  ): Promise<DocumentMetadataRecord> {
    const contentHash = createHash("sha256").update(bytes).digest("hex");
    const objectKey = await storage.uploadAsync(scope.caseId, mimeType, {
      body: (async function* () {
        yield bytes;
      })(),
      contentLength: bytes.byteLength,
      contentHash,
    });
    const record: DocumentMetadataRecord = {
      id: randomUUID(),
      caseId: scope.caseId,
      name,
      mimeType,
      sizeBytes: bytes.byteLength,
      state: "uploaded",
      uploadedAt: "2026-05-01T10:00:00.000Z",
      processedAt: null,
      objectKey,
      contentHash,
    } as DocumentMetadataRecord;
    await store.repositories.documents.insert(record, scope);
    return record;
  }

  const stateOf = async (id: string, scope = ownerScope) =>
    (await store.repositories.documents.findOwned(id, scope))?.state;

  return {
    store,
    storage,
    accounting,
    recorded,
    generate,
    ingestion: build(),
    build,
    addCase,
    addDocument,
    stateOf,
  };
}

async function setup(options: HarnessOptions = {}) {
  const harness = createHarness(options);
  await harness.addCase();
  return harness;
}

const ingestRequest = (documentId: string) => ({
  scope: ownerScope,
  documentId,
  usageContext,
});

describe("deterministic extraction", () => {
  it("parses CSV into typed tables without model calls", async () => {
    const h = await setup();
    const doc = await h.addDocument(csvFixture(), mimeTypes.csv, "ledger.csv");

    const result = await h.ingestion.ingest(ingestRequest(doc.id));

    expect(result.status).toBe("ready");
    expect(h.generate).not.toHaveBeenCalled();
    const extraction = result.extraction!;
    expect(extraction).toMatchObject({
      kind: "tabular",
      method: "parse",
      confidence: 1,
      cacheIdentity: { modelVersion: null },
    });
    expect(extraction.tables[0]).toMatchObject({
      headers: ["invoice", "date", "amount", "paid"],
      columnTypes: ["string", "date", "number", "boolean"],
    });
    expect(extraction.tables[0].rows).toHaveLength(3);
    expect(extraction.tables[0].rows[1][2]).toBe("3,400");
    expect(await h.stateOf(doc.id)).toBe("ready");
  });

  it("parses every XLSX sheet with sheet names and cell ranges", async () => {
    const h = await setup();
    const doc = await h.addDocument(
      xlsxFixture(),
      mimeTypes.xlsx,
      "ledger.xlsx",
    );

    const result = await h.ingestion.ingest(ingestRequest(doc.id));

    expect(result.status).toBe("ready");
    expect(h.generate).not.toHaveBeenCalled();
    const [ledger, notes] = result.extraction!.tables;
    expect(ledger).toMatchObject({
      sheet: "Ledger",
      cellRange: "A1:C3",
      headers: ["Vendor", "Invoice", "Amount"],
      columnTypes: ["string", "string", "number"],
    });
    expect(ledger.rows[0]).toEqual(["Acme Supplies", "A-17", "52000"]);
    expect(notes).toMatchObject({ sheet: "Notes", headers: ["Note"] });
  });

  it("turns JSON arrays of objects into tables", async () => {
    const h = await setup();
    const doc = await h.addDocument(
      Buffer.from(
        JSON.stringify([
          { id: 1, ok: true },
          { id: 2, ok: false },
        ]),
      ),
      mimeTypes.json,
      "rows.json",
    );

    const result = await h.ingestion.ingest(ingestRequest(doc.id));

    expect(result.extraction!.tables[0]).toMatchObject({
      headers: ["id", "ok"],
      rows: [
        ["1", "true"],
        ["2", "false"],
      ],
    });
  });

  it("uses the PDF text layer with positioned spans and no OCR", async () => {
    const h = await setup();
    const doc = await h.addDocument(
      await nativeTextPdf(),
      mimeTypes.pdf,
      "notice.pdf",
    );

    const result = await h.ingestion.ingest(ingestRequest(doc.id));

    expect(result.status).toBe("ready");
    expect(result.ocrPages).toEqual([]);
    expect(h.generate).not.toHaveBeenCalled();
    const extraction = result.extraction!;
    expect(extraction.method).toBe("pdf-text");
    expect(extraction.pages).toHaveLength(2);
    expect(extraction.pages[0].text).toContain("Assessment year 2024-25");
    const span = extraction.pages[0].spans.find((item) =>
      item.text.includes("Demand"),
    );
    expect(span).toBeDefined();
    for (const value of Object.values(span!.bbox)) {
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(1);
    }
    expect(requiresReview(extraction)).toBe(false);
  });
});

describe("OCR extraction", () => {
  it("OCRs scanned PDF pages through the admitted mock provider", async () => {
    const h = await setup({
      responses: [ocrResponse("Scanned invoice page 1")],
    });
    const doc = await h.addDocument(
      await scannedPdf(),
      mimeTypes.pdf,
      "scan.pdf",
    );

    const result = await h.ingestion.ingest(ingestRequest(doc.id));

    expect(result.status).toBe("ready");
    expect(result.ocrPages).toEqual([0]);
    expect(h.generate).toHaveBeenCalledTimes(1);
    expect(h.accounting.admit).toHaveBeenCalledTimes(1);
    const image = h.generate.mock.calls[0][0].images![0];
    expect(image.mimeType).toBe("image/png");
    expect(
      Math.max(...Object.values(pngSize(image.bytes))),
    ).toBeLessThanOrEqual(2000);
    expect(result.extraction).toMatchObject({
      method: "ocr",
      confidence: 0.95,
      pages: [{ text: "Scanned invoice page 1", method: "ocr" }],
    });
  });

  it("OCRs only the scanned page of a mixed PDF", async () => {
    const h = await setup({
      responses: [ocrResponse("Annexure: purchase order copy")],
    });
    const doc = await h.addDocument(
      await mixedPdf(),
      mimeTypes.pdf,
      "mixed.pdf",
    );

    const result = await h.ingestion.ingest(ingestRequest(doc.id));

    expect(result.ocrPages).toEqual([1]);
    expect(h.generate).toHaveBeenCalledTimes(1);
    const extraction = result.extraction!;
    expect(extraction.method).toBe("mixed");
    expect(extraction.pages.map((page) => page.method)).toEqual([
      "pdf-text",
      "ocr",
      "pdf-text",
    ]);
    expect(extraction.pages[1].text).toBe("Annexure: purchase order copy");
  });

  it("flags handwriting for review and caps its confidence", async () => {
    const h = await setup({
      responses: [
        ocrResponse("Received goods in good condition", "handwriting", 0.9),
      ],
    });
    const doc = await h.addDocument(
      handwritingImage(),
      mimeTypes.png,
      "note.png",
    );

    const result = await h.ingestion.ingest(ingestRequest(doc.id));

    const extraction = result.extraction!;
    expect(extraction.method).toBe("handwriting");
    expect(extraction.confidence).toBe(0.6);
    expect(extraction.warnings.map((warning) => warning.code)).toContain(
      handwritingWarningCode,
    );
    expect(requiresReview(extraction)).toBe(true);
  });

  it("flags low-confidence OCR for review", async () => {
    const h = await setup({
      responses: [ocrResponse("INV0ICE 1O42", "ocr", 0.4)],
    });
    const doc = await h.addDocument(plainImage(), mimeTypes.png, "invoice.png");

    const result = await h.ingestion.ingest(ingestRequest(doc.id));

    expect(result.status).toBe("ready");
    expect(result.extraction!.warnings).toContainEqual(
      expect.objectContaining({ code: lowConfidenceWarningCode, pageIndex: 0 }),
    );
    expect(requiresReview(result.extraction!)).toBe(true);
  });

  it("normalizes TIFF images to PNG before OCR", async () => {
    const h = await setup();
    const doc = await h.addDocument(tiffFixture(), mimeTypes.tiff, "fax.tiff");

    const result = await h.ingestion.ingest(ingestRequest(doc.id));

    expect(result.status).toBe("ready");
    const image = h.generate.mock.calls[0][0].images![0];
    expect(image.mimeType).toBe("image/png");
    expect(pngSize(image.bytes)).toEqual({ width: 40, height: 20 });
  });
});

describe("caching and claims", () => {
  it("reuses the cached extraction without another model call", async () => {
    const h = await setup();
    const doc = await h.addDocument(
      await scannedPdf(),
      mimeTypes.pdf,
      "scan.pdf",
    );

    await h.ingestion.ingest(ingestRequest(doc.id));
    const second = await h.ingestion.ingest(ingestRequest(doc.id));

    expect(second).toMatchObject({
      status: "ready",
      cached: true,
      ocrPages: [],
    });
    expect(h.generate).toHaveBeenCalledTimes(1);
  });

  it("does not OCR while another worker holds the claim", async () => {
    const h = await setup();
    const doc = await h.addDocument(
      await scannedPdf(),
      mimeTypes.pdf,
      "scan.pdf",
    );
    const now = Date.now();
    const claimed = await h.store.repositories.extractions.claim(
      {
        documentId: doc.id,
        cacheIdentity: {
          contentHash: doc.contentHash,
          extractorVersion: h.ingestion.extractorVersion,
          modelVersion: createMuseOcrBackend({
            ai: {} as never,
            modelVersion: "mock-spark",
          }).version,
        },
        holderId: "other-worker",
        at: new Date(now).toISOString(),
        expiresAt: new Date(now + 60_000).toISOString(),
      },
      ownerScope,
    );
    expect(claimed).toBe(true);

    const result = await h.ingestion.ingest(ingestRequest(doc.id));

    expect(result.status).toBe("in-progress");
    expect(h.generate).not.toHaveBeenCalled();
  });

  it("runs OCR once for concurrent requests", async () => {
    const h = await setup();
    const doc = await h.addDocument(
      await scannedPdf(),
      mimeTypes.pdf,
      "scan.pdf",
    );

    const results = await Promise.all([
      h.ingestion.ingest(ingestRequest(doc.id)),
      h.ingestion.ingest(ingestRequest(doc.id)),
    ]);

    expect(results.map((result) => result.status).sort()).toEqual([
      "in-progress",
      "ready",
    ]);
    expect(h.generate).toHaveBeenCalledTimes(1);
  });

  it("invalidates the cache when the extractor config or OCR model changes", async () => {
    const h = await setup();
    const doc = await h.addDocument(
      await scannedPdf(),
      mimeTypes.pdf,
      "scan.pdf",
    );
    await h.ingestion.ingest(ingestRequest(doc.id));

    const reconfigured = h.build({ lowConfidenceThreshold: 0.5 });
    expect(reconfigured.extractorVersion).not.toBe(
      h.ingestion.extractorVersion,
    );
    const afterConfig = await reconfigured.ingest(ingestRequest(doc.id));
    expect(afterConfig.cached).toBe(false);
    expect(h.generate).toHaveBeenCalledTimes(2);

    const swapped = h.build(undefined, {
      version: "other-ocr",
      extractPage: async () => ({
        text: "other",
        method: "ocr",
        confidence: 0.9,
        spans: [],
      }),
    });
    const afterModel = await swapped.ingest(ingestRequest(doc.id));
    expect(afterModel).toMatchObject({ cached: false, ocrPages: [0] });
    expect(afterModel.extraction!.cacheIdentity.modelVersion).toBe("other-ocr");
  });

  it("invalidates the cache when the content hash changes", async () => {
    const h = await setup();
    const doc = await h.addDocument(csvFixture(), mimeTypes.csv, "ledger.csv");
    await h.ingestion.ingest(ingestRequest(doc.id));

    const replacement = Buffer.from("invoice,amount\nINV-9,10\n");
    const contentHash = createHash("sha256").update(replacement).digest("hex");
    const objectKey = await h.storage.uploadAsync(doc.caseId, mimeTypes.csv, {
      body: (async function* () {
        yield replacement;
      })(),
      contentLength: replacement.byteLength,
      contentHash,
    });
    await h.store.repositories.documents.replaceOwned(
      { ...doc, objectKey, contentHash, sizeBytes: replacement.byteLength },
      ownerScope,
    );

    const result = await h.ingestion.ingest(ingestRequest(doc.id));

    expect(result.cached).toBe(false);
    expect(result.extraction!.cacheIdentity.contentHash).toBe(contentHash);
    expect(result.extraction!.tables[0].rows).toEqual([["INV-9", "10"]]);
  });
});

describe("security and limits", () => {
  it("denies documents outside the owner scope before any provider call", async () => {
    const h = await setup();
    await h.addCase("case-2", "owner-2");
    const foreignScope = { ownerId: "owner-2", caseId: "case-2" };
    const doc = await h.addDocument(
      await scannedPdf(),
      mimeTypes.pdf,
      "scan.pdf",
      foreignScope,
    );

    await expect(
      h.ingestion.ingest({
        scope: ownerScope,
        documentId: doc.id,
        usageContext,
      }),
    ).rejects.toMatchObject({ code: "document-not-found" });
    await expect(
      h.ingestion.ingest({
        scope: { ownerId: "owner-1", caseId: "case-2" },
        documentId: doc.id,
        usageContext: { userId: "owner-1", caseId: "case-2" },
      }),
    ).rejects.toBeInstanceOf(IngestionError);
    expect(h.generate).not.toHaveBeenCalled();
    expect(await h.stateOf(doc.id, foreignScope)).toBe("uploaded");
  });

  it("rejects usage contexts that do not match the owner scope", async () => {
    const h = await setup();
    const doc = await h.addDocument(
      await scannedPdf(),
      mimeTypes.pdf,
      "scan.pdf",
    );

    await expect(
      h.ingestion.ingest({
        scope: ownerScope,
        documentId: doc.id,
        usageContext: { userId: "owner-2", caseId: "case-1" },
      }),
    ).rejects.toMatchObject({ code: "usage-context-mismatch" });
    expect(h.generate).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: "page count",
      options: { limits: { maxPages: 2 } },
      code: "page-limit-exceeded",
      file: () => scannedPdf(3),
      mimeType: mimeTypes.pdf,
    },
    {
      name: "byte size",
      options: { limits: { maxBytes: 64 } },
      code: "size-limit-exceeded",
      file: async () => csvFixture(),
      mimeType: mimeTypes.csv,
    },
    {
      name: "row count",
      options: { limits: { maxRows: 2 } },
      code: "row-limit-exceeded",
      file: async () => csvFixture(),
      mimeType: mimeTypes.csv,
    },
    {
      name: "image pixels",
      options: { limits: { maxImagePixels: 10_000 } },
      code: "image-limit-exceeded",
      file: async () => plainImage(),
      mimeType: mimeTypes.png,
    },
    {
      name: "decompressed size",
      options: { limits: { maxDecompressedBytes: 1_000 } },
      code: "decompression-limit-exceeded",
      file: async () => xlsxFixture(),
      mimeType: mimeTypes.xlsx,
    },
    {
      name: "declared content type",
      options: {},
      code: "content-type-mismatch",
      file: () => nativeTextPdf(),
      mimeType: mimeTypes.png,
    },
  ])(
    "fails closed on the $name limit",
    async ({ options, code, file, mimeType }) => {
      const h = await setup({ ingestion: options });
      const doc = await h.addDocument(await file(), mimeType, "input");

      await expect(
        h.ingestion.ingest(ingestRequest(doc.id)),
      ).rejects.toMatchObject({
        code,
      });
      expect(h.generate).not.toHaveBeenCalled();
      expect(await h.stateOf(doc.id)).toBe("failed");
    },
  );

  it("stops OCR at the configured page budget", async () => {
    const h = await setup({ ingestion: { limits: { maxOcrPages: 1 } } });
    const doc = await h.addDocument(
      await scannedPdf(2),
      mimeTypes.pdf,
      "scan.pdf",
    );

    const result = await h.ingestion.ingest(ingestRequest(doc.id));

    expect(result).toMatchObject({
      status: "partial",
      stopReason: "ocr-page-limit",
      ocrPages: [0],
    });
    expect(h.generate).toHaveBeenCalledTimes(1);
  });
});

describe("partial and interrupted OCR", () => {
  it("keeps a partial result when the budget rejects a later page, then resumes", async () => {
    const admit = vi
      .fn<UsageAccounting["admit"]>()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new AdmissionRejectedError())
      .mockResolvedValue(undefined);
    const h = await setup({ accounting: { admit } });
    const doc = await h.addDocument(
      await scannedPdf(2),
      mimeTypes.pdf,
      "scan.pdf",
    );

    const first = await h.ingestion.ingest(ingestRequest(doc.id));

    expect(first).toMatchObject({
      status: "partial",
      stopReason: "usage-limit",
      ocrPages: [0, 1],
    });
    const extraction = first.extraction!;
    expect(isIncomplete(extraction)).toBe(true);
    expect(extraction.warnings).toContainEqual(
      expect.objectContaining({
        code: pageNotExtractedWarningCode,
        pageIndex: 1,
      }),
    );
    expect(extraction.pages[1]).toMatchObject({ text: "", confidence: 0 });
    expect(await h.stateOf(doc.id)).toBe("partial");
    expect(h.generate).toHaveBeenCalledTimes(1);

    const resumed = await h.ingestion.ingest(ingestRequest(doc.id));

    expect(resumed).toMatchObject({ status: "ready", ocrPages: [1] });
    expect(h.generate).toHaveBeenCalledTimes(2);
    expect(isIncomplete(resumed.extraction!)).toBe(false);
    expect(await h.stateOf(doc.id)).toBe("ready");
  });

  it("records unknown usage and keeps partial state when OCR is interrupted", async () => {
    const controller = new AbortController();
    const h = await setup({ failure: new Error("connection reset") });
    const doc = await h.addDocument(
      await scannedPdf(),
      mimeTypes.pdf,
      "scan.pdf",
    );
    h.generate.mockImplementationOnce(async () => {
      controller.abort(new Error("worker shutdown"));
      throw new Error("connection reset");
    });

    const result = await h.ingestion.ingest({
      ...ingestRequest(doc.id),
      signal: controller.signal,
    });

    expect(result).toMatchObject({
      status: "partial",
      stopReason: "interrupted",
    });
    expect(
      result.extraction!.warnings.map((warning) => warning.code),
    ).toContain(incompleteWarningCode);
    expect(h.recorded).toHaveLength(1);
    expect(h.recorded[0].outcome).toBe("unknown");
    expect(await h.stateOf(doc.id)).toBe("partial");
  });

  it("returns partial state when the model cannot read images", async () => {
    const h = await setup({
      models: { capabilitiesByTier: { cheap: ["structured-json"] } },
    });
    const doc = await h.addDocument(
      await mixedPdf(),
      mimeTypes.pdf,
      "mixed.pdf",
    );

    const result = await h.ingestion.ingest(ingestRequest(doc.id));

    expect(result).toMatchObject({
      status: "partial",
      stopReason: "ocr-unsupported",
    });
    expect(result.extraction!.pages[0].method).toBe("pdf-text");
    expect(h.generate).not.toHaveBeenCalled();
  });

  it("requires a usage context before OCR", async () => {
    const h = await setup();
    const doc = await h.addDocument(
      await scannedPdf(),
      mimeTypes.pdf,
      "scan.pdf",
    );

    const result = await h.ingestion.ingest({
      scope: ownerScope,
      documentId: doc.id,
    });

    expect(result).toMatchObject({
      status: "partial",
      stopReason: "usage-context-required",
    });
    expect(h.generate).not.toHaveBeenCalled();
  });
});
