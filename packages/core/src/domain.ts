import { z } from "zod";

const IdSchema = z.string().min(1);
const TimestampSchema = z.string().datetime({ offset: true });
const NonNegativeIntegerSchema = z.number().int().nonnegative();
const ConfidenceSchema = z.number().min(0).max(1);
const UsdSchema = z.number().finite().nonnegative();

export const UseCaseSchema = z.enum([
  "data-analysis",
  "tax-notice",
  "msme-payment",
]);
export type UseCase = z.infer<typeof UseCaseSchema>;

export const liveWorkflows: readonly UseCase[] = ["data-analysis"];

export const IntakeConfigurationSchema = z.object({
  workflows: z.array(UseCaseSchema),
  uploadMaxBytes: z.number().int().positive(),
  uploadMaxFiles: z.number().int().positive(),
  documentMaxPages: z.number().int().positive(),
});
export type IntakeConfiguration = z.infer<typeof IntakeConfigurationSchema>;

export const UserRoleSchema = z.enum(["user", "admin"]);
export type UserRole = z.infer<typeof UserRoleSchema>;

export const PrincipalSchema = z.object({
  userId: IdSchema,
  role: UserRoleSchema,
});
export type Principal = z.infer<typeof PrincipalSchema>;

export const UserRecordSchema = z.object({
  id: IdSchema,
  email: z.string().email(),
  displayName: z.string().min(1),
  role: UserRoleSchema,
  disabledAt: TimestampSchema.nullable(),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
});
export type UserRecord = z.infer<typeof UserRecordSchema>;

export const AccessKeyRecordSchema = z.object({
  id: IdSchema,
  userId: IdSchema,
  keyHash: z.string().min(1),
  keyPrefix: z.string().min(1),
  expiresAt: TimestampSchema.nullable(),
  lastUsedAt: TimestampSchema.nullable(),
  revokedAt: TimestampSchema.nullable(),
  createdAt: TimestampSchema,
});
export type AccessKeyRecord = z.infer<typeof AccessKeyRecordSchema>;

export const SessionRecordSchema = z.object({
  id: IdSchema,
  userId: IdSchema,
  accessKeyId: IdSchema.nullable(),
  issuedAt: TimestampSchema,
  expiresAt: TimestampSchema,
  revokedAt: TimestampSchema.nullable(),
  createdAt: TimestampSchema,
});
export type SessionRecord = z.infer<typeof SessionRecordSchema>;

export const UsageCostStatusSchema = z.enum(["estimated", "unknown"]);
export type UsageCostStatus = z.infer<typeof UsageCostStatusSchema>;

export const UsageUnitsSchema = z
  .object({
    input: NonNegativeIntegerSchema.nullable(),
    output: NonNegativeIntegerSchema.nullable(),
    total: NonNegativeIntegerSchema.nullable(),
    reasoning: NonNegativeIntegerSchema.nullable().optional(),
    cacheRead: NonNegativeIntegerSchema.nullable().optional(),
    cacheWrite: NonNegativeIntegerSchema.nullable().optional(),
    search: NonNegativeIntegerSchema.nullable().optional(),
  })
  .superRefine((units, context) => {
    if (
      units.total !== null &&
      units.total < (units.input ?? 0) + (units.output ?? 0)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Total units cannot be less than input plus output units",
        path: ["total"],
      });
    }
  });
export type UsageUnits = z.infer<typeof UsageUnitsSchema>;

export const UsageRecordSchema = z
  .object({
    id: IdSchema,
    attemptId: IdSchema,
    provider: z.string().min(1),
    model: z.string().min(1),
    settings: z.record(z.string(), z.unknown()),
    units: UsageUnitsSchema,
    costUsd: UsdSchema.nullable(),
    costStatus: UsageCostStatusSchema,
    recordedAt: TimestampSchema,
  })
  .superRefine((usage, context) => {
    if (usage.costStatus === "unknown" && usage.costUsd !== null) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Unknown cost must not be represented as a numeric amount",
        path: ["costUsd"],
      });
    }
    if (usage.costStatus === "estimated" && usage.costUsd === null) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Estimated cost requires a known estimate",
        path: ["costUsd"],
      });
    }
  });
export type UsageRecord = z.infer<typeof UsageRecordSchema>;

