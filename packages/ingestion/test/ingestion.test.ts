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
import { degrees, PDFDocument, StandardFonts } from "pdf-lib";
import * as XLSX from "xlsx";
import UTIF from "utif2";
import { imageFrames } from "../src/image.js";
import { resolveIngestionSettings } from "../src/config.js";
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
  it("does not infer exponent-like identifiers as numbers", async () => {
    const h = await setup();
    const doc = await h.addDocument(
      Buffer.from("id,amount\ne123,.5e2\n-e4,-12e-2\n"),
      mimeTypes.csv,
      "identifiers.csv",
    );
    const result = await h.ingestion.ingest(ingestRequest(doc.id));
    expect(result.extraction!.tables[0].columnTypes).toEqual([
      "string",
      "number",
    ]);
  });

  it("does not invent JSON field values from the prototype", async () => {
    const h = await setup();
    const doc = await h.addDocument(
      Buffer.from('[{"__proto__":"source value"},{"ordinary":"second row"}]'),
      mimeTypes.json,
      "rows.json",
    );
    const result = await h.ingestion.ingest(ingestRequest(doc.id));
    expect(result.extraction!.tables[0]).toMatchObject({
      headers: ["__proto__", "ordinary"],
      rows: [
        ["source value", null],
        [null, "second row"],
      ],
    });
  });

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

  it("releases decoded TIFF buffers after conversion and decode errors", async () => {
    const decodeImage = UTIF.decodeImage;
    const directories: UTIF.IFD[] = [];
    const spy = vi
      .spyOn(UTIF, "decodeImage")
      .mockImplementation((buffer, directory) => {
        directories.push(directory);
        decodeImage(buffer, directory);
      });
    try {
      const { limits } = resolveIngestionSettings();
      const frames = imageFrames(tiffFixture(), "tiff", limits);
      await frames[0].load();
      expect(directories[0].data).toBeUndefined();
      await frames[0].load();
      expect(directories[1].data).toBeUndefined();
      spy.mockImplementation((_buffer, directory) => {
        directories.push(directory);
        directory.data = new Uint8Array(100);
        throw new Error("Decode failed");
      });
      await expect(frames[0].load()).rejects.toMatchObject({
        code: "parse-failed",
      });
      expect(directories[2].data).toBeUndefined();
    } finally {
      spy.mockRestore();
    }
  });

  it("does not cache oversized PDF images as successfully extracted blank pages", async () => {
    const h = await setup({
      ingestion: { limits: { maxImagePixels: 1000 } },
    });
    const doc = await h.addDocument(
      await scannedPdf(),
      mimeTypes.pdf,
      "large.pdf",
    );
    const result = await h.ingestion.ingest(ingestRequest(doc.id));
    expect(result.status).toBe("partial");
    expect(isIncomplete(result.extraction!)).toBe(true);
    expect(h.generate).not.toHaveBeenCalled();
  });
});

