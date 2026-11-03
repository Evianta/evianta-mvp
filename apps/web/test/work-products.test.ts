import { describe, expect, it } from "vitest";
import {
  WorkProductSchema,
  emptyUsageSummary,
  filingReadiness,
  type RunDto,
  type Deliverable,
} from "@evianta/core";
import { unzipSync } from "fflate";
import { read, utils } from "xlsx";
import {
  buildDeliverableExport,
  buildGeneratedBundle,
  deliverableExportFormats,
} from "../src/deliverable-export";
import { buildResult } from "../src/chat/results";
import type { CaseWorkspace } from "../src/api/client";
import { syntheticWorkflowFixtures } from "@evianta/core";
import { readPdf } from "./support/pdf";

const product = WorkProductSchema.parse({
  key: "northstar-demand",
  type: "payment-demand",
  title: "Payment notice - Northstar",
  claimant: "BluePeak Precision Components",
  counterparty: "Northstar Appliances",
  body: "To: Northstar Appliances\nSubject: Payment against invoice INV-260715\nOur records show INR 236,000 outstanding for accepted goods. Please arrange payment.\nFor BluePeak: [unsigned]",
  sources: [
    {
      documentId: "private-source-id",
      reference: "Invoice INV-260715 (original supplied by user)",
    },
  ],
  missingOriginals: ["Original Udyam certificate"],
  reviewBlockers: ["Verify supplier eligibility and recipient address."],
  schedules: [],
});

function document(): Deliverable {
  return {
    id: "private-document-id",
    caseId: "private-case-id",
    runId: "run-2",
    version: 2,
    format: "document",
    title: product.title,
    summary: "Internal operational summary must not be exported.",
    workProduct: product,
    sections: [
      {
        id: "private-body-id",
        title: product.title,
        kind: "text",
        content: product.body,
        reviewerContent:
          "To: Northstar Appliances\nSubject: Payment against INV-260715\nReviewed demand for INR 236,000.\nFor BluePeak: [unsigned]",
        reviewerId: "reviewer",
        reviewedAt: "2026-11-03T00:00:00.000Z",
        producingRole: "msme-case-preparation",
        routingTier: "mid",
        provider: "mock",
        model: "mock",
        findingIds: ["private-finding-id"],
        evidenceIds: ["private-evidence-id"],
        reviewStatus: "accepted",
        reviewComment: "Check original certificate separately.",
      },
    ],
    createdAt: "2026-11-03T00:00:00.000Z",
    updatedAt: "2026-11-03T00:00:00.000Z",
  };
}