export const UsagePriceSchema = z.object({
  id: IdSchema,
  provider: z.string().min(1),
  model: z.string().min(1),
  settingsKey: z.string().min(1),
  settings: z.record(z.string(), z.unknown()),
  currency: z.literal("USD"),
  inputUsdPerMillion: UsdSchema,
  outputUsdPerMillion: UsdSchema,
  cacheReadUsdPerMillion: UsdSchema,
  cacheWriteUsdPerMillion: UsdSchema,
  searchUsdPerRequest: UsdSchema.nullable(),
  version: z.number().int().positive(),
  source: z.string().min(1),
  effectiveAt: TimestampSchema,
});
export type UsagePrice = z.infer<typeof UsagePriceSchema>;

export const UsageLedgerEntrySchema = z
  .object({
    id: IdSchema,
    attemptId: IdSchema,
    ownerId: IdSchema,
    caseId: IdSchema,
    runId: IdSchema,
    taskId: IdSchema.nullable(),
    sourceCaseId: IdSchema.nullable(),
    useCase: UseCaseSchema,
    provider: z.string().min(1),
    model: z.string().min(1),
    settings: z.record(z.string(), z.unknown()),
    inputAllowanceTokens: NonNegativeIntegerSchema,
    outputAllowanceTokens: NonNegativeIntegerSchema,
    searchRequested: z.boolean(),
    price: UsagePriceSchema,
    priceId: IdSchema,
    priceVersion: z.number().int().positive(),
    units: UsageUnitsSchema,
    outcome: z.enum(["admitted", "success", "failed", "unknown", "cancelled"]),
    costUsd: UsdSchema.nullable(),
    costStatus: UsageCostStatusSchema,
    reservedUsd: UsdSchema,
    reservationStatus: z.enum(["reserved", "settled", "released"]),
    errorCode: z.string().min(1).nullable(),
    createdAt: TimestampSchema,
    updatedAt: TimestampSchema,
    settledAt: TimestampSchema.nullable(),
  })
  .superRefine((entry, context) => {
    if (
      entry.price.id !== entry.priceId ||
      entry.price.version !== entry.priceVersion
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Usage price snapshot must match its recorded identity",
        path: ["price"],
      });
    }
    if (entry.costStatus === "unknown" && entry.costUsd !== null) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Unknown cost must not be represented as a numeric amount",
        path: ["costUsd"],
      });
    }
    if (entry.costStatus === "estimated" && entry.costUsd === null) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Estimated cost requires a known estimate",
        path: ["costUsd"],
      });
    }
    if (
      (entry.outcome === "admitted") !==
      (entry.reservationStatus === "reserved" && entry.settledAt === null)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Admission state must match reservation and settlement state",
        path: ["outcome"],
      });
    }
    if (
      entry.reservationStatus === "settled" &&
      entry.costStatus !== "estimated"
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Settled reservations require an estimated cost",
        path: ["reservationStatus"],
      });
    }
    if (
      entry.reservationStatus === "released" &&
      !["failed", "cancelled"].includes(entry.outcome)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Released reservations must be cancelled or failed",
        path: ["reservationStatus"],
      });
    }
  });
export type UsageLedgerEntry = z.infer<typeof UsageLedgerEntrySchema>;

export const UsageSummarySchema = z
  .object({
    inputUnits: NonNegativeIntegerSchema.nullable(),
    outputUnits: NonNegativeIntegerSchema.nullable(),
    totalUnits: NonNegativeIntegerSchema.nullable(),
    costUsd: UsdSchema.nullable(),
    costStatus: UsageCostStatusSchema,
    reservedUsd: UsdSchema,
  })
  .superRefine((usage, context) => {
    if (usage.costStatus === "unknown" && usage.costUsd !== null) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Unknown cost must not be represented as a numeric amount",
        path: ["costUsd"],
      });
    }
    if (usage.costStatus === "estimated" && usage.costUsd === null) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Estimated cost requires a known estimate",
        path: ["costUsd"],
      });
    }
    if (
      usage.totalUnits !== null &&
      usage.totalUnits < (usage.inputUnits ?? 0) + (usage.outputUnits ?? 0)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Total units cannot be less than input plus output units",
        path: ["totalUnits"],
      });
    }
  });
export type UsageSummary = z.infer<typeof UsageSummarySchema>;

export const CaseStatusSchema = z.enum(["active", "archived", "deleted"]);
export type CaseStatus = z.infer<typeof CaseStatusSchema>;

