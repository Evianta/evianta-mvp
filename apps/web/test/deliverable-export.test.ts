import type { Deliverable } from "@evianta/core";
import { describe, expect, it } from "vitest";
import {
  buildDeliverableExport,
  deliverableExportFormats,
  type ExportContext,
} from "../src/deliverable-export";
import { read, utils } from "xlsx";
import { readPdf } from "./support/pdf";

const jsonContext: ExportContext = {
  useCase: "tax-notice",
  description: "Prepare a notice response and export JSON for integration.",
};
const noticeContext: ExportContext = {
  useCase: "tax-notice",
  description: "Draft a notice reply.",
};

const deliverable: Deliverable = {
  id: "response-1",
  caseId: "case-1",
  runId: "run-1",
  version: 3,
  format: "document",
  title: "Notice reply / AY 2024-25",
  summary: "Check the credit mismatch before filing.",
  sections: [
    {
      id: "draft",
      title: "Draft notice reply",
      kind: "text",
      content: "Original reply to the assessing officer.",
      reviewerContent: "Reviewed reply with corrected credit amount.",
      reviewerId: "reviewer-1",
      reviewedAt: "2026-11-03T00:00:00.000Z",
      producingRole: "tax-notice-response-drafter",
      routingTier: "mid",
      provider: "mock",
      model: "mock",
      findingIds: ["credit-mismatch"],
      evidenceIds: ["notice-page-1"],
      reviewStatus: "accepted",
      reviewComment: "Credit checked.",
    },
    {
      id: "schedule",
      title: "Credit schedule",
      kind: "table",
      content: { rows: [{ credit: 12500 }] },
      reviewerContent: null,
      reviewerId: null,
      reviewedAt: null,
      producingRole: "tax-notice-response-drafter",
      routingTier: "mid",
      provider: "mock",
      model: "mock",
      findingIds: ["credit-mismatch"],
      evidenceIds: ["notice-page-1"],
      reviewStatus: "pending",
      reviewComment: null,
    },
  ],
  createdAt: "2026-11-03T00:00:00.000Z",
  updatedAt: "2026-11-03T00:00:00.000Z",
};

