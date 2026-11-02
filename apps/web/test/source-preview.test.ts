import { describe, expect, it } from "vitest";
import { sourcePreviewMimeType } from "../src/source-preview";

describe("source preview MIME types", () => {
  it.each([
    ["report.pdf", "application/x-pdf", "application/pdf"],
    ["report.pdf", "application/octet-stream", "application/pdf"],
    ["sales.csv", "application/csv", "text/csv"],
    ["sales.csv", "text/x-csv", "text/csv"],
    ["sales.csv", "application/vnd.ms-excel", "text/csv"],
    ["sales.csv", "application/octet-stream", "text/csv"],
    ["notes.txt", "text/plain", "text/plain"],
    ["notice.md", "text/markdown", "text/plain"],
    ["notice.md", "application/octet-stream", "text/plain"],
    ["notice.MD", "", "text/plain"],
    ["correspondence.markdown", "text/plain", "text/plain"],
    ["payments.tsv", "text/tab-separated-values", "text/plain"],
    ["records.json", "application/json", "text/plain"],
    ["records.json", "application/octet-stream", "text/plain"],
    ["scan.png", "image/png", "image/png"],
  ])("normalizes %s declared as %s", (name, mimeType, expected) => {
    expect(sourcePreviewMimeType({ name, mimeType })).toBe(expected);
  });

  it("does not mistake an Excel workbook for CSV", () => {
    expect(
      sourcePreviewMimeType({
        name: "sales.xls",
        mimeType: "application/vnd.ms-excel",
      }),
    ).toBeNull();
  });

  it("does not render uploaded HTML as a page", () => {
    expect(
      sourcePreviewMimeType({ name: "notes.html", mimeType: "text/html" }),
    ).toBe("text/plain");
  });
});
