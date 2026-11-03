import { z } from "zod";
import { PriorFindingSchema } from "./contracts.js";

type PriorFinding = z.infer<typeof PriorFindingSchema>;

export function compactModelInput<
  T extends { priorFindings?: PriorFinding[]; findings?: PriorFinding[] },
>(input: T): unknown {
  const evidence: unknown[] = [];
  const extractions: unknown[] = [];
  const evidenceKeys = new Map<string, number>();
  const extractionKeys = new Map<string, number>();
  function index(
    value: unknown,
    values: unknown[],
    keys: Map<string, number>,
  ): number {
    const key = JSON.stringify(value);
    const existing = keys.get(key);
    if (existing !== undefined) return existing;
    const next = values.length;
    keys.set(key, next);
    values.push(value);
    return next;
  }
  const compact = (findings: PriorFinding[]) =>
    findings.map((finding) => {
      const { sourceEvidence, ...rest } = finding;
      if (!sourceEvidence?.length) return finding;
      return {
        ...rest,
        sourceEvidenceRefs: sourceEvidence.map((source) => {
          const { extraction, evidenceId, ...details } = source;
          const entry = extraction
            ? {
                ...details,
                extractionRef: index(extraction, extractions, extractionKeys),
              }
            : {
                ...details,
                ...(extraction !== undefined ? { extraction } : {}),
              };
          return {
            index: index(entry, evidence, evidenceKeys),
            ...(evidenceId !== undefined ? { evidenceId } : {}),
          };
        }),
      };
    });
  const result = {
    ...input,
    ...(input.priorFindings
      ? { priorFindings: compact(input.priorFindings) }
      : {}),
    ...(input.findings ? { findings: compact(input.findings) } : {}),
    sourceEvidenceCatalog: evidence,
    extractionCatalog: extractions,
  };
  return Buffer.byteLength(JSON.stringify(result), "utf8") <
    Buffer.byteLength(JSON.stringify(input), "utf8")
    ? result
    : input;
}

export const compactInputInstructions =
  "When sourceEvidenceCatalog is present, each finding's sourceEvidenceRefs has an index (zero-based position in that catalog) and the original evidenceId when available. An extractionRef is a zero-based index into extractionCatalog. Resolve these references when assessing evidence; all source identities, locations and reliability facts remain available.";