describe("deliverable exports", () => {
  it("exports a real PDF with the full draft and schedules, not just the summary", async () => {
    const file = await buildDeliverableExport(
      deliverable,
      "pdf",
      noticeContext,
    );
    expect(file.filename).toBe("notice-reply-ay-2024-25-v3.pdf");
    expect(file.mimeType).toBe("application/pdf");
    expect(new TextDecoder().decode(file.content.slice(0, 5))).toBe("%PDF-");
    const pdf = await readPdf(file.content);
    expect(pdf.text).toContain("Notice reply / AY 2024-25");
    expect(pdf.text).toContain("Draft notice reply");
    expect(pdf.text).toContain("Reviewed reply with corrected credit amount.");
    expect(pdf.text).not.toContain("Original reply");
    expect(pdf.text).toContain("12500");
    expect(pdf.text).toContain("Not validated for government portal");
    expect(pdf.pages).toBe(1);
  }, 20_000);

  it("exports structured content when JSON is part of the task", async () => {
    const file = await buildDeliverableExport(deliverable, "json", jsonContext);
    const output = JSON.parse(new TextDecoder().decode(file.content));
    expect(file.filename).toBe("notice-reply-ay-2024-25-v3.json");
    expect(file.mimeType).toContain("application/json");
    expect(output).toMatchObject({
      id: deliverable.id,
      version: 3,
      sections: [
        {
          content: "Reviewed reply with corrected credit amount.",
          findingIds: ["credit-mismatch"],
          evidenceIds: ["notice-page-1"],
          reviewStatus: "accepted",
        },
        { content: { rows: [{ credit: 12500 }] } },
      ],
      exportNotice: expect.stringContaining("Not validated"),
    });
    expect(deliverable.sections[0]?.content).toBe(
      "Original reply to the assessing officer.",
    );
  });

  it("preserves intentionally empty reviewer text", async () => {
    const edited = {
      ...deliverable,
      sections: [{ ...deliverable.sections[0]!, reviewerContent: "" }],
    };
    const file = await buildDeliverableExport(edited, "json", jsonContext);
    const output = JSON.parse(new TextDecoder().decode(file.content));
    expect(output.sections[0].content).toBe("");
  });

  it("keeps the original content when no reviewer edit exists", async () => {
    const original = {
      ...deliverable,
      sections: [{ ...deliverable.sections[0]!, reviewerContent: null }],
    };
    const pdf = await readPdf(
      (await buildDeliverableExport(original, "pdf")).content,
    );
    expect(pdf.text).toContain("Original reply to the assessing officer.");
  });

  it("uses a safe fallback filename for punctuation-only titles", async () => {
    expect(
      (await buildDeliverableExport({ ...deliverable, title: "..." }, "pdf"))
        .filename,
    ).toBe("deliverable-v3.pdf");
  });

  it("selects only PDF for a notice reply without tabular schedules", () => {
    expect(
      deliverableExportFormats(
        { ...deliverable, sections: [deliverable.sections[0]!] },
        noticeContext,
      ),
    ).toEqual(["pdf"]);
  });

  it("does not mistake open questions for an Excel schedule", () => {
    expect(
      deliverableExportFormats(
        {
          ...deliverable,
          sections: [
            {
              ...deliverable.sections[0]!,
              reviewerContent: null,
              content: {
                summary: "Please verify the credit before responding.",
                openQuestions: [
                  { text: "Confirm the bank account.", severity: "high" },
                ],
              },
            },
          ],
        },
        noticeContext,
      ),
    ).toEqual(["pdf"]);
  });

  it("offers a notice PDF and Excel when the output includes a credit schedule", () => {
    expect(deliverableExportFormats(deliverable, noticeContext)).toEqual([
      "pdf",
      "xlsx",
    ]);
  });

  it("selects PDF and Excel for dashboard work, without exposing JSON", () => {
    expect(
      deliverableExportFormats({ ...deliverable, format: "dashboard" }),
    ).toEqual(["pdf", "xlsx"]);
    expect(
      deliverableExportFormats({ ...deliverable, format: "spreadsheet" }),
    ).toEqual(["pdf", "xlsx"]);
  });

  it.each([
    "Use JSON as a reference, draft a notice reply.",
    "Use JSON for input only.",
    "Do not output JSON.",
    "Generate a PDF without JSON.",
    "Analyze the uploaded records.json file.",
  ])(
    "does not offer JSON for references, inputs or exclusions: %s",
    (description) => {
      expect(
        deliverableExportFormats(deliverable, {
          ...noticeContext,
          description,
        }),
      ).not.toContain("json");
    },
  );

  it("refuses a universal JSON download when the task does not call for it", async () => {
    await expect(
      buildDeliverableExport(deliverable, "json", noticeContext),
    ).rejects.toThrow("not appropriate for this task");
  });

  it("creates an Excel workbook with numeric cells and the saved draft", async () => {
    const file = await buildDeliverableExport(
      deliverable,
      "xlsx",
      noticeContext,
    );
    expect(file.filename).toBe("notice-reply-ay-2024-25-v3.xlsx");
    expect(file.mimeType).toContain("spreadsheetml");
    expect(Array.from(file.content.slice(0, 2))).toEqual([80, 75]);
    const workbook = read(file.content, { type: "array" });
    expect(workbook.SheetNames).toEqual(["Summary", "Rows"]);
    expect(utils.sheet_to_json(workbook.Sheets.Rows!)).toEqual([
      { Credit: 12500 },
    ]);
    expect(utils.sheet_to_csv(workbook.Sheets.Summary!)).toContain(
      "Reviewed reply with corrected credit amount.",
    );
  });

  it("exports matrix tables, keeps formula-like values as text, and deduplicates sheet names", async () => {
    const section = {
      ...deliverable.sections[1]!,
      title: "Summary",
      content: { columns: ["Account", "Amount"], rows: [["=1+1", 12500]] },
    };
    const file = await buildDeliverableExport(
      { ...deliverable, sections: [section, { ...section, id: "another" }] },
      "xlsx",
    );
    const workbook = read(file.content, { type: "array" });
    expect(workbook.SheetNames).toEqual(["Summary", "Summary 2", "Summary 3"]);
    expect(workbook.Sheets["Summary 2"]!.A2).toMatchObject({
      t: "s",
      v: "=1+1",
    });
    expect(workbook.Sheets["Summary 2"]!.A2.f).toBeUndefined();
    expect(workbook.Sheets["Summary 2"]!.B2.v).toBe(12500);
  });

  it("paginates long notice replies without losing the final paragraph", async () => {
    const content = `${"Please verify the payment credit against the enclosed records. ".repeat(600)}\nEnd of draft notice reply. Amount: \u20b912500.`;
    const file = await buildDeliverableExport(
      {
        ...deliverable,
        sections: [{ ...deliverable.sections[0]!, reviewerContent: content }],
      },
      "pdf",
    );
    const pdf = await readPdf(file.content);
    expect(pdf.pages).toBeGreaterThan(1);
    expect(pdf.text).toContain("End of draft notice reply.");
    expect(pdf.text).toContain("\u20b912500");
  }, 20_000);

  it("keeps every column of wide schedules readable in the PDF", async () => {
    const file = await buildDeliverableExport(
      {
        ...deliverable,
        sections: [
          {
            ...deliverable.sections[1]!,
            content: {
              columns: Array.from(
                { length: 10 },
                (_, index) => `Column ${index + 1}`,
              ),
              rows: [Array.from({ length: 10 }, (_, index) => index + 100)],
            },
          },
        ],
      },
      "pdf",
    );
    const pdf = await readPdf(file.content);
    expect(pdf.text).toContain("Columns 1-6");
    expect(pdf.text).toContain("Columns 7-10");
    expect(pdf.text).toContain("Column 10");
    expect(pdf.text).toContain("109");
  });
});
