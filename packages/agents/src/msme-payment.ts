import { AiError } from "@evianta/ai";
import type { AgentProfile, UsageUnits } from "@evianta/core";
import { z } from "zod";
import type { AgentResult } from "./agent.js";
import {
  SpecialistInputSchema,
  SpecialistModelOutputSchema,
  SpecialistOutputSchema,
  type EvidenceDraft,
  type PriorFinding,
  type SpecialistInput,
  type SpecialistOutput,
} from "./contracts.js";
import {
  createSpecialistAgent,
  REVIEWER_ROLE,
  type SpecialistAgent,
} from "./roles.js";
import type { ReferencePlan } from "./planning.js";

export const MSME_DOCUMENT_ANALYSIS_ROLE = "msme-document-analysis";
export const MSME_PAYMENT_RECONCILIATION_ROLE = "msme-payment-reconciliation";
export const MSME_EVIDENCE_ANALYSIS_ROLE = "msme-evidence-analysis";
export const MSME_LEGAL_RESEARCH_ROLE = "msme-legal-research";
export const MSME_CASE_PREPARATION_ROLE = "msme-case-preparation";

const profile = (
  id: string,
  role: string,
  displayName: string,
  specialty: string,
  summary: string,
  capabilities: string[],
  modelTier: AgentProfile["modelTier"],
): AgentProfile => ({
  id,
  role,
  displayName,
  specialty,
  summary,
  capabilities,
  tools: role === MSME_LEGAL_RESEARCH_ROLE ? ["web-search"] : [],
  procedures: [
    "Use only supplied evidence and clearly identify missing information",
    "Do not make legal determinations or initiate an escalation",
  ],
  outputFormats: ["evidence-linked findings"],
  limitations: [
    "Legal routes and deadlines require review by a qualified professional",
  ],
  modelTier,
  enabled: true,
});

export const msmeDocumentAnalysisProfile = profile(
  "agent-msme-document-analysis",
  MSME_DOCUMENT_ANALYSIS_ROLE,
  "MSME Document Analyst",
  "Invoice and correspondence analysis",
  "Extracts invoice, payment, delivery, agreement, and correspondence details with source references.",
  [
    "Extract dates and figures",
    "Link records to source evidence",
    "Flag uncertain extraction",
  ],
  "cheap",
);

export const msmePaymentReconciliationProfile = profile(
  "agent-msme-payment-reconciliation",
  MSME_PAYMENT_RECONCILIATION_ROLE,
  "Payment Reconciliation Specialist",
  "Invoice and payment reconciliation",
  "Calculates outstanding amounts from confirmed invoice and payment totals.",
  [
    "Reconcile invoice totals",
    "Account for partial payments",
    "Surface unmatched records",
  ],
  "mid",
);

export const msmeEvidenceAnalysisProfile = profile(
  "agent-msme-evidence-analysis",
  MSME_EVIDENCE_ANALYSIS_ROLE,
  "MSME Evidence Analyst",
  "Chronology and evidence gaps",
  "Builds a source-linked chronology and identifies missing or disputed evidence.",
  [
    "Prepare source-linked chronology",
    "Identify missing documents",
    "Flag disputes",
  ],
  "mid",
);

export const msmeLegalResearchProfile = profile(
  "agent-msme-legal-research",
  MSME_LEGAL_RESEARCH_ROLE,
  "MSME Legal Research Specialist",
  "General legal research",
  "Finds general official guidance when provider search is available and flags applicability for verification.",
  [
    "Search general official guidance",
    "Preserve source citations",
    "Flag unverified applicability",
  ],
  "mid",
);

export const msmeCasePreparationProfile = profile(
  "agent-msme-case-preparation",
  MSME_CASE_PREPARATION_ROLE,
  "MSME Case Pack Preparer",
  "Case-pack preparation",
  "Assembles a source-linked payment summary and proposed follow-up draft for review.",
  [
    "Prepare a payment summary",
    "Draft follow-up materials",
    "Surface open questions",
  ],
  "mid",
);

export const msmePaymentProfiles = [
  msmeDocumentAnalysisProfile,
  msmePaymentReconciliationProfile,
  msmeEvidenceAnalysisProfile,
  msmeLegalResearchProfile,
  msmeCasePreparationProfile,
] as const;

