import { createAi, MockProvider } from "@evianta/ai";
import { syntheticWorkflowFixtures } from "@evianta/core";
import { describe, expect, it, vi } from "vitest";
import type { AgentContext } from "../src/agent.js";
import {
  createMsmePaymentPlan,
  createMsmePaymentSpecialists,
  runDeterministicChecks,
  MSME_DOCUMENT_ANALYSIS_ROLE,
  MSME_LEGAL_RESEARCH_ROLE,
  MSME_PAYMENT_RECONCILIATION_ROLE,
} from "../src/index.js";

function contextFor(ai: AgentContext["ai"], taskId: string): AgentContext {
  const caseRecord = syntheticWorkflowFixtures.msmePayment.case;
  return {
    ownerId: "msme-owner",
    case: caseRecord,
    runId: "msme-run",
    taskId,
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
      userId: "msme-owner",
      caseId: caseRecord.id,
      runId: "msme-run",
      leaseId: "msme-lease",
      fencingToken: 1,
    },
    ai,
  };
}

describe("MSME payment workflow", () => {
  it("defines the six-task case-pack dependency graph", () => {
    expect(createMsmePaymentPlan()).toMatchObject({
      useCase: "msme-payment",
      format: "document",
      tasks: [
        { key: "document-analysis", role: MSME_DOCUMENT_ANALYSIS_ROLE },
        {
          key: "payment-reconciliation",
          role: MSME_PAYMENT_RECONCILIATION_ROLE,
          dependsOn: ["document-analysis"],
        },
        {
          key: "evidence-analysis",
          dependsOn: ["document-analysis", "payment-reconciliation"],
        },
        {
          key: "legal-research",
          role: MSME_LEGAL_RESEARCH_ROLE,
          dependsOn: ["evidence-analysis"],
        },
        {
          key: "case-preparation",
          dependsOn: [
            "payment-reconciliation",
            "evidence-analysis",
            "legal-research",
          ],
        },
        {
          key: "independent-review",
          role: "independent-reviewer",
          dependsOn: ["case-preparation"],
        },
      ],
    });
  });

  it("calculates outstanding balance from source claims deterministically", async () => {
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
    const sourceFinding = (
      label: string,
      value: number,
      documentId: string,
    ) => ({
      taskId: "analysis-task",
      role: MSME_DOCUMENT_ANALYSIS_ROLE,
      findingId: `finding-${label.replaceAll(" ", "-")}`,
      title: label,
      description: `${label} extracted from source.`,
      severity: "medium",
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
        title: "Synthetic delayed-payment case",
        description: "Reconcile invoices and payments.",
        useCase: "msme-payment" as const,
      },
      task: {
        id: "payment-task",
        key: "payment-reconciliation",
        role: MSME_PAYMENT_RECONCILIATION_ROLE,
        instructions: "Reconcile confirmed invoice and payment totals.",
      },
      priorFindings: [
        sourceFinding("invoice total", 150_000, "invoice-records"),
        sourceFinding("payments total", 60_000, "payment-records"),
      ],
      documents: [],
      humanInput: null,
    };
    const specialist = createMsmePaymentSpecialists().find(
      (agent) => agent.role === MSME_PAYMENT_RECONCILIATION_ROLE,
    );
    if (!specialist) throw new Error("Payment reconciler was not registered");

    const result = await specialist.run(input, contextFor(ai, "payment-task"));
    const finding = result.output.findings[0];
    expect(finding?.claims).toEqual([
      {
        label: "outstanding balance",
        value: syntheticWorkflowFixtures.msmePayment.expected.outstanding,
        components: [150_000, -60_000],
        date: null,
      },
    ]);
    expect(finding?.evidence).toHaveLength(2);
    expect(
      runDeterministicChecks([
        {
          id: "outstanding",
          taskId: "payment-task",
          title: finding!.title,
          severity: finding!.severity,
          evidenceIds: ["invoice-evidence", "payment-evidence"],
          claims: finding!.claims,
        },
      ]).passed,
    ).toBe(true);
    expect(result.usage).toEqual({ input: 0, output: 0, total: 0 });
  });

  it("flags legal research for professional verification when search is unavailable", async () => {
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
    const context = contextFor(ai, "legal-research-task");
    context.logger = logger;
    const input = {
      case: {
        title: "Synthetic delayed-payment case",
        description: "Reconcile invoices and payments.",
        useCase: "msme-payment" as const,
      },
      task: {
        id: "legal-research-task",
        key: "legal-research",
        role: MSME_LEGAL_RESEARCH_ROLE,
        instructions: "Research general official guidance.",
      },
      priorFindings: [],
      documents: [],
      humanInput: null,
    };
    const specialist = createMsmePaymentSpecialists().find(
      (agent) => agent.role === MSME_LEGAL_RESEARCH_ROLE,
    );
    if (!specialist)
      throw new Error("MSME legal researcher was not registered");

    const result = await specialist.run(input, context);

    expect(result.output.findings[0]).toMatchObject({
      title: "Legal research requires professional verification",
      evidence: [],
      openQuestions: [{ severity: "high" }],
    });
    expect(logger.warn).toHaveBeenCalledWith(
      "MSME legal research search is unavailable",
      { code: "unsupported-capability" },
    );
  });
});
