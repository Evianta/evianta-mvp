import { AiError, type Citation } from "@evianta/ai";
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
          "Use the exact claim labels 'invoice amount: <identifier>' and 'payment amount: <identifier>' from source-linked findings. Sum one amount per distinct record and compute outstanding as invoices minus payments, accounting for partial payments and unmatched records.",
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
const researchResultSchema = z.object({
  summary: z.string(),
  sources: z
    .array(z.object({ url: z.string(), claim: z.string() }))
    .describe("A short statement of what each cited official source says"),
});
const researchQuery =
  "Find current official Indian government guidance on delayed payments to micro and small enterprises, including official routes for seeking assistance. Return only verifiable official sources; do not infer facts about a supplier or transaction.";

type RecordKind = "invoice" | "payment";

interface RecordSet {
  total: number;
  count: number;
  sources: PriorFinding[];
  problems: string[];
}

const recordLabelPattern = /^(invoice|payment) amount\s*:\s*(.+)$/;

const roundMoney = (value: number) => Math.round(value * 100) / 100;

function hasReliableRecordEvidence(
  finding: PriorFinding,
  documentSources: NonNullable<PriorFinding["sourceEvidence"]>,
): boolean {
  if (
    (finding.confidence ?? 0.5) === 0 ||
    finding.openQuestions?.some(
      (question) => question.status === "open" && question.severity === "high",
    ) ||
    documentSources.length === 0
  ) {
    return false;
  }
  return documentSources.every((source) => {
    const extraction = source.extraction;
    return Boolean(
      source.documentId &&
        source.location &&
        extraction &&
        extraction.confidence >= 0.75 &&
        extraction.method !== "handwriting" &&
        !extraction.hasHandwriting &&
        extraction.warningCount === 0 &&
        extraction.minimumPageConfidence >= 0.75 &&
        (source.confidence === "high" || source.confidence === "medium"),
    );
  });
}

/**
 * Sums one amount per distinct record. A record is identified by the label
 * "<invoice|payment> amount: <identifier>", so repeated extractions of the same
 * record count once while distinct records with equal amounts both count.
 */
function collectRecords(
  findings: readonly PriorFinding[],
  kind: RecordKind,
): RecordSet {
  const records = new Map<
    string,
    {
      identifier: string;
      amounts: Set<number>;
      sources: Set<PriorFinding>;
      problems: Set<string>;
    }
  >();
  for (const finding of findings) {
    const documentSources = (finding.sourceEvidence ?? []).filter(
      (source) => source.kind === "document",
    );
    const recordClaims = finding.claims.flatMap((claim) => {
      const match = recordLabelPattern.exec(
        claim.label.trim().toLowerCase().replace(/\s+/g, " "),
      );
      return match ? [{ claim, match }] : [];
    });
    for (const { claim, match } of recordClaims) {
      if (match[1] !== kind) continue;
      const identifier = claim.label.slice(claim.label.indexOf(":") + 1).trim();
      const key = identifier.toLowerCase().replace(/\s+/g, " ");
      const record = records.get(key) ?? {
        identifier,
        amounts: new Set<number>(),
        sources: new Set<PriorFinding>(),
        problems: new Set<string>(),
      };
      if (claim.value !== null && Number.isFinite(claim.value)) {
        record.amounts.add(claim.value);
      } else {
        record.problems.add(
          `The amount of ${kind} "${identifier}" is missing or unreadable.`,
        );
      }
      if (recordClaims.length !== 1) {
        record.problems.add(
          `${kind} "${identifier}" is grouped with other record claims and cannot be individually sourced.`,
        );
      }
      if (!documentSources.length) {
        record.problems.add(
          `The amount of ${kind} "${identifier}" has no source-linked evidence.`,
        );
      } else if (!hasReliableRecordEvidence(finding, documentSources)) {
        record.problems.add(
          `The amount of ${kind} "${identifier}" has uncertain or unreliable source evidence.`,
        );
      }
      if (
        finding.openQuestions?.some(
          (question) =>
            question.status === "open" && question.severity === "high",
        )
      ) {
        record.problems.add(
          `${kind} "${identifier}" has an unresolved high-severity question.`,
        );
      }
      record.sources.add(finding);
      records.set(key, record);
    }
  }
  const problems: string[] = [];
  let total = 0;
  let count = 0;
  const sources = new Set<PriorFinding>();
  for (const record of records.values()) {
    const name = `${kind} "${record.identifier}"`;
    if (record.amounts.size === 0) {
      record.problems.add(`The amount of ${name} is missing or unreadable.`);
    }
    if (record.amounts.size > 1) {
      record.problems.add(
        `${name} has conflicting amounts (${[...record.amounts].join(", ")}).`,
      );
    }
    if (record.sources.size === 0) {
      record.problems.add(
        `The amount of ${name} has no source-linked evidence.`,
      );
    }
    if (record.problems.size) {
      problems.push(...record.problems);
      continue;
    }
    total += [...record.amounts][0]!;
    count += 1;
    for (const source of record.sources) sources.add(source);
  }
  return { total: roundMoney(total), count, sources: [...sources], problems };
}