export const CaseSchema = z
  .object({
    id: IdSchema,
    title: z.string().min(1),
    description: z.string(),
    useCase: UseCaseSchema,
    ownerId: IdSchema.nullable(),
    isSample: z.boolean(),
    synthetic: z.boolean(),
    sourceCaseId: IdSchema.nullable(),
    deletionRequestedAt: TimestampSchema.nullable().optional(),
    status: CaseStatusSchema,
    usage: UsageSummarySchema,
    createdAt: TimestampSchema,
    updatedAt: TimestampSchema,
  })
  .superRefine((record, context) => {
    if (record.isSample && (record.ownerId !== null || !record.synthetic)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Public samples must be synthetic and ownerless",
        path: ["ownerId"],
      });
    }
    if (!record.isSample && record.ownerId === null) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Real cases require an owner",
        path: ["ownerId"],
      });
    }
  });
export type Case = z.infer<typeof CaseSchema>;

export const AgentProfileSchema = z.object({
  id: IdSchema,
  role: IdSchema,
  displayName: z.string().min(1),
  specialty: z.string().min(1),
  summary: z.string(),
  capabilities: z.array(z.string()),
  tools: z.array(z.string()),
  procedures: z.array(z.string()),
  outputFormats: z.array(z.string()),
  limitations: z.array(z.string()),
  modelTier: z.enum(["cheap", "mid", "high"]),
  enabled: z.boolean(),
});
export type AgentProfile = z.infer<typeof AgentProfileSchema>;

export const AgentProfileSetSchema = z
  .array(AgentProfileSchema)
  .superRefine((profiles, context) => {
    const roles = new Set<string>();
    for (const [index, profile] of profiles.entries()) {
      if (roles.has(profile.role)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Duplicate agent role: ${profile.role}`,
          path: [index, "role"],
        });
      }
      roles.add(profile.role);
    }
  });
export type AgentProfileSet = z.infer<typeof AgentProfileSetSchema>;

export const SanitizedErrorSchema = z.object({
  code: IdSchema,
  message: z.string().min(1).max(500),
});
export type SanitizedError = z.infer<typeof SanitizedErrorSchema>;

export const TaskStatusSchema = z.enum([
  "pending",
  "ready",
  "running",
  "completed",
  "failed",
  "cancelled",
  "skipped",
  "waiting-for-input",
  "limit-reached",
]);
export type TaskStatus = z.infer<typeof TaskStatusSchema>;

export const TaskAttemptSchema = z.object({
  id: IdSchema,
  taskId: IdSchema,
  attemptNumber: z.number().int().positive(),
  status: z.enum(["running", "completed", "failed", "cancelled"]),
  startedAt: TimestampSchema,
  completedAt: TimestampSchema.nullable(),
  usageIds: z.array(IdSchema),
});
export type TaskAttempt = z.infer<typeof TaskAttemptSchema>;

export const TaskSchema = z.object({
  id: IdSchema,
  caseId: IdSchema,
  runId: IdSchema,
  role: IdSchema,
  dependencyIds: z.array(IdSchema),
  instructions: z.string().optional(),
  resumeKeys: z.array(z.string()).optional(),
  resumeInput: z.record(z.string(), z.unknown()).optional(),
  usageEntryCount: NonNegativeIntegerSchema.optional(),
  status: TaskStatusSchema,
  attemptCount: NonNegativeIntegerSchema,
  lastError: SanitizedErrorSchema.nullable(),
  usage: UsageSummarySchema,
});
export type Task = z.infer<typeof TaskSchema>;

export const TaskPlanSchema = z
  .object({
    caseId: IdSchema,
    runId: IdSchema,
    version: z.number().int().positive(),
    tasks: z.array(TaskSchema),
  })
  .superRefine((plan, context) => {
    const taskIds = new Set<string>();
    for (const [index, task] of plan.tasks.entries()) {
      if (taskIds.has(task.id)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Duplicate task id: ${task.id}`,
          path: ["tasks", index, "id"],
        });
      }
      taskIds.add(task.id);

      if (task.caseId !== plan.caseId || task.runId !== plan.runId) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Task case and run identity must match its plan",
          path: ["tasks", index],
        });
      }
    }

    const taskById = new Map(plan.tasks.map((task) => [task.id, task]));
    for (const [index, task] of plan.tasks.entries()) {
      for (const dependencyId of task.dependencyIds) {
        if (dependencyId === task.id || !taskById.has(dependencyId)) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            message:
              dependencyId === task.id
                ? "A task cannot depend on itself"
                : `Unknown dependency task: ${dependencyId}`,
            path: ["tasks", index, "dependencyIds"],
          });
        }
      }
    }

    const visiting = new Set<string>();
    const visited = new Set<string>();
    const hasCycle = (taskId: string): boolean => {
      if (visiting.has(taskId)) return true;
      if (visited.has(taskId)) return false;
      visiting.add(taskId);
      for (const dependencyId of taskById.get(taskId)?.dependencyIds ?? []) {
        if (taskById.has(dependencyId) && hasCycle(dependencyId)) return true;
      }
      visiting.delete(taskId);
      visited.add(taskId);
      return false;
    };

    for (const task of plan.tasks) {
      if (hasCycle(task.id)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Task dependencies must form an acyclic graph",
          path: ["tasks"],
        });
        break;
      }
    }
  });