describe("caching and claims", () => {
  it("recovers a short lease after non-yielding parsing without another holder", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const h = await setup({ ingestion: { claimTtlSeconds: 1 } });
      const doc = await h.addDocument(csvFixture(), mimeTypes.csv, "rows.csv");
      const repository = h.store.repositories.documents;
      const replace = repository.replaceOwned.bind(repository);
      vi.spyOn(repository, "replaceOwned").mockImplementation(
        async (...args) => {
          const result = await replace(...args);
          if (args[0].state === "processing") {
            vi.setSystemTime(Date.now() + 1500);
          }
          return result;
        },
      );
      const result = await h.ingestion.ingest(ingestRequest(doc.id));
      expect(result.status).toBe("ready");
      expect(await h.stateOf(doc.id)).toBe("ready");
    } finally {
      vi.useRealTimers();
    }
  });

  it("invalidates cached text when the detected format changes", async () => {
    const h = await setup();
    const doc = await h.addDocument(
      Buffer.from("name\tvalue\ninvoice\t42\n"),
      "text/plain",
      "rows.txt",
    );
    const first = await h.ingestion.ingest(ingestRequest(doc.id));
    expect(first.extraction!.kind).toBe("text");
    const current = await h.store.repositories.documents.findOwned(
      doc.id,
      ownerScope,
    );
    await h.store.repositories.documents.replaceOwned(
      { ...current!, name: "rows.tsv" },
      ownerScope,
    );
    const second = await h.ingestion.ingest(ingestRequest(doc.id));
    expect(second.cached).toBe(false);
    expect(second.extraction!.kind).toBe("tabular");
    expect(second.extraction!.cacheIdentity.extractorVersion).not.toBe(
      first.extraction!.cacheIdentity.extractorVersion,
    );
  });

  it("does not overwrite a successful worker after losing the claim during cache lookup", async () => {
    const h = await setup();
    const doc = await h.addDocument(plainImage(), mimeTypes.png, "scan.png");
    const repository = h.store.repositories.extractions;
    const find = repository.findCached.bind(repository);
    let reads = 0;
    vi.spyOn(repository, "findCached").mockImplementation(async (...args) => {
      if (++reads === 2) {
        await repository.releaseClaim(
          {
            documentId: doc.id,
            cacheIdentity: args[1],
            holderId: "stale-worker",
          },
          ownerScope,
        );
        await h.store.repositories.documents.replaceOwned(
          { ...doc, state: "ready", processedAt: new Date().toISOString() },
          ownerScope,
        );
      }
      return find(...args);
    });
    const result = await h.ingestion.ingest({
      ...ingestRequest(doc.id),
      holderId: "stale-worker",
    });
    expect(result.stopReason).toBe("claim-lost");
    expect(await h.stateOf(doc.id)).toBe("ready");
    expect(h.generate).not.toHaveBeenCalled();
  });

  it("does not overwrite a successful state after a delayed pre-claim read failure", async () => {
    const h = await setup();
    const doc = await h.addDocument(plainImage(), mimeTypes.png, "scan.png");
    vi.spyOn(h.storage, "readBufferAsync").mockImplementation(async () => {
      await h.store.repositories.documents.replaceOwned(
        { ...doc, state: "ready", processedAt: new Date().toISOString() },
        ownerScope,
      );
      throw new Error("Delayed read failure");
    });
    await expect(
      h.ingestion.ingest(ingestRequest(doc.id)),
    ).rejects.toMatchObject({
      code: "document-bytes-missing",
    });
    expect(await h.stateOf(doc.id)).toBe("ready");
  });

  it("refreshes the cache after acquiring a claim", async () => {
    const h = await setup();
    const doc = await h.addDocument(plainImage(), mimeTypes.png, "scan.png");
    const first = await h.ingestion.ingest(ingestRequest(doc.id));
    vi.spyOn(
      h.store.repositories.extractions,
      "findCached",
    ).mockResolvedValueOnce(null);
    const second = await h.ingestion.ingest(ingestRequest(doc.id));
    expect(second).toMatchObject({
      cached: true,
      extraction: first.extraction,
    });
    expect(h.generate).toHaveBeenCalledTimes(1);
  });

  it("heartbeats while an OCR call outlives the original lease", async () => {
    let started!: () => void;
    const entered = new Promise<void>((resolve) => {
      started = resolve;
    });
    const extractPage = vi.fn(async () => {
      started();
      await new Promise((resolve) => setTimeout(resolve, 1500));
      return {
        text: "Invoice",
        method: "ocr" as const,
        confidence: 0.9,
        spans: [],
      };
    });
    const h = await setup({
      ingestion: { claimTtlSeconds: 1 },
      ocr: { version: "slow-ocr", extractPage },
    });
    const doc = await h.addDocument(plainImage(), mimeTypes.png, "scan.png");
    const first = h.ingestion.ingest(ingestRequest(doc.id));
    await entered;
    await new Promise((resolve) => setTimeout(resolve, 1100));
    const second = await h.ingestion.ingest(ingestRequest(doc.id));
    expect(second.status).toBe("in-progress");
    expect((await first).status).toBe("ready");
    expect(extractPage).toHaveBeenCalledTimes(1);
  });

  it("aborts OCR and never commits after losing a claim", async () => {
    let signal: AbortSignal | undefined;
    const h = await setup({
      ingestion: { claimTtlSeconds: 1 },
      ocr: {
        version: "waiting-ocr",
        extractPage: async (request) => {
          signal = request.signal;
          return new Promise((_, reject) => {
            request.signal!.addEventListener(
              "abort",
              () => reject(request.signal!.reason),
              { once: true },
            );
          });
        },
      },
    });
    const repository = h.store.repositories.extractions;
    const claim = repository.renewClaim.bind(repository);
    vi.spyOn(repository, "renewClaim").mockImplementation((request, scope) =>
      signal ? Promise.resolve(false) : claim(request, scope),
    );
    const save = vi.spyOn(repository, "saveClaimed");
    const doc = await h.addDocument(plainImage(), mimeTypes.png, "scan.png");
    const result = await h.ingestion.ingest(ingestRequest(doc.id));
    expect(result).toMatchObject({
      status: "in-progress",
      stopReason: "claim-lost",
    });
    expect(signal?.aborted).toBe(true);
    expect(save).not.toHaveBeenCalled();
    expect(await repository.findForDocument(doc.id, ownerScope)).toBeNull();
  });

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

  it("does not overwrite a replacement document after OCR completes", async () => {
    const replacement: { apply: () => Promise<void> } = {
      apply: async () => {},
    };
    const ocr: OcrBackend = {
      version: "replacement-test",
      async extractPage() {
        await replacement.apply();
        return {
          text: "Old document content",
          method: "ocr",
          confidence: 0.9,
          spans: [],
        };
      },
    };
    const h = await setup({ ocr });
    const original = await h.addDocument(
      plainImage(),
      mimeTypes.png,
      "scan.png",
    );
    replacement.apply = async () => {
      const bytes = Buffer.from("replacement");
      const contentHash = createHash("sha256").update(bytes).digest("hex");
      const objectKey = await h.storage.uploadAsync(
        original.caseId,
        mimeTypes.png,
        {
          body: (async function* () {
            yield bytes;
          })(),
          contentLength: bytes.byteLength,
          contentHash,
        },
      );
      await h.store.repositories.documents.replaceOwned(
        {
          ...original,
          objectKey,
          contentHash,
          sizeBytes: bytes.byteLength,
          state: "uploaded",
        },
        ownerScope,
      );
    };

    const result = await h.ingestion.ingest(ingestRequest(original.id));

    expect(result).toMatchObject({
      status: "in-progress",
      stopReason: "claim-lost",
      extraction: null,
    });
    expect(await h.stateOf(original.id)).toBe("uploaded");
    expect(
      await h.store.repositories.extractions.findForDocument(
        original.id,
        ownerScope,
      ),
    ).toBeNull();
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
          extractorVersion: `${h.ingestion.extractorVersion}:pdf`,
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
  it("does not mistake PDF header text in CSV data for a PDF", async () => {
    const h = await setup();
    const doc = await h.addDocument(
      Buffer.from("name,note\nscan,%PDF-1.7\n"),
      mimeTypes.csv,
      "notes.csv",
    );
    const result = await h.ingestion.ingest(ingestRequest(doc.id));
    expect(result.extraction!.tables[0].rows).toEqual([["scan", "%PDF-1.7"]]);
  });

  it("rejects a worksheet whose absolute range exceeds the read cutoff", async () => {
    const book = XLSX.utils.book_new();
    const sheet = XLSX.utils.aoa_to_sheet([]);
    XLSX.utils.sheet_add_aoa(
      sheet,
      [
        ["Name", "Value"],
        ["A", 1],
        ["B", 2],
      ],
      { origin: "A3" },
    );
    sheet["!ref"] = "A3:B5";
    XLSX.utils.book_append_sheet(book, sheet, "Offset");
    const bytes = XLSX.write(book, {
      type: "buffer",
      bookType: "xlsx",
    }) as Buffer;
    const h = await setup({ ingestion: { limits: { maxRows: 2 } } });
    const doc = await h.addDocument(bytes, mimeTypes.xlsx, "offset.xlsx");
    await expect(
      h.ingestion.ingest(ingestRequest(doc.id)),
    ).rejects.toMatchObject({ code: "row-limit-exceeded" });
    expect(await h.stateOf(doc.id)).toBe("failed");
  });

  it("bounds actual ZIP inflation even when both headers understate sizes", async () => {
    const book = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(
      book,
      XLSX.utils.aoa_to_sheet([["Name"], ["x".repeat(30000)]]),
      "Data",
    );
    const bytes = XLSX.write(book, {
      type: "buffer",
      bookType: "xlsx",
      compression: true,
    }) as Buffer;
    const end = bytes.length - 22;
    let directory = bytes.readUInt32LE(end + 16);
    for (let entry = 0; entry < bytes.readUInt16LE(end + 10); entry++) {
      const local = bytes.readUInt32LE(directory + 42);
      bytes.writeUInt32LE(1, directory + 24);
      bytes.writeUInt32LE(1, local + 22);
      directory +=
        46 +
        bytes.readUInt16LE(directory + 28) +
        bytes.readUInt16LE(directory + 30) +
        bytes.readUInt16LE(directory + 32);
    }
    const h = await setup({
      ingestion: { limits: { maxDecompressedBytes: 1000 } },
    });
    const doc = await h.addDocument(bytes, mimeTypes.xlsx, "forged.xlsx");
    await expect(
      h.ingestion.ingest(ingestRequest(doc.id)),
    ).rejects.toMatchObject({ code: "decompression-limit-exceeded" });
    expect(await h.stateOf(doc.id)).toBe("failed");
  });

  it("fails explicitly before persisting oversized encoded output", async () => {
    const h = await setup({
      ingestion: { limits: { maxTableCells: 2_500_000 } },
    });
    const header = Array.from({ length: 20 }, (_, i) => `column${i}`).join(",");
    const bytes = Buffer.from(
      `${header}\n${`${Array(20).fill("x").join(",")}\n`.repeat(100000)}`,
    );
    expect(bytes.byteLength).toBeLessThan(5 * 1024 * 1024);
    const doc = await h.addDocument(bytes, mimeTypes.csv, "large.csv");
    await expect(
      h.ingestion.ingest(ingestRequest(doc.id)),
    ).rejects.toMatchObject({ code: "extraction-limit-exceeded" });
    expect(await h.stateOf(doc.id)).toBe("failed");
    expect(
      await h.store.repositories.extractions.findForDocument(
        doc.id,
        ownerScope,
      ),
    ).toBeNull();
  });

  it("rejects oversized rectangular tables before padding sparse rows", async () => {
    const headers = Array.from({ length: 500 }, (_, index) => `column${index}`);
    const bytes = Buffer.from(`${headers.join(",")}\n${"x\n".repeat(100000)}`);
    const h = await setup();
    const doc = await h.addDocument(bytes, mimeTypes.csv, "wide-sparse.csv");

    await expect(
      h.ingestion.ingest(ingestRequest(doc.id)),
    ).rejects.toMatchObject({ code: "cell-limit-exceeded" });
    expect(await h.stateOf(doc.id)).toBe("failed");
  });

  it("positions text using its own rotation, independently of page rotation", async () => {
    const pdf = await PDFDocument.create();
    const font = await pdf.embedFont(StandardFonts.Helvetica);
    const page = pdf.addPage([612, 792]);
    page.drawText("Vertical invoice text", {
      x: 300,
      y: 200,
      size: 12,
      font,
      rotate: degrees(90),
    });
    const h = await setup();
    const doc = await h.addDocument(
      await pdf.save(),
      mimeTypes.pdf,
      "rotated.pdf",
    );
    const result = await h.ingestion.ingest(ingestRequest(doc.id));
    const span = result.extraction!.pages[0].spans[0];
    expect(span.bbox.height).toBeGreaterThan(span.bbox.width * 4);
    expect(span.bbox.x).toBeCloseTo((300 - 12) / 612, 2);
    expect(span.bbox.width).toBeCloseTo(12 / 612, 2);
    expect(h.generate).not.toHaveBeenCalled();
  });

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
