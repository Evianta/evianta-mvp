import { describe, expect, it } from "vitest";
import { artifactPdfDefinition, fileSlug } from "../src/chart-export";

describe("chart export helpers", () => {
  it("builds safe file names", () => {
    expect(fileSlug("Revenue by month (FY 25-26)")).toBe(
      "revenue-by-month-fy-25-26",
    );
    expect(fileSlug("###")).toBe("chart");
  });

  it("includes every table row and the source in the PDF", () => {
    const rows = Array.from({ length: 250 }, (_, index) => [
      `Row ${index}`,
      String(index),
    ]);
    const definition = artifactPdfDefinition(
      { title: "Revenue data", source: "Source: sales.csv" },
      { table: { headers: ["period", "revenue"], rows } },
    );
    const content = JSON.stringify(definition.content);
    expect(content).toContain("Source: sales.csv");
    expect(content).toContain("Row 249");
    expect(definition.pageOrientation).toBe("landscape");
  });

  it("embeds a chart image in the PDF", () => {
    const definition = artifactPdfDefinition(
      { title: "Revenue by month" },
      { image: "data:image/png;base64,AAAA" },
    );
    expect(JSON.stringify(definition.content)).toContain(
      "data:image/png;base64,AAAA",
    );
  });
});