export type TaskPlan = z.infer<typeof TaskPlanSchema>;

export const DocumentStateSchema = z.enum([
  "uploaded",
  "processing",
  "ready",
  "partial",
  "failed",
]);
export type DocumentState = z.infer<typeof DocumentStateSchema>;

const DocumentMetadataFields = {
  id: IdSchema,
  caseId: IdSchema,
  name: z.string().min(1),
  mimeType: z.string().min(1),
  sizeBytes: NonNegativeIntegerSchema,
  state: DocumentStateSchema,
  uploadedAt: TimestampSchema,
  processedAt: TimestampSchema.nullable(),
};

export const DocumentMetadataRecordSchema = z.object({
  ...DocumentMetadataFields,
  objectKey: z.string().min(1),
  contentHash: z.string().min(1),
});
export type DocumentMetadataRecord = z.infer<
  typeof DocumentMetadataRecordSchema
>;

export const DocumentMetadataDtoSchema = z.object(DocumentMetadataFields);
export type DocumentMetadataDto = z.infer<typeof DocumentMetadataDtoSchema>;

export const ExtractionMethodSchema = z.enum([
  "parse",
  "pdf-text",
  "ocr",
  "handwriting",
  "mixed",
]);
export type ExtractionMethod = z.infer<typeof ExtractionMethodSchema>;

export const BboxSchema = z
  .object({
    x: z.number().min(0).max(1),
    y: z.number().min(0).max(1),
    width: z.number().min(0).max(1),
    height: z.number().min(0).max(1),
  })
  .superRefine((box, context) => {
    if (box.x + box.width > 1 || box.y + box.height > 1) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Bounding box must remain inside normalized document bounds",
      });
    }
  });
export type Bbox = z.infer<typeof BboxSchema>;

export const PositionedSpanSchema = z.object({
  text: z.string(),
  bbox: BboxSchema,
});
export type PositionedSpan = z.infer<typeof PositionedSpanSchema>;

export const ExtractedPageSchema = z.object({
  index: NonNegativeIntegerSchema,
  text: z.string(),
  width: z.number().positive().nullable(),
  height: z.number().positive().nullable(),
  method: ExtractionMethodSchema,
  confidence: ConfidenceSchema,
  spans: z.array(PositionedSpanSchema).default([]),
});
export type ExtractedPage = z.infer<typeof ExtractedPageSchema>;

export const ExtractedColumnTypeSchema = z.enum([
  "string",
  "number",
  "boolean",
  "date",
  "empty",
]);
export type ExtractedColumnType = z.infer<typeof ExtractedColumnTypeSchema>;

export const ExtractedTableSchema = z.object({
  id: IdSchema,
  pageIndex: NonNegativeIntegerSchema.nullable(),
  headers: z.array(z.string()),
  rows: z.array(z.array(z.string().nullable())),
  sourceRowNumbers: z.array(z.number().int().positive()).optional(),
  columnTypes: z.array(ExtractedColumnTypeSchema).optional(),
  sheet: z.string().min(1).optional(),
  cellRange: z.string().min(1).optional(),
});
export type ExtractedTable = z.infer<typeof ExtractedTableSchema>;

const DataAnalysisSourceSchema = z.object({
  documentId: IdSchema,
  tableId: IdSchema,
  sheet: z.string().nullable(),
  cellRange: z.string().nullable(),
  rowRange: z.object({
    start: z.number().int().positive(),
    end: z.number().int().positive(),
  }),
});

const DashboardRowSchema = z.record(
  z.string(),
  z.union([z.string(), z.number(), z.null()]),
);

const BarChartSchema = z.object({
  id: IdSchema,
  title: z.string().min(1),
  type: z.literal("bar"),
  categoryKey: z.string().min(1),
  valueKey: z.string().min(1),
  data: z.array(DashboardRowSchema),
  source: DataAnalysisSourceSchema,
});

