import { describe, expect, expectTypeOf, it } from "vitest";

import {
  AgentProfileSetSchema,
  ApiErrorSchema,
  CaseSchema,
  CreateDocumentUploadRequestSchema,
  DocumentMetadataDtoSchema,
  EvidenceLocationSchema,
  EvaluationResultSchema,
  RunDtoSchema,
  SyntheticWorkflowFixtureSchema,
  TaskPlanSchema,
  UsageRecordSchema,
  UsageSummarySchema,
  UsageUnitsSchema,
  isApprovalCurrent,
  syntheticWorkflowFixtures,
} from "@evianta/core";

const now = "2026-01-15T00:00:00.000Z";
const usage = {
  inputUnits: 0,
  outputUnits: 0,
  totalUnits: 0,
  costUsd: 0,
  costStatus: "estimated" as const,
  reservedUsd: 0,
};

const makeTask = (id: string, dependencyIds: string[] = []) => ({
  id,
  caseId: "case-1",
  runId: "run-1",
  role: "analyst",
  dependencyIds,
  status: "pending" as const,
  attemptCount: 0,
  lastError: null,
  usage,
});

describe("domain schemas", () => {
  it("enforces case ownership and synthetic-sample invariants", () => {
    const sample = syntheticWorkflowFixtures.dataAnalysis.case;
    expect(CaseSchema.safeParse(sample).success).toBe(true);
    expect(
      CaseSchema.safeParse({
        ...sample,
        synthetic: false,
      }).success,
    ).toBe(false);
    expect(
      CaseSchema.safeParse({
        ...sample,
        isSample: false,
        ownerId: null,
      }).success,
    ).toBe(false);
  });

  it("strips private storage and orchestration fields from public DTOs", () => {
    const document = DocumentMetadataDtoSchema.parse({
      ...syntheticWorkflowFixtures.dataAnalysis.documents[0],
      objectKey: "private/users/u1/document",
      contentHash: "internal-hash",
    });
    expect(document).not.toHaveProperty("objectKey");
    expect(document).not.toHaveProperty("contentHash");

    const run = RunDtoSchema.parse({
      id: "run-1",
      caseId: "case-1",
      planVersion: 1,
      status: "running",
      priorRunId: null,
      cancellationRequested: false,
      inputRequired: false,
      usage,
      createdAt: now,
      updatedAt: now,
      ownerId: "owner-1",
      threadId: "checkpoint-thread",
      fencingToken: 9,
      leaseId: "lease-1",
    });
    expect(run).not.toHaveProperty("threadId");
    expect(run).not.toHaveProperty("fencingToken");
    expect(run).not.toHaveProperty("leaseId");
  });

  it("accepts upload metadata without a client-supplied content hash", () => {
    const request = {
      caseId: "case-1",
      name: "source.pdf",
      mimeType: "application/pdf",
      sizeBytes: 1200,
    };
    expect(CreateDocumentUploadRequestSchema.parse(request)).toEqual(request);
    expect(
      CreateDocumentUploadRequestSchema.parse({
        ...request,
        contentHash: "untrusted-client-hash",
      }),
    ).toEqual(request);
  });

  it("validates task references and rejects cyclic plans", () => {
    const basePlan = {
      caseId: "case-1",
      runId: "run-1",
      version: 1,
    };

    expect(
      TaskPlanSchema.safeParse({
        ...basePlan,
        tasks: [makeTask("first"), makeTask("second", ["first"])],
      }).success,
    ).toBe(true);
    expect(
      TaskPlanSchema.safeParse({
        ...basePlan,
        tasks: [makeTask("first", ["missing"])],
      }).success,
    ).toBe(false);
    expect(
      TaskPlanSchema.safeParse({
        ...basePlan,
        tasks: [makeTask("first", ["second"]), makeTask("second", ["first"])],
      }).success,
    ).toBe(false);
  });

  it("requires unique agent roles and sanitized task errors", () => {
    const profile = {
      id: "agent-1",
      role: "analyst",
      displayName: "Analyst",
      specialty: "Business data",
      summary: "",
      capabilities: [],
      tools: [],
      procedures: [],
      outputFormats: [],
      limitations: [],
      modelTier: "mid",
      enabled: true,
    } as const;
    expect(AgentProfileSetSchema.safeParse([profile]).success).toBe(true);
    expect(AgentProfileSetSchema.safeParse([profile, profile]).success).toBe(
      false,
    );
    expect(
      TaskPlanSchema.safeParse({
        caseId: "case-1",
        runId: "run-1",
        version: 1,
        tasks: [{ ...makeTask("first"), lastError: "raw stack trace" }],
      }).success,
    ).toBe(false);
  });

  it("supports approximate evidence locations and structured questions", () => {
    expect(
      EvidenceLocationSchema.safeParse({
        page: 2,
        bbox: { x: 0.1, y: 0.2, width: 0.3, height: 0.4 },
      }).success,
    ).toBe(true);
    expect(
      EvidenceLocationSchema.safeParse({
        page: 1,
        bbox: { x: 0.8, y: 0.2, width: 0.3, height: 0.4 },
      }).success,
    ).toBe(false);
    expect(
      ApiErrorSchema.safeParse({
        error: {
          code: "validation-failed",
          message: "Invalid request",
          requestId: null,
          details: [],
        },
      }).success,
    ).toBe(true);
  });

  it("preserves unknown usage and rejects cost-shaped free fallbacks", () => {
    expect(
      UsageRecordSchema.safeParse({
        id: "usage-1",
        attemptId: "attempt-1",
        provider: "mock",
        model: "synthetic",
        settings: {},
        units: {
          input: null,
          output: null,
          total: null,
          reasoning: null,
          cacheRead: null,
          cacheWrite: null,
          search: null,
        },
        costUsd: null,
        costStatus: "unknown",
        recordedAt: now,
      }).success,
    ).toBe(true);
    expect(
      UsageRecordSchema.safeParse({
        id: "usage-2",
        attemptId: "attempt-2",
        provider: "mock",
        model: "synthetic",
        settings: {},
        units: { input: 0, output: 0, total: 0 },
        costUsd: 0,
        costStatus: "unknown",
        recordedAt: now,
      }).success,
    ).toBe(false);
    expect(
      UsageSummarySchema.safeParse({
        ...usage,
        inputUnits: null,
        outputUnits: 0,
        totalUnits: null,
      }).success,
    ).toBe(true);
  });

  it.each([
    { input: 100, output: null, total: 0 },
    { input: null, output: 100, total: 0 },
    { input: 100, output: 50, total: 149 },
    { input: 100, output: null, total: 99 },
  ])("rejects totals below known usage components: %j", (units) => {
    expect(UsageUnitsSchema.safeParse(units).success).toBe(false);
    expect(
      UsageSummarySchema.safeParse({
        ...usage,
        inputUnits: units.input,
        outputUnits: units.output,
        totalUnits: units.total,
      }).success,
    ).toBe(false);
  });

  it.each([
    { input: 100, output: null, total: 100 },
    { input: null, output: 100, total: 100 },
    { input: 100, output: null, total: null },
    { input: null, output: null, total: 0 },
    { input: 100, output: 50, total: 150 },
  ])("preserves valid partial usage: %j", (units) => {
    expect(UsageUnitsSchema.parse(units)).toEqual(units);
    const summary = {
      ...usage,
      inputUnits: units.input,
      outputUnits: units.output,
      totalUnits: units.total,
    };
    expect(UsageSummarySchema.parse(summary)).toEqual(summary);
  });

  it.each(Object.values(syntheticWorkflowFixtures))(
    "rejects owned or non-sample fixture cases: $case.useCase",
    (fixture) => {
      expect(
        SyntheticWorkflowFixtureSchema.safeParse({
          ...fixture,
          case: {
            ...fixture.case,
            isSample: false,
            synthetic: false,
            ownerId: "owner-1",
          },
        }).success,
      ).toBe(false);
      expect(
        SyntheticWorkflowFixtureSchema.safeParse({
          ...fixture,
          case: {
            ...fixture.case,
            isSample: false,
            synthetic: true,
            ownerId: "owner-1",
          },
        }).success,
      ).toBe(false);
    },
  );

  it("exports workflow-specific expected types and correct document MIME types", () => {
    expectTypeOf(
      syntheticWorkflowFixtures.dataAnalysis.expected.totalRevenue,
    ).toEqualTypeOf<number>();
    expectTypeOf(
      syntheticWorkflowFixtures.taxNotice.expected.incomeDifference,
    ).toEqualTypeOf<number>();
    expectTypeOf(
      syntheticWorkflowFixtures.msmePayment.expected.outstanding,
    ).toEqualTypeOf<number>();
    for (const fixture of Object.values(syntheticWorkflowFixtures)) {
      for (const document of fixture.documents) {
        expect(document.mimeType).toBe(
          document.name.endsWith(".pdf") ? "application/pdf" : "text/csv",
        );
      }
    }
  });

  it("accepts only well-formed evaluation summaries and current approvals", () => {
    expect(
      EvaluationResultSchema.safeParse({
        id: "evaluation-1",
        useCase: "data-analysis",
        elapsedMs: 1200,
        checklist: {
          passed: 1,
          total: 1,
          items: [{ id: "metrics", passed: true, note: null }],
        },
        materialClaimTraceability: { traceable: 1, total: 1 },
        seededErrors: { caughtIds: ["wrong-total"], missedIds: [] },
        openQuestionIds: [],
        reviewerCorrections: [],
        usage,
        verificationStatus: "passed",
      }).success,
    ).toBe(true);
    expect(
      EvaluationResultSchema.safeParse({
        id: "evaluation-2",
        useCase: "data-analysis",
        elapsedMs: 0,
        checklist: { passed: 2, total: 1, items: [] },
        materialClaimTraceability: { traceable: 0, total: 0 },
        seededErrors: { caughtIds: ["same"], missedIds: ["same"] },
        openQuestionIds: [],
        reviewerCorrections: [],
        usage,
        verificationStatus: "passed",
      }).success,
    ).toBe(false);

    const approval = {
      deliverableId: "report-1",
      deliverableVersion: 3,
    };
    expect(isApprovalCurrent(approval, { id: "report-1", version: 3 })).toBe(
      true,
    );
    expect(isApprovalCurrent(approval, { id: "report-1", version: 4 })).toBe(
      false,
    );
  });

  it("provides schema-validated figures and checklists for all sample workflows", () => {
    expect(syntheticWorkflowFixtures.dataAnalysis.expected.totalRevenue).toBe(
      1000,
    );
    expect(syntheticWorkflowFixtures.taxNotice.expected.incomeDifference).toBe(
      150_000,
    );
    expect(syntheticWorkflowFixtures.msmePayment.expected.outstanding).toBe(
      90_000,
    );
    expect(
      Object.values(syntheticWorkflowFixtures).every(
        (fixture) =>
          fixture.case.isSample &&
          fixture.case.synthetic &&
          fixture.documents.length > 0 &&
          fixture.checklist.length > 0,
      ),
    ).toBe(true);

    const invalidFixture = {
      ...syntheticWorkflowFixtures.dataAnalysis,
      documents: [
        {
          ...syntheticWorkflowFixtures.dataAnalysis.documents[0],
          caseId: "another-case",
        },
      ],
    };
    expect(
      SyntheticWorkflowFixtureSchema.safeParse(invalidFixture).success,
    ).toBe(false);
  });
});
