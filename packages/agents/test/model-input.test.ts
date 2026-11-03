import { inputTokenAllowance } from "@evianta/ai";
import { describe, expect, it } from "vitest";
import { compactModelInput } from "../src/model-input.js";
import { PriorFindingSchema, SpecialistInputSchema } from "../src/contracts.js";
import { z } from "zod";

describe("lossless model input compaction", () => {
  it("fits repeated evidence metadata without removing business facts or source locations", () => {
    const extraction = {
      method: "pdf-text",
      confidence: 1,
      pageCount: 4,
      minimumPageConfidence: 1,
      hasHandwriting: false,
      warningCount: 0,
      warningCodes: [],
    };
    const sources = Array.from({ length: 8 }, (_, index) => ({
      kind: "document",
      sourceRef: `document-${index}#page=2`,
      confidence: "high",
      documentId: `document-${index}`,
      evidenceId: `evidence-${index}`,
      extraction,
      location: {
        page: 2,
        textQuote: `Original quote ${index}: INR 70,800 contested.`,
      },
    }));
    const findings = Array.from({ length: 8 }, (_, index) =>
      PriorFindingSchema.parse({
        taskId: `task-${index}`,
        role: "analyst",
        findingId: `finding-${index}`,
        title: `Finding ${index}`,
        description: "Rejected goods and pending credit require resolution.",
        severity: "high",
        confidence: 1,
        assumptions: [],
        openQuestions: [],
        evidenceIds: sources.map((source) => source.evidenceId),
        sourceEvidence: sources,
        claims: [
          {
            label: "contested amount",
            value: 70800,
            components: null,
            date: null,
          },
        ],
      }),
    );
    const input = SpecialistInputSchema.parse({
      case: {
        title: "Quality dispute",
        description: "Prepare a dispute letter",
        useCase: "msme-payment",
      },
      task: {
        id: "task",
        key: "evidence-analysis",
        role: "analyst",
        instructions: "Assess all findings",
      },
      priorFindings: findings,
      documents: [],
      humanInput: null,
    });
    const compact = z
      .object({
        priorFindings: z.array(
          z
            .object({
              sourceEvidenceRefs: z.array(
                z.object({
                  index: z.number(),
                  evidenceId: z.string().optional(),
                }),
              ),
            })
            .passthrough(),
        ),
        sourceEvidenceCatalog: z.array(
          z.object({ extractionRef: z.number() }).passthrough(),
        ),
        extractionCatalog: z.array(z.unknown()),
      })
      .parse(compactModelInput(input));
    expect(inputTokenAllowance({ system: "", input })).toBeGreaterThan(32000);
    expect(
      inputTokenAllowance({ system: "", input: compactModelInput(input) }),
    ).toBeLessThan(32000);
    expect(compact.extractionCatalog).toEqual([extraction]);
    expect(compact.sourceEvidenceCatalog).toHaveLength(8);
    for (const [index, finding] of compact.priorFindings.entries()) {
      const { sourceEvidenceRefs, ...rest } = finding;
      const restored = sourceEvidenceRefs.map((ref) => {
        const { extractionRef, ...source } =
          compact.sourceEvidenceCatalog[ref.index]!;
        return {
          ...source,
          evidenceId: ref.evidenceId,
          extraction: compact.extractionCatalog[extractionRef],
        };
      });
      expect({ ...rest, sourceEvidence: restored }).toEqual(findings[index]);
    }
    expect(input.priorFindings).toEqual(findings);
  });

  it("leaves small inputs unchanged rather than adding catalog overhead", () => {
    const input = { priorFindings: [], findings: [] };
    expect(compactModelInput(input)).toBe(input);
  });
});