const LineChartSchema = z.object({
  id: IdSchema,
  title: z.string().min(1),
  type: z.literal("line"),
  categoryKey: z.string().min(1),
  valueKey: z.string().min(1),
  data: z.array(DashboardRowSchema),
  source: DataAnalysisSourceSchema,
});

const PieChartSchema = z.object({
  id: IdSchema,
  title: z.string().min(1),
  type: z.literal("pie"),
  nameKey: z.string().min(1),
  valueKey: z.string().min(1),
  data: z.array(DashboardRowSchema),
  source: DataAnalysisSourceSchema,
});

export const DataAnalysisDashboardSchema = z.object({
  charts: z.array(
    z.discriminatedUnion("type", [
      BarChartSchema,
      LineChartSchema,
      PieChartSchema,
    ]),
  ),
});
export type DataAnalysisDashboard = z.infer<typeof DataAnalysisDashboardSchema>;

export const DataQualityIssueSchema = z.object({
  code: z.enum([
    "missing-values",
    "duplicate-rows",
    "type-mismatch",
    "out-of-range",
    "inconsistent-date-formats",
    "unordered-periods",
  ]),
  severity: z.enum(["high", "medium", "low"]),
  message: z.string().min(1),
  columns: z.array(z.string()),
  rows: z.array(
    z.object({
      start: z.number().int().positive(),
      end: z.number().int().positive(),
    }),
  ),
  count: z.number().int().positive(),
});
export type DataQualityIssue = z.infer<typeof DataQualityIssueSchema>;

export const DataAnalysisMetricsSchema = z.object({
  rowCount: NonNegativeIntegerSchema,
  valueColumn: z.string().min(1),
  total: z.number().finite(),
  average: z.number().finite(),
  periodColumn: z.string().nullable(),
  byPeriod: z.array(
    z.object({
      label: z.string(),
      value: z.number().finite(),
      growthPercent: z.number().finite().nullable(),
    }),
  ),
  segmentColumn: z.string().nullable(),
  bySegment: z.array(
    z.object({ label: z.string(), value: z.number().finite() }),
  ),
  topSegment: z
    .object({ label: z.string(), value: z.number().finite() })
    .nullable(),
});
export type DataAnalysisMetrics = z.infer<typeof DataAnalysisMetricsSchema>;

export const DataAnalysisReportSchema = z.object({
  summary: z.string(),
  interpretation: z.string(),
  metrics: DataAnalysisMetricsSchema,
  dataQuality: z.array(DataQualityIssueSchema),
  assumptions: z.array(z.string()),
  openQuestions: z.array(
    z.object({
      text: z.string().min(1),
      severity: z.enum(["high", "medium", "low"]),
    }),
  ),
});
export type DataAnalysisReport = z.infer<typeof DataAnalysisReportSchema>;

export const ExtractionWarningSchema = z.object({
  code: IdSchema,
  message: z.string().min(1),
  pageIndex: NonNegativeIntegerSchema.nullable(),
});
export type ExtractionWarning = z.infer<typeof ExtractionWarningSchema>;

export const ExtractedDocumentSchema = z.object({
  documentId: IdSchema,
  kind: z.enum(["tabular", "text"]),
  method: ExtractionMethodSchema,
  confidence: ConfidenceSchema,
  pages: z.array(ExtractedPageSchema).default([]),
  tables: z.array(ExtractedTableSchema).default([]),
  warnings: z.array(ExtractionWarningSchema).default([]),
  cacheIdentity: z.object({
    contentHash: z.string().min(1),
    extractorVersion: z.string().min(1),
    modelVersion: z.string().min(1).nullable(),
  }),
});
export type ExtractedDocument = z.infer<typeof ExtractedDocumentSchema>;
export type ExtractionCacheIdentity = ExtractedDocument["cacheIdentity"];

export const EvidenceConfidenceSchema = z.enum([
  "high",
  "medium",
  "low",
  "unassessed",
]);
export type EvidenceConfidence = z.infer<typeof EvidenceConfidenceSchema>;

