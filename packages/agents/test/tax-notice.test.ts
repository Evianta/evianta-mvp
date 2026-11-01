import { createAi, MockProvider } from "@evianta/ai";
import { syntheticWorkflowFixtures } from "@evianta/core";
import { describe, expect, it, vi } from "vitest";
import {
  createTaxNoticePlan,
  createTaxNoticeSpecialists,
  runDeterministicChecks,
  TAX_NOTICE_ANALYST_ROLE,
  TAX_RECONCILIATION_ROLE,
  TAX_RESEARCH_ROLE,
  TAX_RESPONSE_DRAFTER_ROLE,
} from "../src/index.js";
import type { AgentContext } from "../src/agent.js";
import type { PriorFinding } from "../src/contracts.js";

describe("tax notice workflow", () => {
  it("defines the complete response-pack task dependency graph", () => {
    const plan = createTaxNoticePlan();
    expect(plan).toMatchObject({
      useCase: "tax-notice",
      format: "document",
      tasks: [
        { key: "case-analysis", role: TAX_NOTICE_ANALYST_ROLE, dependsOn: [] },
        {
          key: "reconciliation",
          role: TAX_RECONCILIATION_ROLE,
          dependsOn: ["case-analysis"],
        },
        {
          key: "tax-research",
          role: TAX_RESEARCH_ROLE,
          dependsOn: ["case-analysis"],
        },
        {
          key: "response-preparation",
          role: TAX_RESPONSE_DRAFTER_ROLE,
          dependsOn: ["reconciliation", "tax-research"],
        },
        {
          key: "independent-review",
          role: "independent-reviewer",
          dependsOn: ["response-preparation"],
        },
      ],
    });
    expect(createTaxNoticeSpecialists().map((agent) => agent.role)).toEqual([
      TAX_NOTICE_ANALYST_ROLE,
      TAX_RECONCILIATION_ROLE,
      TAX_RESEARCH_ROLE,
      TAX_RESPONSE_DRAFTER_ROLE,
    ]);
  });

  it("surfaces search unavailability as a professional-verification question", async () => {
    const ai = createAi({
      provider: new MockProvider({ responses: [] }),
      accounting: {
        mode: "test",
        admit: async () => undefined,
        record: async () => undefined,
        cancel: async () => undefined,
      },
      models: {
        provider: "mock",
        sparkModel: "mock-spark",
        wonderModel: "mock-wonder",
        capabilitiesByTier: { mid: ["structured-json"] },
      },
    });
    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
    const context: AgentContext = {
      ownerId: "tax-owner",
      case: syntheticWorkflowFixtures.taxNotice.case,
      runId: "tax-run",
      taskId: "tax-research-task",
      documents: {
        listAsync: async () => [],
        tablesAsync: async () => [],
        sliceAsync: async () => null,
      },
      logger,
      signal: new AbortController().signal,
      usage: {
        userId: "tax-owner",
        caseId: syntheticWorkflowFixtures.taxNotice.case.id,
        runId: "tax-run",
        leaseId: "tax-lease",
        fencingToken: 1,
      },
      ai,
    };
    const input = {
      case: {
        title: "Synthetic tax notice",
        description: "Reconcile a notice with return figures.",
        useCase: "tax-notice" as const,
      },
      task: {
        id: "tax-research-task",
        key: "tax-research",
        role: TAX_RESEARCH_ROLE,
        instructions: "Research relevant tax guidance.",
      },
      priorFindings: [],
      documents: [],
      humanInput: null,
    };

    const agent = createTaxNoticeSpecialists().find(
      (specialist) => specialist.role === TAX_RESEARCH_ROLE,
    );
    if (!agent) throw new Error("Tax research agent was not registered");
    const result = await agent.run(input, context);

    expect(result.output.findings[0]).toMatchObject({
      title: "Legal research requires professional verification",
      evidence: [],
      openQuestions: [{ severity: "high" }],
    });
    expect(logger.warn).toHaveBeenCalledWith(
      "Tax research search is unavailable",
      { code: "unsupported-capability" },
    );
    expect(result.usage).toEqual({ input: 0, output: 0, total: 0 });
  });

  it.each([
    "supported",
    "missing evidence",
    "research evidence only",
    "missing location",
    "unassessed evidence",
    "low confidence",
    "medium confidence",
    "unresolved extraction",
    "resolved extraction",
    "conflicting figures",
    "matching unsupported figures",
  ])("reconciles only traceable figures: %s", async (scenario) => {
    const ai = createAi({
      provider: new MockProvider({ responses: [] }),
      accounting: {
        mode: "test",
        admit: async () => undefined,
        record: async () => undefined,
        cancel: async () => undefined,
      },
      models: {
        provider: "mock",
        sparkModel: "mock-spark",
        wonderModel: "mock-wonder",
      },
    });
    const context: AgentContext = {
      ownerId: "tax-owner",
      case: syntheticWorkflowFixtures.taxNotice.case,
      runId: "tax-run",
      taskId: "tax-reconciliation-task",
      documents: {
        listAsync: async () => [],
        tablesAsync: async () => [],
        sliceAsync: async () => null,
      },
      logger: {
        info: () => undefined,
        warn: () => undefined,
        error: () => undefined,
      },
      signal: new AbortController().signal,
      usage: {
        userId: "tax-owner",
        caseId: syntheticWorkflowFixtures.taxNotice.case.id,
        runId: "tax-run",
        leaseId: "tax-lease",
        fencingToken: 1,
      },
      ai,
    };
    const sourceFinding = (
      label: string,
      value: number,
      documentId: string,
    ): PriorFinding => ({
      taskId: "analysis-task",
      role: TAX_NOTICE_ANALYST_ROLE,
      findingId: `finding-${label.replaceAll(" ", "-")}`,
      title: label,
      description: `${label} extracted from source.`,
      severity: "medium",
      confidence: 0.8,
      evidenceIds: [`evidence-${documentId}`],
      sourceEvidence: [
        {
          kind: "document" as const,
          sourceRef: `${documentId}#page=1`,
          confidence: "high" as const,
          documentId,
          location: { page: 1, textQuote: label },
        },
      ],
      claims: [{ label, value, components: null, date: null }],
    });
    const input = {
      case: {
        title: "Synthetic tax notice",
        description: "Reconcile a notice with return figures.",
        useCase: "tax-notice" as const,
      },
      task: {
        id: "tax-reconciliation-task",
        key: "reconciliation",
        role: TAX_RECONCILIATION_ROLE,
        instructions: "Reconcile figures.",
      },
      priorFindings: [
        sourceFinding("return income", 1_200_000, "return-document"),
        sourceFinding("notice income", 1_350_000, "notice-document"),
        sourceFinding("claimed credit", 80_000, "return-document"),
        sourceFinding("available credit", 75_000, "credit-document"),
      ],
      documents: [],
      humanInput: null,
    };
    const returnedIncome = input.priorFindings[0]!;
    if (
      scenario === "missing evidence" ||
      scenario === "matching unsupported figures"
    ) {
      returnedIncome.sourceEvidence = [];
    }
    if (scenario === "research evidence only") {
      returnedIncome.sourceEvidence = [
        {
          kind: "research",
          sourceRef: "https://www.incometax.gov.in/",
          confidence: "high",
          documentId: null,
        },
      ];
    }
    if (scenario === "low confidence" || scenario === "medium confidence") {
      returnedIncome.sourceEvidence![0]!.confidence =
        scenario === "low confidence" ? "low" : "medium";
    }
    if (scenario === "missing location") {
      delete returnedIncome.sourceEvidence![0]!.location;
    }
    if (scenario === "unassessed evidence") {
      returnedIncome.sourceEvidence![0]!.confidence = "unassessed";
    }
    if (
      scenario === "unresolved extraction" ||
      scenario === "resolved extraction"
    ) {
      returnedIncome.openQuestions = [
        {
          id: "extraction-question",
          text: "Confirm the extracted return income.",
          severity: "high",
          status: scenario === "resolved extraction" ? "resolved" : "open",
          resolutionNote: null,
          actorId: null,
          updatedAt: null,
        },
      ];
    }
    if (scenario === "conflicting figures") {
      input.priorFindings.push(
        sourceFinding("return income", 1_100_000, "other-return"),
      );
    }
    if (scenario === "matching unsupported figures") {
      input.priorFindings[1]!.claims[0]!.value = 1_200_000;
    }
    const agent = createTaxNoticeSpecialists().find(
      (specialist) => specialist.role === TAX_RECONCILIATION_ROLE,
    );
    if (!agent) throw new Error("Tax reconciliation agent was not registered");

    const result = await agent.run(input, context);
    if (
      scenario !== "supported" &&
      scenario !== "medium confidence" &&
      scenario !== "resolved extraction"
    ) {
      expect(result.output.findings[0]).toMatchObject({
        title: "Income reconciliation incomplete",
        claims: [],
        openQuestions: [{ severity: "high" }],
      });
      expect(result.output.findings[1]?.claims[0]?.value).toBe(-5_000);
      return;
    }
    expect(
      result.output.findings.map((finding) => finding.claims[0]?.value),
    ).toEqual([150_000, -5_000]);
    expect(result.output.findings[0]?.evidence).toHaveLength(2);
    expect(result.output.findings[0]?.confidence).toBe(
      scenario === "medium confidence" ? 0.7 : 0.8,
    );
    expect(
      runDeterministicChecks(
        result.output.findings.map((finding, index) => ({
          id: `finding-${index}`,
          taskId: "tax-reconciliation-task",
          title: finding.title,
          severity: finding.severity,
          evidenceIds: finding.evidence.map(
            (_, evidenceIndex) => `e${evidenceIndex}`,
          ),
          claims: finding.claims,
        })),
      ).passed,
    ).toBe(true);
    expect(result.usage).toEqual({ input: 0, output: 0, total: 0 });
  });
});
