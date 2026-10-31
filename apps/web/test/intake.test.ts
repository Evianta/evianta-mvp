import { describe, expect, it } from "vitest";
import {
  deriveIntakeOpenQuestions,
  validateUploadFile,
  workflowSpecs,
  intakeCaseDetails,
  starterPrompts,
  inferIntakeWorkflow,
} from "../src/intake.js";

describe("case intake", () => {
  it.each([
    ["Analyze the sales spreadsheet", [], "data-analysis"],
    ["Help with this", [{ name: "q4_sales.xlsx" }], "data-analysis"],
    [
      "Review this file",
      [{ name: "records.csv", header: "month,product,revenue" }],
      "data-analysis",
    ],
    ["Reply to a 143(1) intimation about TDS", [], "tax-notice"],
    ["Review", [{ name: "income-tax-notice.pdf" }], "tax-notice"],
    ["Reconcile my overdue invoices", [], "msme-payment"],
    [
      "Help",
      [{ name: "records.csv", header: "invoice_id,amount,payment_date" }],
      "msme-payment",
    ],
    ["Review this", [{ name: "records.xlsx" }], null],
    ["Help", [], null],
    ["Analyze sales and respond to my tax notice", [], null],
    ["Review my tax notice", [{ name: "sales.csv" }], null],
    ["Create a dashboard", [{ name: "invoices.csv" }], null],
  ] as const)(
    "infers conservatively for %s and attachment hints",
    (prompt, attachments, expected) => {
      expect(inferIntakeWorkflow(prompt, [...attachments])).toBe(expected);
    },
  );

  it("recognizes each starter without a classifier or model call", () => {
    for (const [workflow, prompt] of Object.entries(starterPrompts)) {
      expect(inferIntakeWorkflow(prompt, [])).toBe(workflow);
    }
  });
  it("derives a bounded title without changing or truncating the full prompt", () => {
    const prompt = `\n  ${"a".repeat(220)}\nKeep this full context.  `;
    const result = intakeCaseDetails(prompt, "");
    expect(result.success).toBe(true);
    if (!result.success) throw result.error;
    expect(result.data.title).toBe("a".repeat(200));
    expect(result.data.description).toBe(prompt);
    expect(intakeCaseDetails("Prompt", " Custom title ").data?.title).toBe(
      "Custom title",
    );
    expect(intakeCaseDetails("x".repeat(5001), "").success).toBe(false);
    expect(intakeCaseDetails("Prompt", "x".repeat(201)).success).toBe(false);
    expect(intakeCaseDetails(" \n ", "").success).toBe(false);
  });

  it("provides an editable starter for every workflow", () => {
    expect(Object.keys(starterPrompts)).toEqual(Object.keys(workflowSpecs));
    expect(starterPrompts["data-analysis"]).toBe(
      "Analyze my sales spreadsheet, highlight trends and anomalies, and create a dashboard.",
    );
  });

  it("turns missing recommended MSME documents into open questions", () => {
    const questions = deriveIntakeOpenQuestions("msme-payment", [
      "delivery_confirmation.pdf",
    ]);
    expect(questions).toEqual([
      {
        id: "missing-correspondence",
        text: "Consider adding correspondence to strengthen the evidence.",
        severity: "low",
      },
    ]);
  });

  it("validates file type and size from the selected workflow", () => {
    const spec = workflowSpecs["data-analysis"];
    expect(
      validateUploadFile(
        { name: "empty.csv", size: 0, type: "text/csv" },
        spec,
      ),
    ).toBe("Empty files are not allowed.");
    expect(
      validateUploadFile(
        {
          name: "transactions.csv",
          size: 12,
          type: "application/octet-stream",
        },
        spec,
      ),
    ).toBeNull();
    expect(
      validateUploadFile(
        { name: "notice.pdf", size: 12, type: "application/pdf" },
        spec,
      ),
    ).toContain("file type");
    expect(
      validateUploadFile(
        { name: "large.csv", size: spec.maxFileBytes + 1, type: "text/csv" },
        spec,
      ),
    ).toContain("at most 25 MB");
    expect(
      validateUploadFile(
        { name: "limit.csv", size: spec.maxFileBytes, type: "text/csv" },
        spec,
      ),
    ).toBeNull();
  });
});