export const EvidenceLocationSchema = z
  .object({
    page: z.number().int().positive().optional(),
    sheet: z.string().min(1).optional(),
    cellRange: z.string().min(1).optional(),
    rowRange: z
      .object({
        start: z.number().int().positive(),
        end: z.number().int().positive(),
      })
      .optional(),
    bbox: BboxSchema.optional(),
    textQuote: z.string().min(1).optional(),
  })
  .superRefine((location, context) => {
    if (
      location.page === undefined &&
      location.sheet === undefined &&
      location.cellRange === undefined &&
      location.rowRange === undefined &&
      location.bbox === undefined &&
      location.textQuote === undefined
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Evidence location must identify at least one source position",
      });
    }
    if (location.rowRange && location.rowRange.end < location.rowRange.start) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Row range end must not precede its start",
        path: ["rowRange", "end"],
      });
    }
  });
export type EvidenceLocation = z.infer<typeof EvidenceLocationSchema>;

export const DocumentEvidenceSchema = z.object({
  kind: z.literal("document"),
  id: IdSchema,
  caseId: IdSchema,
  sourceRef: z.string().min(1),
  confidence: EvidenceConfidenceSchema,
  documentId: IdSchema,
  location: EvidenceLocationSchema,
});
export type DocumentEvidence = z.infer<typeof DocumentEvidenceSchema>;

export const ResearchEvidenceSchema = z.object({
  kind: z.literal("research"),
  id: IdSchema,
  caseId: IdSchema,
  sourceRef: z.string().min(1),
  confidence: EvidenceConfidenceSchema,
  citation: z.object({
    url: z.string().url(),
    title: z.string().min(1),
    retrievedAt: TimestampSchema,
    claim: z.string().min(1),
    span: z.string().min(1).nullable(),
  }),
});
export type ResearchEvidence = z.infer<typeof ResearchEvidenceSchema>;

export const EvidenceSchema = z.discriminatedUnion("kind", [
  DocumentEvidenceSchema,
  ResearchEvidenceSchema,
]);
export type Evidence = z.infer<typeof EvidenceSchema>;

export const OpenQuestionSchema = z.object({
  id: IdSchema,
  text: z.string().min(1),
  severity: z.enum(["high", "medium", "low"]),
  status: z.enum(["open", "resolved", "dismissed"]),
  resolutionNote: z.string().nullable(),
  actorId: IdSchema.nullable(),
  updatedAt: TimestampSchema.nullable(),
});
export type OpenQuestion = z.infer<typeof OpenQuestionSchema>;

export const FindingSchema = z.object({
  id: IdSchema,
  caseId: IdSchema,
  title: z.string().min(1),
  description: z.string().min(1),
  severity: z.enum(["high", "medium", "low", "info"]),
  confidence: ConfidenceSchema,
  evidenceIds: z.array(IdSchema),
  assumptions: z.array(z.string()),
  openQuestions: z.array(OpenQuestionSchema),
  createdAt: TimestampSchema,
});
export type Finding = z.infer<typeof FindingSchema>;

export const DeliverableSectionSchema = z.object({
  id: IdSchema,
  title: z.string().min(1),
  kind: z.enum(["text", "table", "chart", "timeline"]),
  content: z.unknown().refine((value) => value !== undefined),
  reviewerContent: z
    .unknown()
    .nullable()
    .refine((value) => value !== undefined),
  reviewerId: IdSchema.nullable(),
  reviewedAt: TimestampSchema.nullable(),
  producingRole: IdSchema,
  routingTier: z.enum(["cheap", "mid", "high"]),
  provider: z.string().min(1).nullable(),
  model: z.string().min(1).nullable(),
  findingIds: z.array(IdSchema),
  evidenceIds: z.array(IdSchema),
  reviewStatus: z.enum(["pending", "accepted", "changes-requested"]),
  reviewComment: z.string().nullable(),
});
export type DeliverableSection = z.infer<typeof DeliverableSectionSchema>;

export const DeliverableSchema = z.object({
  id: IdSchema,
  caseId: IdSchema,
  runId: IdSchema,
  version: z.number().int().positive(),
  format: z.enum(["document", "report", "spreadsheet", "dashboard"]),
  title: z.string().min(1),
  summary: z.string(),
  sections: z.array(DeliverableSectionSchema).default([]),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
});
export type Deliverable = z.infer<typeof DeliverableSchema>;

export const ApprovalSchema = z.object({
  id: IdSchema,
  caseId: IdSchema,
  deliverableId: IdSchema,
  deliverableVersion: z.number().int().positive(),
  actorId: IdSchema,
  approvedAt: TimestampSchema,
  unresolvedQuestionIds: z.array(IdSchema),
  note: z.string(),
});
export type Approval = z.infer<typeof ApprovalSchema>;

