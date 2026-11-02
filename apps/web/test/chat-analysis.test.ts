import type { UseCase } from "@evianta/core";
import { describe, expect, it } from "vitest";
import {
  assignSlots,
  buildTaskDescription,
  planNextStep,
  resolveWorkflow,
  type AttachedFile,
  type Draft,
} from "../src/chat/analysis.js";

let counter = 0;
function file(name: string, extra: Partial<AttachedFile> = {}): AttachedFile {
  counter += 1;
  return {
    id: `f${counter}`,
    file: new File(["x"], name),
    ...extra,
  };
}

function draft(overrides: Partial<Draft> = {}): Draft {
  return {
    prompt: "",
    files: [],
    workflow: null,
    answers: {},
    skippedSlots: [],
    ...overrides,
  };
}

describe("workflow detection", () => {
  it("uses the message and file names, and reports conflicts as candidates", () => {
    expect(
      resolveWorkflow(
        draft({ prompt: "Help me reply to my 143(1) intimation" }),
      ),
    ).toBe("tax-notice");
    const step = planNextStep(
      draft({
        prompt: "Analyze my sales data",
        files: [file("overdue_invoices.csv")],
      }),
    );
    expect(step).toEqual({
      type: "workflow",
      candidates: ["data-analysis", "msme-payment"],
    });
  });

  it("asks for a choice when nothing is recognizable", () => {
    expect(planNextStep(draft({ prompt: "Can you help me?" }))).toEqual({
      type: "workflow",
      candidates: [],
    });
  });

  it("trusts an explicit choice over later text", () => {
    expect(
      resolveWorkflow(draft({ prompt: "invoice", workflow: "tax-notice" })),
    ).toBe("tax-notice");
  });
});

describe("document slots", () => {
  it("matches files to slots by name and does not reuse a file", () => {
    const notice = file("notice.pdf");
    const form = file("Form26AS.pdf");
    const assignments = assignSlots("tax-notice", [notice, form]);
    expect(assignments.map((item) => item.fileId)).toEqual([
      notice.id,
      form.id,
    ]);
    expect(assignments.every((item) => !item.assumed)).toBe(true);
  });

  it("assumes a leftover file fills a gap and says so", () => {
    const stray = file("scan0001.pdf");
    const assignments = assignSlots("tax-notice", [stray]);
    expect(assignments[0]).toMatchObject({ fileId: stray.id, assumed: true });
    expect(assignments[1]?.fileId).toBeNull();
  });

  it("asks for the first missing required document", () => {
    const step = planNextStep(
      draft({
        prompt: "Help me reply to my 143(1) intimation for AY 2024-25",
        files: [file("notice.pdf")],
      }),
    );
    expect(step).toMatchObject({ type: "document", slot: { id: "return" } });
  });

  it("requires a tabular file for data analysis and never lets it be skipped", () => {
    const withPdf = draft({
      prompt: "Analyze my sales",
      files: [file("summary.pdf")],
    });
    const step = planNextStep(withPdf);
    expect(step).toMatchObject({
      type: "document",
      slot: { id: "dataset", skippable: false },
    });
  });

  it("proceeds once a skippable slot is skipped", () => {
    const step = planNextStep(
      draft({
        prompt: "MSME delayed payment for AY 2024-25, 45 days terms",
        files: [file("invoices.csv")],
        skippedSlots: ["payments"],
      }),
    );
    expect(step.type).toBe("ready");
  });
});

describe("missing facts", () => {
  const base = {
    files: [file("notice.pdf"), file("itr.pdf")],
  };

  it("asks for the assessment year only when it is not already known", () => {
    expect(
      planNextStep(draft({ ...base, prompt: "Reply to my tax notice" })),
    ).toMatchObject({ type: "fact", fact: { id: "assessment-year" } });
    expect(
      planNextStep(
        draft({ ...base, prompt: "Reply to my tax notice for AY 2024-25" }),
      ).type,
    ).toBe("ready");
    expect(
      planNextStep(
        draft({
          ...base,
          prompt: "Reply to my tax notice",
          answers: { "assessment-year": "AY 2023-24" },
        }),
      ).type,
    ).toBe("ready");
  });

  it("finds the year in a small file sample", () => {
    const sampled = file("notice.txt", {
      sample: "Notice under section 143(1) for Assessment Year 2024-25",
    });
    expect(
      planNextStep(
        draft({
          prompt: "Reply to my tax notice",
          files: [sampled, file("itr.pdf")],
        }),
      ).type,
    ).toBe("ready");
  });

  it("asks about payment terms for delayed-payment work", () => {
    expect(
      planNextStep(
        draft({
          prompt: "MSME overdue invoices",
          files: [file("invoices.csv"), file("bank_statement.csv")],
        }),
      ),
    ).toMatchObject({ type: "fact", fact: { id: "payment-terms" } });
  });

  it("never asks data analysis for extra facts", () => {
    expect(
      planNextStep(
        draft({
          prompt: "Analyze my sales",
          files: [file("sales.csv")],
        }),
      ).type,
    ).toBe("ready");
  });
});

describe("task description", () => {
  it("appends chat details and skipped documents without losing the prompt", () => {
    const value = buildTaskDescription(
      draft({
        prompt: "Reply to my tax notice",
        workflow: "tax-notice" as UseCase,
        answers: { "assessment-year": "AY 2024-25" },
        skippedSlots: ["return"],
      }),
    );
    expect(value).toContain("Reply to my tax notice");
    expect(value).toContain("- Assessment year: AY 2024-25");
    expect(value).toContain("- Not available: your return or income summary");
  });

  it("stays within the limit", () => {
    const value = buildTaskDescription(
      draft({
        prompt: "x".repeat(6000),
        workflow: "tax-notice",
        answers: { "assessment-year": "AY 2024-25" },
      }),
      5000,
    );
    expect(value.length).toBeLessThanOrEqual(5000);
    expect(value).toContain("Assessment year");
  });
});