describe("customer-facing work products", () => {
  it("does not show internal analysis as a ready case pack when no document was drafted", () => {
    const internal = document();
    delete internal.workProduct;
    const workspace: CaseWorkspace = {
      case: syntheticWorkflowFixtures.msmePayment.case,
      documents: [],
      findings: [],
      evidence: [],
      approvals: [],
      deliverables: [internal],
    };
    expect(buildResult(workspace, null).deliverables).toEqual([]);
  });
  it("never labels synthetic, unapproved or destination-unvalidated drafts ready for filing", () => {
    const doc = document();
    const readiness = filingReadiness(doc, {
      synthetic: true,
      approval: undefined,
    });
    expect(readiness?.status).toBe("draft");
    expect(readiness?.blockers.join(" ")).toContain("Synthetic");
    expect(readiness?.blockers.join(" ")).toContain("Approval");
    expect(readiness?.blockers.join(" ")).toContain("original");
    const reviewed = {
      ...doc,
      workProduct: { ...product, missingOriginals: [], reviewBlockers: [] },
    };
    const approved = filingReadiness(reviewed, {
      synthetic: false,
      approval: {
        id: "approval",
        caseId: doc.caseId,
        deliverableId: doc.id,
        deliverableVersion: doc.version,
        actorId: "reviewer",
        approvedAt: doc.updatedAt,
        unresolvedQuestionIds: [],
        note: "Reviewed",
      },
    });
    expect(approved?.blockers).toEqual([
      "Current destination formats, size limits and attachment rules have not been validated.",
    ]);
  });

  it("preserves numeric currency cells and real dates in schedules", async () => {
    const doc = document();
    doc.workProduct = WorkProductSchema.parse({
      ...product,
      schedules: [
        {
          title: "Payments",
          columns: ["Invoice", "Date", "Amount"],
          columnFormats: ["text", "date", "currency"],
          currencyCode: "INR",
          rows: [["INV-1", "2026-10-18", 174800]],
        },
      ],
    });
    const workbook = read((await buildDeliverableExport(doc, "xlsx")).content, {
      type: "array",
      cellNF: true,
    });
    expect(workbook.Sheets.Payments!.C2).toMatchObject({
      t: "n",
      v: 174800,
      z: '"INR" #,##0.00',
    });
    expect(workbook.Sheets.Payments!.B2).toMatchObject({
      t: "n",
      z: "yyyy-mm-dd",
    });
    expect(workbook.Sheets.Payments!.B2.v).toBe(
      (Date.UTC(2026, 9, 18) - Date.UTC(1899, 11, 30)) / 86_400_000,
    );
    expect(
      WorkProductSchema.safeParse({
        ...product,
        schedules: [
          {
            title: "Bad date",
            columns: ["Date"],
            columnFormats: ["date"],
            rows: [["2026-02-31"]],
          },
        ],
      }).success,
    ).toBe(false);
  });
  it("renders the saved letter rather than internal analysis or regenerated evidence", async () => {
    const file = await buildDeliverableExport(document(), "pdf");
    const pdf = await readPdf(file.content);
    expect(pdf.text).toContain("Reviewed demand for INR 236,000");
    expect(pdf.text).toContain("Invoice INV-260715");
    expect(pdf.text).toContain("upload originals separately");
    expect(pdf.text).not.toContain("private-");
    expect(pdf.text).not.toContain("Internal operational summary");
    expect(pdf.text).not.toContain("Our records show");
    expect(pdf.text).not.toContain("Check original certificate");
  }, 20_000);

  it("offers no Excel merely because a letter contains a number", () => {
    expect(deliverableExportFormats(document())).toEqual(["pdf"]);
  });

  it("exports only genuine numeric schedules to Excel", async () => {
    const doc = document();
    doc.workProduct = {
      ...product,
      schedules: [
        {
          title: "Invoice reconciliation",
          columns: ["Invoice", "Gross INR", "Paid INR", "Balance INR"],
          rows: [["INV-260715", 236000, 0, 236000]],
        },
      ],
    };
    const file = await buildDeliverableExport(doc, "xlsx");
    const workbook = read(file.content, { type: "array" });
    expect(
      utils.sheet_to_json(workbook.Sheets["Invoice reconciliation"]!),
    ).toEqual([
      {
        Invoice: "INV-260715",
        "Gross INR": 236000,
        "Paid INR": 0,
        "Balance INR": 236000,
      },
    ]);
    expect(utils.sheet_to_csv(workbook.Sheets.Summary!)).not.toContain(
      "Reviewed demand",
    );
  });

  it("exports requested business JSON without source IDs or internal fields", async () => {
    const file = await buildDeliverableExport(document(), "json", {
      useCase: "msme-payment",
      description: "Export JSON output.",
    });
    const text = new TextDecoder().decode(file.content);
    expect(text).not.toContain("private-");
    expect(JSON.parse(text).sources).toEqual([
      { reference: product.sources[0]!.reference },
    ]);
    expect(JSON.parse(text).body).toContain("Reviewed demand");
  });

  it("rejects invoice/certificate outputs and malformed schedules", () => {
    expect(WorkProductSchema.safeParse({ ...product, body: " " }).success).toBe(
      false,
    );
    for (const type of ["invoice", "credit-note", "udyam-certificate"])
      expect(WorkProductSchema.safeParse({ ...product, type }).success).toBe(
        false,
      );
    expect(
      WorkProductSchema.safeParse({
        ...product,
        schedules: [{ title: "Bad", columns: ["Amount"], rows: [[1, 2]] }],
      }).success,
    ).toBe(false);
  });

  it("does not export legacy internal task sections as a notice", async () => {
    const doc = document();
    delete doc.workProduct;
    doc.sections[0]!.content = { taskId: "internal-task", findings: [] };
    expect(
      deliverableExportFormats(doc, {
        useCase: "msme-payment",
        description: "Draft notice",
      }),
    ).toEqual([]);
    await expect(
      buildDeliverableExport(doc, "pdf", {
        useCase: "msme-payment",
        description: "Draft notice",
      }),
    ).rejects.toThrow("internal analysis");
  });

  it("rejects internal IDs accidentally pasted into an outward-facing draft", async () => {
    const doc = document();
    doc.sections[0]!.reviewerContent = `Payment demand. Internal case: ${doc.caseId}`;
    await expect(buildDeliverableExport(doc, "pdf")).rejects.toThrow(
      "internal identifiers",
    );
  });

  it("returns every current-run document, not an older run or internal report", () => {
    const a = document();
    const b = {
      ...document(),
      id: "buyer-b",
      workProduct: { ...product, key: "buyer-b", counterparty: "Customer B" },
    };
    const internal = { ...document(), id: "internal" };
    delete internal.workProduct;
    const workspace: CaseWorkspace = {
      case: syntheticWorkflowFixtures.msmePayment.case,
      documents: [],
      findings: [],
      evidence: [],
      approvals: [],
      deliverables: [a, b, internal, { ...a, id: "old", runId: "run-1" }],
    };
    const run: RunDto = {
      id: "run-2",
      caseId: workspace.case.id,
      planVersion: 1,
      status: "completed",
      priorRunId: null,
      cancellationRequested: false,
      inputRequired: false,
      usage: emptyUsageSummary(),
      createdAt: a.createdAt,
      updatedAt: a.updatedAt,
    };
    const result = buildResult(workspace, run);
    expect(result.deliverables.map((item) => item.id)).toEqual([a.id, b.id]);
    expect(result.headline).toContain("2 documents");
  });

  it("packages only the supplied generated files with safe distinct names", async () => {
    const pdf = await buildDeliverableExport(document(), "pdf");
    const zip = await buildGeneratedBundle([pdf, pdf]);
    const entries = unzipSync(zip);
    expect(Object.keys(entries)).toEqual([
      "01-payment-notice-northstar-v2.pdf",
      "02-payment-notice-northstar-v2.pdf",
    ]);
    expect(entries[Object.keys(entries)[0]!]!).toEqual(pdf.content);
    expect(
      Object.keys(entries).some((name) =>
        /invoice|certificate|private-source/.test(name),
      ),
    ).toBe(false);
    await expect(buildGeneratedBundle([])).rejects.toThrow(
      "No generated files",
    );
  }, 20_000);
});