export function isApprovalCurrent(
  approval: Pick<Approval, "deliverableId" | "deliverableVersion">,
  deliverable: Pick<Deliverable, "id" | "version">,
): boolean {
  return (
    approval.deliverableId === deliverable.id &&
    approval.deliverableVersion === deliverable.version
  );
}

export const EvaluationResultSchema = z
  .object({
    id: IdSchema,
    useCase: UseCaseSchema,
    elapsedMs: NonNegativeIntegerSchema,
    checklist: z.object({
      passed: NonNegativeIntegerSchema,
      total: NonNegativeIntegerSchema,
      items: z.array(
        z.object({
          id: IdSchema,
          passed: z.boolean(),
          note: z.string().nullable(),
        }),
      ),
    }),
    materialClaimTraceability: z.object({
      traceable: NonNegativeIntegerSchema,
      total: NonNegativeIntegerSchema,
    }),
    seededErrors: z.object({
      caughtIds: z.array(IdSchema),
      missedIds: z.array(IdSchema),
    }),
    openQuestionIds: z.array(IdSchema),
    reviewerCorrections: z.array(
      z.object({
        id: IdSchema,
        description: z.string().min(1),
      }),
    ),
    usage: UsageSummarySchema,
    verificationStatus: z.enum(["passed", "failed", "partial", "not-run"]),
  })
  .superRefine((result, context) => {
    if (result.checklist.passed > result.checklist.total) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Passed checklist count cannot exceed the total",
        path: ["checklist", "passed"],
      });
    }
    if (result.checklist.items.length !== result.checklist.total) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Checklist items must match the declared total",
        path: ["checklist", "items"],
      });
    }
    if (
      result.checklist.items.filter((item) => item.passed).length !==
      result.checklist.passed
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Passed count must match the checklist item results",
        path: ["checklist", "passed"],
      });
    }
    if (
      result.materialClaimTraceability.traceable >
      result.materialClaimTraceability.total
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Traceable claim count cannot exceed the total",
        path: ["materialClaimTraceability", "traceable"],
      });
    }
    if (
      new Set([
        ...result.seededErrors.caughtIds,
        ...result.seededErrors.missedIds,
      ]).size !==
      result.seededErrors.caughtIds.length +
        result.seededErrors.missedIds.length
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "A seeded error cannot be both caught and missed",
        path: ["seededErrors"],
      });
    }
  });
export type EvaluationResult = z.infer<typeof EvaluationResultSchema>;

export const RunStatusSchema = z.enum([
  "queued",
  "running",
  "completed",
  "partially-completed",
  "failed",
  "cancelled",
  "limit-reached",
  "waiting-for-input",
]);
export type RunStatus = z.infer<typeof RunStatusSchema>;

export const RunRecordSchema = z.object({
  id: IdSchema,
  caseId: IdSchema,
  ownerId: IdSchema,
  threadId: IdSchema,
  planVersion: z.number().int().positive(),
  status: RunStatusSchema,
  priorRunId: IdSchema.nullable(),
  leaseId: IdSchema.nullable(),
  fencingToken: NonNegativeIntegerSchema,
  leaseExpiresAt: TimestampSchema.nullable(),
  cancellationRequested: z.boolean(),
  terminalEvent: z
    .object({
      pending: z.boolean(),
      reason: z.string().nullable(),
      error: SanitizedErrorSchema.nullable(),
    })
    .optional(),
  inputRequired: z.boolean(),
  usage: UsageSummarySchema,
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
});
export type RunRecord = z.infer<typeof RunRecordSchema>;

export const RunDtoSchema = z.object({
  id: IdSchema,
  caseId: IdSchema,
  planVersion: z.number().int().positive(),
  status: RunStatusSchema,
  priorRunId: IdSchema.nullable(),
  cancellationRequested: z.boolean(),
  inputRequired: z.boolean(),
  usage: UsageSummarySchema,
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
});
export type RunDto = z.infer<typeof RunDtoSchema>;

const EventPayloadSchemas = [
  z.object({
    type: z.literal("run-started"),
    planVersion: z.number().int().positive(),
  }),
  z.object({
    type: z.literal("task-started"),
    taskId: IdSchema,
    role: IdSchema,
  }),
  z.object({
    type: z.literal("task-completed"),
    taskId: IdSchema,
    role: IdSchema,
    usage: UsageSummarySchema,
  }),
  z.object({
    type: z.literal("task-failed"),
    taskId: IdSchema,
    role: IdSchema,
    error: SanitizedErrorSchema,
  }),
  z.object({ type: z.literal("finding-added"), findingId: IdSchema }),
  z.object({ type: z.literal("cost-updated"), usage: UsageSummarySchema }),
  z.object({
    type: z.literal("run-completed"),
    deliverableIds: z.array(IdSchema),
  }),
  z.object({
    type: z.literal("run-failed"),
    error: SanitizedErrorSchema,
  }),
  z.object({ type: z.literal("run-cancelled"), reason: z.string().nullable() }),
  z.object({ type: z.literal("limit-reached"), limit: z.string().min(1) }),
  z.object({
    type: z.literal("input-required"),
    questionIds: z.array(IdSchema),
  }),
] as const;

