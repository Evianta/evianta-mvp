import {
  DataAnalysisDashboardSchema,
  DataAnalysisReportSchema,
  EvidenceLocationSchema,
  UseCaseSchema,
} from "@evianta/core";
import { z } from "zod";

const SeveritySchema = z.enum(["high", "medium", "low"]);

export const NumericClaimSchema = z.object({
  label: z.string().min(1),
  value: z.number().nullable(),
  components: z.array(z.number()).nullable(),
  date: z.string().nullable(),
});
export type NumericClaim = z.infer<typeof NumericClaimSchema>;

export const EvidenceDraftSchema = z.object({
  kind: z.enum(["document", "research"]),
  sourceRef: z.string().min(1),
  confidence: z.enum(["high", "medium", "low", "unassessed"]),
  documentId: z.string().nullable(),
  page: z.number().int().positive().nullable(),
  location: EvidenceLocationSchema.optional(),
  textQuote: z.string().nullable(),
  url: z.string().nullable(),
  title: z.string().nullable(),
  claim: z.string().nullable(),
});
export type EvidenceDraft = z.infer<typeof EvidenceDraftSchema>;

export const FindingDraftSchema = z.object({
  title: z.string().min(1),
  description: z.string().min(1),
  severity: z.enum(["high", "medium", "low", "info"]),
  confidence: z.number().min(0).max(1),
  evidence: z.array(EvidenceDraftSchema),
  assumptions: z.array(z.string()),
  openQuestions: z.array(
    z.object({ text: z.string().min(1), severity: SeveritySchema }),
  ),
  claims: z.array(NumericClaimSchema),
});
export type FindingDraft = z.infer<typeof FindingDraftSchema>;

export const SpecialistOutputSchema = z.object({
  summary: z.string(),
  findings: z.array(FindingDraftSchema),
  report: DataAnalysisReportSchema.optional(),
  dashboard: DataAnalysisDashboardSchema.optional(),
  inputRequired: z
    .object({
      questions: z.array(
        z.object({ text: z.string().min(1), severity: SeveritySchema }),
      ),
    })
    .nullable(),
});
export type SpecialistOutput = z.infer<typeof SpecialistOutputSchema>;

export const PriorFindingSchema = z.object({
  taskId: z.string(),
  role: z.string(),
  findingId: z.string(),
  title: z.string(),
  description: z.string(),
  severity: z.string(),
  evidenceIds: z.array(z.string()),
  claims: z.array(NumericClaimSchema),
});
export type PriorFinding = z.infer<typeof PriorFindingSchema>;

export const DocumentSliceSchema = z.object({
  documentId: z.string(),
  name: z.string(),
  pages: z.array(z.object({ page: z.number().int(), text: z.string() })),
  tables: z
    .array(
      z.object({
        tableId: z.string(),
        sheet: z.string().nullable(),
        cellRange: z.string().nullable(),
        text: z.string(),
      }),
    )
    .optional(),
  truncated: z.boolean(),
});

export const SpecialistInputSchema = z.object({
  case: z.object({
    title: z.string(),
    description: z.string(),
    useCase: UseCaseSchema,
  }),
  task: z.object({
    id: z.string(),
    key: z.string(),
    role: z.string(),
    instructions: z.string(),
  }),
  priorFindings: z.array(PriorFindingSchema),
  documents: z.array(DocumentSliceSchema),
  humanInput: z.unknown().nullable(),
});
export type SpecialistInput = z.infer<typeof SpecialistInputSchema>;

export const ReviewFlagSchema = z.object({
  id: z.string(),
  code: z.enum([
    "total-mismatch",
    "missing-evidence",
    "inconsistent-figure",
    "inconsistent-date",
  ]),
  severity: SeveritySchema,
  text: z.string(),
  findingIds: z.array(z.string()),
});
export type ReviewFlag = z.infer<typeof ReviewFlagSchema>;

export const ReviewInputSchema = z.object({
  case: SpecialistInputSchema.shape.case,
  instructions: z.string(),
  findings: z.array(PriorFindingSchema),
  deterministicFlags: z.array(ReviewFlagSchema),
});
export type ReviewInput = z.infer<typeof ReviewInputSchema>;

export const ReviewOutputSchema = z.object({
  summary: z.string(),
  items: z.array(
    z.object({
      text: z.string().min(1),
      severity: SeveritySchema,
      findingId: z.string().nullable(),
    }),
  ),
});
export type ReviewOutput = z.infer<typeof ReviewOutputSchema>;

export const PlanningInputSchema = z.object({
  useCase: UseCaseSchema,
  description: z.string(),
  documents: z.array(
    z.object({ id: z.string(), name: z.string(), mimeType: z.string() }),
  ),
  referencePlan: z.array(
    z.object({
      key: z.string(),
      role: z.string(),
      dependsOn: z.array(z.string()),
      required: z.boolean(),
      instructions: z.string(),
    }),
  ),
  availableRoles: z.array(z.string()),
});
export type PlanningInput = z.infer<typeof PlanningInputSchema>;

export const PlanningOutputSchema = z.object({
  tasks: z.array(
    z.object({
      key: z
        .string()
        .regex(/^[a-z0-9][a-z0-9-]{0,62}$/)
        .describe("Stable lowercase task key"),
      assignedRole: z.string().min(1),
      dependsOn: z.array(z.string()),
      instructions: z.string(),
    }),
  ),
});
export type PlanningOutput = z.infer<typeof PlanningOutputSchema>;