export function createMsmePaymentPlan(): ReferencePlan {
  return {
    useCase: "msme-payment",
    version: 1,
    title: "MSME delayed-payment case pack",
    format: "document",
    tasks: [
      {
        key: "document-analysis",
        role: MSME_DOCUMENT_ANALYSIS_ROLE,
        title: "Document analysis",
        dependsOn: [],
        required: true,
        instructions:
          "Organize invoices, payments, agreements, delivery records, and correspondence. Extract dates and figures with source locations and confidence; flag uncertainty.",
      },
      {
        key: "payment-reconciliation",
        role: MSME_PAYMENT_RECONCILIATION_ROLE,
        title: "Payment reconciliation",
        dependsOn: ["document-analysis"],
        required: true,
        instructions:
          "Use the exact claim labels 'invoice total' and 'payments total' from source-linked findings. Compute outstanding as invoice total minus payments total, accounting for partial payments and unmatched records.",
      },
      {
        key: "evidence-analysis",
        role: MSME_EVIDENCE_ANALYSIS_ROLE,
        title: "Chronology and evidence gaps",
        dependsOn: ["document-analysis", "payment-reconciliation"],
        required: true,
        instructions:
          "Build a chronology from the supplied source-linked findings. Identify missing delivery or acceptance records, inconsistent dates, unmatched payments, and disputed invoices.",
      },
      {
        key: "legal-research",
        role: MSME_LEGAL_RESEARCH_ROLE,
        title: "Research for professional verification",
        dependsOn: ["evidence-analysis"],
        required: true,
        instructions:
          "Find general official MSME delayed-payment guidance using provider web search when available. Preserve source citations and never assert a legal route applies without professional verification.",
      },
      {
        key: "case-preparation",
        role: MSME_CASE_PREPARATION_ROLE,
        title: "Payment case pack and draft",
        dependsOn: [
          "payment-reconciliation",
          "evidence-analysis",
          "legal-research",
        ],
        required: true,
        instructions:
          "Assemble the payment summary, chronology, evidence gaps, and a proposed follow-up draft. Cite material assertions and do not send or escalate it.",
      },
      {
        key: "independent-review",
        role: REVIEWER_ROLE,
        title: "Independent review",
        dependsOn: ["case-preparation"],
        required: true,
        instructions:
          "Review arithmetic, source evidence, disputed items, and unresolved questions. Do not approve or initiate an escalation.",
      },
    ],
  };
}

const zeroUsage: UsageUnits = { input: 0, output: 0, total: 0 };
const researchResultSchema = z.object({ summary: z.string() });
const researchQuery =
  "Find current official Indian government guidance on delayed payments to micro and small enterprises, including official routes for seeking assistance. Return only verifiable official sources; do not infer facts about a supplier or transaction.";

function canonicalClaim(
  findings: readonly PriorFinding[],
  label: string,
): { value: number; sources: PriorFinding[] } | null {
  const matches = findings.filter((finding) =>
    finding.claims.some(
      (claim) =>
        claim.label.trim().toLowerCase() === label &&
        claim.value !== null &&
        Number.isFinite(claim.value),
    ),
  );
  const values = new Set(
    matches.flatMap((finding) =>
      finding.claims
        .filter(
          (claim) =>
            claim.label.trim().toLowerCase() === label &&
            claim.value !== null &&
            Number.isFinite(claim.value),
        )
        .map((claim) => claim.value!),
    ),
  );
  if (values.size !== 1) return null;
  return { value: [...values][0]!, sources: matches };
}

function sourceEvidenceDrafts(
  findings: readonly PriorFinding[],
): EvidenceDraft[] {
  const bySourceRef = new Map<string, EvidenceDraft>();
  for (const finding of findings) {
    for (const source of finding.sourceEvidence ?? []) {
      const evidence: EvidenceDraft =
        source.kind === "document"
          ? {
              kind: "document",
              sourceRef: source.sourceRef,
              confidence: source.confidence,
              documentId: source.documentId,
              page: source.location?.page ?? null,
              ...(source.location ? { location: source.location } : {}),
              textQuote: source.location?.textQuote ?? null,
              url: null,
              title: null,
              claim: null,
            }
          : {
              kind: "research",
              sourceRef: source.sourceRef,
              confidence: source.confidence,
              documentId: null,
              page: null,
              textQuote: source.citation?.span ?? null,
              url: source.citation?.url ?? null,
              title: source.citation?.title ?? null,
              claim: source.citation?.claim ?? null,
            };
      bySourceRef.set(evidence.sourceRef, evidence);
    }
  }
  return [...bySourceRef.values()];
}

