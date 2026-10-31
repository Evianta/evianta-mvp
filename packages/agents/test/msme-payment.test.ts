import { createAi, MockProvider } from "@evianta/ai";
import { EvidenceSchema, syntheticWorkflowFixtures } from "@evianta/core";
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

function testAi(): AgentContext["ai"] {
  return createAi({
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
}

function sourceFinding(
  label: string,
  value: number | null,
  documentId: string,
  withEvidence = true,
) {
  return {
    taskId: "analysis-task",
    role: MSME_DOCUMENT_ANALYSIS_ROLE,
    findingId: `finding-${documentId}`,
    title: label,
    description: `${label} extracted from source.`,
    severity: "medium",
    evidenceIds: withEvidence ? [`evidence-${documentId}`] : [],
    sourceEvidence: withEvidence
      ? [
          {
            kind: "document" as const,
            sourceRef: `${documentId}#page=1`,
            confidence: "high" as const,
            documentId,
            location: { page: 1, textQuote: label },
          },
        ]
      : [],
    claims: [{ label, value, components: null, date: null }],
  };
}

function reconciliationInput(
  priorFindings: ReturnType<typeof sourceFinding>[],
) {
  return {
    case: {
      title: "Synthetic delayed-payment case",
      description: "Reconcile invoices and payments.",
      useCase: "msme-payment" as const,
    },
    task: {
      id: "payment-task",
      key: "payment-reconciliation",
      role: MSME_PAYMENT_RECONCILIATION_ROLE,
      instructions: "Reconcile confirmed invoice and payment amounts.",
    },
    priorFindings,
    documents: [],
    humanInput: null,
  };
}

function reconciler() {
  const specialist = createMsmePaymentSpecialists().find(
    (agent) => agent.role === MSME_PAYMENT_RECONCILIATION_ROLE,
  );
  if (!specialist) throw new Error("Payment reconciler was not registered");
  return specialist;
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

  it("calculates outstanding balance from per-record source claims deterministically", async () => {
    const ai = testAi();
    const input = reconciliationInput([
      sourceFinding("invoice amount: INV-1", 100_000, "invoice-1"),
      sourceFinding("invoice amount: INV-2", 50_000, "invoice-2"),
      sourceFinding("payment amount: PAY-1", 60_000, "payment-1"),
    ]);
    const specialist = reconciler();

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
    expect(finding?.evidence).toHaveLength(3);
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

  it("counts distinct invoices with equal amounts and ignores duplicate extractions", async () => {
    const result = await reconciler().run(
      reconciliationInput([
        sourceFinding("invoice amount: INV-1", 100, "invoice-1"),
        sourceFinding("invoice amount: INV-2", 100, "invoice-2"),
        sourceFinding("invoice amount: inv-2", 100, "invoice-2-copy"),
        sourceFinding("payment amount: PAY-1", 50, "payment-1"),
      ]),
      contextFor(testAi(), "payment-task"),
    );

    expect(result.output.findings[0]?.claims).toEqual([
      {
        label: "outstanding balance",
        value: 150,
        components: [200, -50],
        date: null,
      },
    ]);
  });

  it.each([
    [
      "an invoice amount is unreadable",
      [
        sourceFinding("invoice amount: INV-1", 100, "invoice-1"),
        sourceFinding("invoice amount: INV-2", null, "invoice-2"),
        sourceFinding("payment amount: PAY-1", 50, "payment-1"),
      ],
      "INV-2",
    ],
    [
      "one record has conflicting amounts",
      [
        sourceFinding("invoice amount: INV-1", 100, "invoice-1"),
        sourceFinding("invoice amount: INV-1", 200, "invoice-1-copy"),
        sourceFinding("payment amount: PAY-1", 50, "payment-1"),
      ],
      "conflicting",
    ],
    [
      "an amount has no document evidence",
      [
        sourceFinding("invoice amount: INV-1", 100, "invoice-1", false),
        sourceFinding("payment amount: PAY-1", 50, "payment-1"),
      ],
      "no source-linked evidence",
    ],
    [
      "payment records are absent",
      [sourceFinding("invoice amount: INV-1", 100, "invoice-1")],
      "No source-linked payment records",
    ],
  ])("refuses to calculate when %s", async (_name, findings, reason) => {
    const result = await reconciler().run(
      reconciliationInput(findings),
      contextFor(testAi(), "payment-task"),
    );
    const finding = result.output.findings[0];

    expect(finding).toMatchObject({
      title: "Outstanding balance cannot yet be calculated",
      claims: [],
      openQuestions: [{ severity: "high" }],
    });
    expect(finding?.description).toContain(reason);
  });

  it("persists provider citations that arrive without a claim", async () => {
    const citation = {
      url: "https://samadhaan.msme.gov.in/",
      title: "MSME Samadhaan",
    };
    const context = contextFor(
      {
        runStructured: async () => ({
          output: {
            summary: "Official guidance",
            sources: [{ url: citation.url, claim: "Describes the portal." }],
          },
          citations: [citation, { url: "not a url", title: "Broken" }],
          usage: { input: 1, output: 1, total: 2 },
          cost: { status: "estimated", costUsd: 0 },
          provider: "muse",
          model: "test",
        }),
      } as unknown as AgentContext["ai"],
      "legal-research-task",
    );
    const specialist = createMsmePaymentSpecialists().find(
      (agent) => agent.role === MSME_LEGAL_RESEARCH_ROLE,
    );
    if (!specialist)
      throw new Error("MSME legal researcher was not registered");

    const result = await specialist.run(
      {
        case: {
          title: "Synthetic delayed-payment case",
          description: "Reconcile invoices and payments.",
          useCase: "msme-payment",
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
      },
      context,
    );
    const evidence = result.output.findings[0]!.evidence;

    expect(evidence).toHaveLength(1);
    const persisted = EvidenceSchema.safeParse({
      kind: "research",
      id: "evidence-1",
      caseId: "case-1",
      sourceRef: evidence[0]!.sourceRef,
      confidence: evidence[0]!.confidence,
      citation: {
        url: evidence[0]!.url,
        title: evidence[0]!.title,
        retrievedAt: "2026-10-31T21:30:00.000Z",
        claim: evidence[0]!.claim,
        span: evidence[0]!.textQuote,
      },
    });
    expect(persisted.success).toBe(true);
    expect(evidence[0]!.claim).toBe("Describes the portal.");
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
