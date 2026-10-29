import { describe, expect, it } from "vitest";
import {
  deriveIntakeOpenQuestions,
  validateUploadFile,
  workflowSpecs,
} from "../src/intake.js";

describe("case intake", () => {
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
    ).toContain("smaller");
  });
});