function formatAmount(value: number): string {
  return `INR ${new Intl.NumberFormat("en-IN", {
    maximumFractionDigits: 2,
  }).format(value)}`;
}

function paymentReconciliationFinding(
  invoiceTotal: ReturnType<typeof canonicalClaim>,
  paymentsTotal: ReturnType<typeof canonicalClaim>,
): SpecialistOutput["findings"][number] {
  if (!invoiceTotal || !paymentsTotal) {
    const sources = [invoiceTotal, paymentsTotal].flatMap(
      (source) => source?.sources ?? [],
    );
    return {
      title: "Outstanding balance cannot yet be calculated",
      description:
        "Both source-linked invoice and payment totals are required before calculating an outstanding balance.",
      severity: "low",
      confidence: 1,
      evidence: sourceEvidenceDrafts(sources),
      assumptions: [],
      openQuestions: [
        {
          text: "Provide or confirm the invoice total and the payments recorded against those invoices.",
          severity: "high",
        },
      ],
      claims: [],
    };
  }
  const outstanding = invoiceTotal.value - paymentsTotal.value;
  const evidence = sourceEvidenceDrafts([
    ...invoiceTotal.sources,
    ...paymentsTotal.sources,
  ]);
  return {
    title: "Outstanding payment balance",
    description: `Confirmed invoice total is ${formatAmount(invoiceTotal.value)} and confirmed payments total is ${formatAmount(paymentsTotal.value)}. Outstanding balance (invoice total minus payments total) is ${formatAmount(outstanding)}.`,
    severity: outstanding > 0 ? "medium" : "info",
    confidence: 1,
    evidence,
    assumptions: [],
    openQuestions:
      evidence.length < 2
        ? [
            {
              text: "Confirm the invoice and payment totals against their original records before relying on this balance.",
              severity: "high",
            },
          ]
        : [],
    claims: [
      {
        label: "outstanding balance",
        value: outstanding,
        components: [invoiceTotal.value, -paymentsTotal.value],
        date: null,
      },
    ],
  };
}

function createMsmePaymentReconciliationAgent(): SpecialistAgent {
  const agentProfile = msmePaymentReconciliationProfile;
  return {
    role: MSME_PAYMENT_RECONCILIATION_ROLE,
    modelTier: agentProfile.modelTier,
    systemPrompt:
      "Deterministically calculate the outstanding balance from canonical source figures. Never estimate or infer a missing or ambiguous amount.",
    inputSchema: SpecialistInputSchema,
    outputSchema: SpecialistModelOutputSchema,
    profile: agentProfile,
    async run(input: SpecialistInput): Promise<AgentResult<SpecialistOutput>> {
      const finding = paymentReconciliationFinding(
        canonicalClaim(input.priorFindings, "invoice total"),
        canonicalClaim(input.priorFindings, "payments total"),
      );
      const output = SpecialistOutputSchema.parse({
        summary:
          "The outstanding balance is calculated from confirmed invoice and payment totals.",
        findings: [finding],
        inputRequired: null,
      });
      return {
        output,
        usage: zeroUsage,
        cost: { status: "estimated", costUsd: 0 },
        citations: [],
        provider: null,
        model: null,
        modelTier: agentProfile.modelTier,
      };
    },
  };
}

function unavailableResearch(): SpecialistOutput {
  return SpecialistOutputSchema.parse({
    summary:
      "No legal research sources were verified. No legal route or deadline is asserted.",
    findings: [
      {
        title: "Legal research requires professional verification",
        description:
          "Provider web search was unavailable or returned no citations. Verify current requirements and available routes with a qualified professional before taking action.",
        severity: "info",
        confidence: 1,
        evidence: [],
        assumptions: [],
        openQuestions: [
          {
            text: "Which current statutory or contractual routes, if any, apply to these records?",
            severity: "high",
          },
        ],
        claims: [],
      },
    ],
    inputRequired: null,
  });
}

function isUnavailableSearch(error: unknown): error is AiError {
  return (
    error instanceof AiError &&
    (error.code === "unsupported-capability" ||
      error.code === "unbounded-usage-capability" ||
      (error.code === "usage-admission-rejected" &&
        error.message ===
          "No price is configured for the requested web-search capability"))
  );
}