export const RunEventPayloadSchema = z.discriminatedUnion("type", [
  ...EventPayloadSchemas,
]);
export type RunEventPayload = z.infer<typeof RunEventPayloadSchema>;

export const RunEventSchema = z.object({
  id: IdSchema,
  caseId: IdSchema,
  runId: IdSchema,
  sequence: z.number().int().positive(),
  occurredAt: TimestampSchema,
  payload: RunEventPayloadSchema,
});
export type RunEvent = z.infer<typeof RunEventSchema>;

export const UsageReservationSchema = z
  .object({
    id: IdSchema,
    attemptId: IdSchema,
    idempotencyKey: z.string().min(1),
    ownerId: IdSchema,
    caseId: IdSchema,
    runId: IdSchema,
    periodStart: TimestampSchema,
    periodSeconds: z.number().int().positive(),
    reservedUsd: UsdSchema,
    actualCostUsd: UsdSchema.nullable(),
    status: z.enum(["reserved", "settled", "released", "expired"]),
    createdAt: TimestampSchema,
    updatedAt: TimestampSchema,
    expiresAt: TimestampSchema,
    recoveryCheckedAt: TimestampSchema.nullable().optional(),
  })
  .superRefine((reservation, context) => {
    if (
      (reservation.status === "settled") !==
      (reservation.actualCostUsd !== null)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Settled reservations must have a known actual cost",
        path: ["actualCostUsd"],
      });
    }
  });
export type UsageReservation = z.infer<typeof UsageReservationSchema>;

export const CreateCaseRequestSchema = z.object({
  title: z.string().min(1).max(200),
  description: z.string().max(5000).default(""),
  useCase: UseCaseSchema,
  sourceCaseId: IdSchema.nullable().optional(),
});
export type CreateCaseRequest = z.infer<typeof CreateCaseRequestSchema>;

export const CaseResponseSchema = z.object({ case: CaseSchema });
export type CaseResponse = z.infer<typeof CaseResponseSchema>;

export const ListCasesResponseSchema = z.object({
  cases: z.array(CaseSchema),
  nextCursor: z.string().nullable(),
});
export type ListCasesResponse = z.infer<typeof ListCasesResponseSchema>;

export const CreateRunRequestSchema = z.object({
  caseId: IdSchema,
  priorRunId: IdSchema.nullable().optional(),
  input: z.record(z.string(), z.unknown()).default({}),
});
export type CreateRunRequest = z.infer<typeof CreateRunRequestSchema>;

export const RunResponseSchema = z.object({ run: RunDtoSchema });
export type RunResponse = z.infer<typeof RunResponseSchema>;

export const LatestRunResponseSchema = z.object({
  run: RunDtoSchema.nullable(),
});
export type LatestRunResponse = z.infer<typeof LatestRunResponseSchema>;

export const CreateDocumentUploadRequestSchema = z.object({
  caseId: IdSchema,
  name: z.string().min(1).max(255),
  mimeType: z.string().min(1).max(255),
  sizeBytes: z.number().int().positive(),
});
export type CreateDocumentUploadRequest = z.infer<
  typeof CreateDocumentUploadRequestSchema
>;

export const DocumentResponseSchema = z.object({
  document: DocumentMetadataDtoSchema,
});
export type DocumentResponse = z.infer<typeof DocumentResponseSchema>;

export const ApiErrorSchema = z.object({
  error: z.object({
    code: z.enum([
      "unauthenticated",
      "forbidden",
      "not-found",
      "validation-failed",
      "conflict",
      "limit-reached",
      "internal-error",
    ]),
    message: z.string().min(1),
    requestId: IdSchema.nullable(),
    details: z.array(
      z.object({
        path: z.array(z.union([z.string(), z.number()])),
        message: z.string(),
      }),
    ),
  }),
});
export type ApiError = z.infer<typeof ApiErrorSchema>;