function sourceEvidenceDrafts(
  findings: readonly PriorFinding[],
): EvidenceDraft[] {
  const byIdentity = new Map<string, EvidenceDraft>();
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
      byIdentity.set(JSON.stringify(evidence), evidence);
    }
  }
  return [...byIdentity.values()];
}

function formatAmount(value: number): string {
  return `INR ${new Intl.NumberFormat("en-IN", {
    maximumFractionDigits: 2,
  }).format(value)}`;
}

function paymentReconciliationFinding(
  invoices: RecordSet,
  payments: RecordSet,
): SpecialistOutput["findings"][number] {
  const problems = [...invoices.problems, ...payments.problems];
  if (!invoices.count) problems.push("No source-linked invoice records found.");
  if (!payments.count) problems.push("No source-linked payment records found.");
  const evidence = sourceEvidenceDrafts([
    ...invoices.sources,
    ...payments.sources,
  ]);
  if (problems.length) {
    return {
      title: "Outstanding balance cannot yet be calculated",
      description: `Every invoice and payment record needs one source-linked amount before a balance is calculated. ${problems.join(" ")}`,
      severity: "low",
      confidence: 1,
      evidence,
      assumptions: [],
      openQuestions: [
        {
          text: "Provide or confirm each invoice amount and the payments recorded against those invoices, resolving the listed record issues.",
          severity: "high",
        },
      ],
      claims: [],
    };
  }
  const outstanding = roundMoney(invoices.total - payments.total);
  return {
    title: "Outstanding payment balance",
    description: `${invoices.count} invoice record(s) total ${formatAmount(invoices.total)} and ${payments.count} payment record(s) total ${formatAmount(payments.total)}. Outstanding balance (invoices minus payments) is ${formatAmount(outstanding)}.`,
    severity: outstanding > 0 ? "medium" : "info",
    confidence: 1,
    evidence,
    assumptions: [],
    openQuestions: [],
    claims: [
      {
        label: "outstanding balance",
        value: outstanding,
        components: [invoices.total, -payments.total],
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
      "Deterministically calculate the outstanding balance from per-record source amounts. Never estimate or infer a missing, ambiguous, or unsourced amount.",
    inputSchema: SpecialistInputSchema,
    outputSchema: SpecialistModelOutputSchema,
    profile: agentProfile,
    async run(input: SpecialistInput): Promise<AgentResult<SpecialistOutput>> {
      const finding = paymentReconciliationFinding(
        collectRecords(input.priorFindings, "invoice"),
        collectRecords(input.priorFindings, "payment"),
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

/** Keeps only citations that can be persisted as research evidence. */
function researchEvidence(
  citations: readonly Citation[],
  claimsByUrl: ReadonlyMap<string, string>,
): EvidenceDraft[] {
  const byUrl = new Map<string, EvidenceDraft>();
  for (const citation of citations) {
    const url = citation.url.trim();
    const title = citation.title.trim();
    if (!title || !z.string().url().safeParse(url).success) continue;
    if (byUrl.has(url)) continue;
    const span = citation.span?.trim() || null;
    byUrl.set(url, {
      kind: "research",
      sourceRef: url,
      confidence: "medium",
      documentId: null,
      page: null,
      textQuote: span,
      url,
      title,
      claim:
        citation.claim?.trim() ||
        claimsByUrl.get(url) ||
        span ||
        `Returned by official-source search as: ${title}`,
    });
  }
  return [...byUrl.values()];
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
    "For every cited URL, return a short claim in sources describing what that source says; do not state that it applies to this supplier.",
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
        const claimsByUrl = new Map(
          result.output.sources.map((source) => [
            source.url.trim(),
            source.claim.trim(),
          ]),
        );
        const evidence = researchEvidence(result.citations, claimsByUrl);
        const output = evidence.length
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
                  evidence,
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
        "For each invoice and each payment, report one source-linked claim whose label is exactly 'invoice amount: <invoice number>' or 'payment amount: <payment reference>'. The identifier must uniquely name the record; never combine records into one claim.",
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