function createMsmeLegalResearchAgent(): SpecialistAgent {
  const agentProfile = msmeLegalResearchProfile;
  const systemPrompt = [
    "You are a legal research assistant preparing general guidance for a qualified professional.",
    "Search only for authoritative official sources. Do not make a legal determination or assert that a route applies to this supplier.",
    "The query is deliberately generic and contains no case or personal data.",
    "Citations are captured separately from provider search results.",
  ].join("\n");
  return {
    role: MSME_LEGAL_RESEARCH_ROLE,
    modelTier: agentProfile.modelTier,
    systemPrompt,
    inputSchema: SpecialistInputSchema,
    outputSchema: SpecialistModelOutputSchema,
    profile: agentProfile,
    async run(_input: SpecialistInput, context) {
      try {
        const result = await context.ai.runStructured({
          tier: agentProfile.modelTier,
          inputSchema: z.string(),
          outputSchema: researchResultSchema,
          system: systemPrompt,
          input: researchQuery,
          usageContext: {
            ...context.usage,
            taskId: context.taskId ?? undefined,
          },
          signal: context.signal,
          webSearch: true,
        });
        const output = result.citations.length
          ? SpecialistOutputSchema.parse({
              summary:
                "General official sources were found; applicability requires professional verification.",
              findings: [
                {
                  title: "Official sources for professional verification",
                  description:
                    "Confirm that each result is current and applies to the specific enterprise, transaction, and jurisdiction.",
                  severity: "medium",
                  confidence: 1,
                  evidence: result.citations.map((citation) => ({
                    kind: "research",
                    sourceRef: citation.url,
                    confidence: "medium",
                    documentId: null,
                    page: null,
                    textQuote: citation.span ?? null,
                    url: citation.url,
                    title: citation.title,
                    claim: citation.claim ?? null,
                  })),
                  assumptions: [],
                  openQuestions: [
                    {
                      text: "Has a qualified professional confirmed the currency and applicability of these sources?",
                      severity: "high",
                    },
                  ],
                  claims: [],
                },
              ],
              inputRequired: null,
            })
          : unavailableResearch();
        return {
          output,
          usage: result.usage,
          cost: { status: result.cost.status, costUsd: result.cost.costUsd },
          citations: result.citations,
          provider: result.provider,
          model: result.model,
          modelTier: agentProfile.modelTier,
        };
      } catch (error) {
        if (!isUnavailableSearch(error)) throw error;
        context.logger.warn("MSME legal research search is unavailable", {
          code: error.code,
        });
        return {
          output: unavailableResearch(),
          usage: zeroUsage,
          cost: { status: "estimated", costUsd: 0 },
          citations: [],
          provider: null,
          model: null,
          modelTier: agentProfile.modelTier,
        };
      }
    },
  };
}

export function createMsmePaymentSpecialists(): SpecialistAgent[] {
  return [
    createSpecialistAgent(
      msmeDocumentAnalysisProfile,
      [
        "You organize records for a delayed-payment case pack.",
        "Use only supplied document slices and prior findings.",
        "For figures, use one source-linked claim per source record with the exact labels 'invoice total' or 'payments total'.",
        "Cite the document ID and page or cell for every material item.",
        "Flag uncertain extraction, partial payments, unmatched records, and disputed invoices.",
      ].join("\n"),
    ),
    createMsmePaymentReconciliationAgent(),
    createSpecialistAgent(
      msmeEvidenceAnalysisProfile,
      [
        "You build a source-linked chronology and identify evidence gaps.",
        "Use only supplied document slices and prior findings.",
        "Cite a source location for each chronology event and flag disputed or unmatched items.",
        "Do not infer delivery, acceptance, or payment from missing records.",
      ].join("\n"),
    ),
    createMsmeLegalResearchAgent(),
    createSpecialistAgent(
      msmeCasePreparationProfile,
      [
        "You assemble a payment case pack and proposed follow-up draft for the business owner or adviser.",
        "Use only supplied findings and source evidence; cite material assertions.",
        "Clearly label assumptions, evidence gaps, disputes, and legal points requiring current-law verification.",
        "Do not send communications or initiate an escalation.",
      ].join("\n"),
    ),
  ];
}
