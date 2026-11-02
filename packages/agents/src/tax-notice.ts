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

export const TAX_NOTICE_ANALYST_ROLE = "tax-notice-analyst";
export const TAX_RECONCILIATION_ROLE = "tax-notice-reconciliation";
export const TAX_RESEARCH_ROLE = "tax-notice-research";
export const TAX_RESPONSE_DRAFTER_ROLE = "tax-notice-response-drafter";

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
  tools: role === TAX_RESEARCH_ROLE ? ["web-search"] : [],
  procedures: [
    "Use only supplied evidence and clearly identify missing information",
    "Do not make legal determinations or submit filings",
  ],
  outputFormats: ["evidence-linked findings"],
  limitations: [
    "All legal analysis requires review by a qualified professional",
  ],
  modelTier,
  enabled: true,
  kind: "specialist",
  workflows: ["tax-notice"],
});

export const taxNoticeAnalystProfile = profile(
  "agent-tax-notice-analyst",
  TAX_NOTICE_ANALYST_ROLE,
  "Tax Notice Analyst",
  "Notice and return analysis",
  "Extracts notice issues, dates, figures, and requested information with source references.",
  [
    "Summarize notices",
    "Extract figures and deadlines",
    "Flag uncertain extraction",
  ],
  "cheap",
);

export const taxReconciliationProfile = profile(
  "agent-tax-notice-reconciliation",
  TAX_RECONCILIATION_ROLE,
  "Tax Reconciliation Specialist",
  "Tax record reconciliation",
  "Compares figures across supplied return, notice, and credit records.",
  [
    "Compare source figures",
    "Explain discrepancies",
    "Identify missing records",
  ],
  "mid",
);

export const taxResearchProfile = profile(
  "agent-tax-notice-research",
  TAX_RESEARCH_ROLE,
  "Tax Research Specialist",
  "Legal research",
  "Finds general official guidance when provider search is available and flags applicability for verification.",
  [
    "Search general official guidance",
    "Preserve source citations",
    "Flag unverified applicability",
  ],
  "mid",
);

export const taxResponseDrafterProfile = profile(
  "agent-tax-notice-response-drafter",
  TAX_RESPONSE_DRAFTER_ROLE,
  "Tax Response Drafter",
  "Response preparation",
  "Prepares an evidence-linked response draft and supporting schedules for professional review.",
  [
    "Draft response materials",
    "Reference supporting evidence",
    "Surface open questions",
  ],
  "mid",
);

export const taxNoticeProfiles = [
  taxNoticeAnalystProfile,
  taxReconciliationProfile,
  taxResearchProfile,
  taxResponseDrafterProfile,
] as const;

export function createTaxNoticePlan(): ReferencePlan {
  return {
    useCase: "tax-notice",
    version: 1,
    title: "Tax notice response pack",
    format: "document",
    tasks: [
      {
        key: "case-analysis",
        role: TAX_NOTICE_ANALYST_ROLE,
        title: "Notice and return analysis",
        dependsOn: [],
        required: true,
        instructions:
          "Extract notice issues, dates, requested information, and figures. Put each numeric figure in its own finding with its own source evidence, using the exact claim labels 'return income', 'notice income', 'claimed credit', or 'available credit'. Cite each source document and location. Flag uncertain extraction.",
      },
      {
        key: "reconciliation",
        role: TAX_RECONCILIATION_ROLE,
        title: "Figure reconciliation",
        dependsOn: ["case-analysis"],
        required: true,
        instructions:
          "Compare the figures in the notice with the return and credit records. Show the source values and arithmetic for each discrepancy; do not infer missing values.",
      },
      {
        key: "tax-research",
        role: TAX_RESEARCH_ROLE,
        title: "Research for professional verification",
        dependsOn: ["case-analysis"],
        required: true,
        instructions:
          "Find general official tax guidance using provider web search when available. Preserve source citations and never assert that a provision applies without professional verification.",
      },
      {
        key: "response-preparation",
        role: TAX_RESPONSE_DRAFTER_ROLE,
        title: "Response draft and schedules",
        dependsOn: ["reconciliation", "tax-research"],
        required: true,
        instructions:
          "Prepare a response draft and supporting schedules from the cited findings. Include assumptions and open questions; mark legal points for verification. Do not file or submit anything.",
      },
      {
        key: "independent-review",
        role: REVIEWER_ROLE,
        title: "Independent review",
        dependsOn: ["response-preparation"],
        required: true,
        instructions:
          "Review the response pack for arithmetic errors, unsupported claims, missing evidence, and unresolved questions. Do not approve or submit the response.",
      },
    ],
  };
}

const researchResultSchema = z.object({ summary: z.string() });
const zeroUsage: UsageUnits = { input: 0, output: 0, total: 0 };
const researchQuery =
  "Find current official Indian Income Tax Department guidance on responding to income-tax notices and assessment intimations. Return only verifiable official sources; do not infer facts about a taxpayer or a specific assessment year.";

function canonicalClaim(
  findings: readonly PriorFinding[],
  label: string,
): { value: number; confidence: number; sources: PriorFinding[] } | null {
  const matches = findings.filter((finding) =>
    finding.claims.some((claim) => claim.label.trim().toLowerCase() === label),
  );
  const claims = matches.flatMap((finding) =>
    finding.claims.filter(
      (claim) => claim.label.trim().toLowerCase() === label,
    ),
  );
  const values = new Set<number>();
  for (const claim of claims) {
    if (claim.value === null || !Number.isFinite(claim.value)) return null;
    values.add(claim.value);
  }
  if (values.size !== 1) return null;
  const confidences = matches.map((finding) => {
    // Finding-level citations cannot distinguish support for grouped figures.
    if (finding.claims.filter((claim) => claim.value !== null).length !== 1) {
      return 0;
    }
    if (
      finding.openQuestions?.some(
        (question) =>
          question.status === "open" && question.severity === "high",
      )
    ) {
      return 0;
    }
    const documents = (finding.sourceEvidence ?? []).filter(
      (source) => source.kind === "document",
    );
    if (!documents.length) return 0;
    const evidenceConfidence = Math.min(
      ...documents.map((source) => {
        const extraction = source.extraction;
        if (
          !source.documentId ||
          !source.location ||
          !extraction ||
          extraction.confidence < 0.75 ||
          extraction.method === "handwriting" ||
          extraction.hasHandwriting ||
          extraction.warningCount > 0 ||
          extraction.minimumPageConfidence < 0.75
        ) {
          return 0;
        }
        return Math.min(
          extraction.confidence,
          extraction.minimumPageConfidence,
          source.confidence === "high"
            ? 1
            : source.confidence === "medium"
              ? 0.7
              : 0,
        );
      }),
    );
    return Math.min(finding.confidence ?? 0.5, evidenceConfidence);
  });
  const confidence = Math.min(...confidences);
  if (confidence === 0) return null;
  return { value: [...values][0]!, confidence, sources: matches };
}

function priorEvidenceDrafts(
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

function reconciliationFinding(
  name: string,
  leftLabel: string,
  left: ReturnType<typeof canonicalClaim>,
  rightLabel: string,
  right: ReturnType<typeof canonicalClaim>,
): SpecialistOutput["findings"][number] {
  if (!left || !right) {
    const sources = [left, right].flatMap((source) => source?.sources ?? []);
    return {
      title: `${name} reconciliation incomplete`,
      description: `Both a ${leftLabel} and a ${rightLabel} figure with traceable document evidence and no unresolved high-severity extraction questions are required before this discrepancy can be calculated.`,
      severity: "low",
      confidence: 1,
      evidence: priorEvidenceDrafts(sources),
      assumptions: [],
      openQuestions: [
        {
          text: `Provide or confirm the source figures for ${leftLabel} and ${rightLabel}. Verify unreadable, low-confidence, handwritten, or warning-bearing extraction against the original records before proceeding.`,
          severity: "high",
        },
      ],
      claims: [],
    };
  }
  const difference = right.value - left.value;
  const sources = priorEvidenceDrafts([...left.sources, ...right.sources]);
  return {
    title: `${name} reconciliation`,
    description: `${leftLabel} is ${formatAmount(left.value)} and ${rightLabel} is ${formatAmount(right.value)}. The difference (${rightLabel} minus ${leftLabel}) is ${formatAmount(difference)}.`,
    severity: difference === 0 ? "info" : "medium",
    confidence: Math.min(left.confidence, right.confidence),
    evidence: sources,
    assumptions: [
      ...new Set(
        [...left.sources, ...right.sources].flatMap(
          (source) => source.assumptions ?? [],
        ),
      ),
    ],
    openQuestions: [...left.sources, ...right.sources].flatMap((source) =>
      (source.openQuestions ?? [])
        .filter((question) => question.status === "open")
        .map(({ text, severity }) => ({ text, severity })),
    ),
    claims: [
      {
        label: `${name} difference`,
        value: difference,
        components: [right.value, -left.value],
        date: null,
      },
    ],
  };
}

function createTaxReconciliationAgent(): SpecialistAgent {
  const agentProfile = taxReconciliationProfile;
  const outputSchema = SpecialistOutputSchema;
  return {
    role: TAX_RECONCILIATION_ROLE,
    modelTier: agentProfile.modelTier,
    systemPrompt:
      "Deterministically reconcile canonical figures extracted from the source records. Never estimate or infer a missing or ambiguous figure.",
    inputSchema: SpecialistInputSchema,
    outputSchema: SpecialistModelOutputSchema,
    profile: agentProfile,
    async run(input: SpecialistInput): Promise<AgentResult<SpecialistOutput>> {
      const findings = input.priorFindings;
      const returnedIncome = canonicalClaim(findings, "return income");
      const noticedIncome = canonicalClaim(findings, "notice income");
      const claimedCredit = canonicalClaim(findings, "claimed credit");
      const availableCredit = canonicalClaim(findings, "available credit");
      const income = reconciliationFinding(
        "Income",
        "return income",
        returnedIncome,
        "notice income",
        noticedIncome,
      );
      const credit = reconciliationFinding(
        "Credit",
        "claimed credit",
        claimedCredit,
        "available credit",
        availableCredit,
      );
      const output = outputSchema.parse({
        summary:
          "Income and credit differences are calculated from the canonical figures extracted from source records.",
        findings: [income, credit],
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
      "No legal research sources were verified. No provision or deadline is asserted.",
    findings: [
      {
        title: "Legal research requires professional verification",
        description:
          "Provider web search was unavailable or returned no citations. Verify the applicable provisions, deadlines, and assessment-year rules before using this response pack.",
        severity: "info",
        confidence: 1,
        evidence: [],
        assumptions: [],
        openQuestions: [
          {
            text: "Which provisions and deadlines apply to this notice and assessment year?",
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

function createTaxResearchAgent(): SpecialistAgent {
  const agentProfile = taxResearchProfile;
  const systemPrompt = [
    "You are a tax research assistant preparing general guidance for a qualified professional.",
    "Use web search only for authoritative official sources. Do not make a legal determination or assert that a rule applies to this taxpayer.",
    "The query is deliberately generic and contains no case or personal data.",
    "Your response must be a short summary; citations are captured separately from provider search results.",
  ].join("\n");
  return {
    role: TAX_RESEARCH_ROLE,
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
        const citations = result.citations;
        const output = citations.length
          ? SpecialistOutputSchema.parse({
              summary:
                "General official sources were found; their applicability requires professional verification.",
              findings: [
                {
                  title: "Official sources for professional verification",
                  description:
                    "These search results may inform the review. Confirm that each source is current and applies to the notice's jurisdiction and assessment year.",
                  severity: "medium",
                  confidence: 1,
                  evidence: citations.map((citation) => ({
                    kind: "research",
                    sourceRef: citation.url,
                    confidence: "medium",
                    documentId: null,
                    page: null,
                    textQuote: citation.span?.trim() || null,
                    url: citation.url,
                    title: citation.title,
                    claim:
                      citation.claim?.trim() ||
                      `Provider search returned "${citation.title}" as a source for professional verification; currency and applicability have not been verified.`,
                  })),
                  assumptions: [],
                  openQuestions: [
                    {
                      text: "Has a qualified professional confirmed the source's currency and applicability?",
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
          citations,
          provider: result.provider,
          model: result.model,
          modelTier: agentProfile.modelTier,
        };
      } catch (error) {
        if (!isUnavailableSearch(error)) throw error;
        context.logger.warn("Tax research search is unavailable", {
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

export function createTaxNoticeSpecialists(): SpecialistAgent[] {
  return [
    createSpecialistAgent(
      taxNoticeAnalystProfile,
      [
        "You analyze income-tax notices for a qualified professional.",
        "Use only supplied document slices and prior findings.",
        "Put each numeric figure in a separate finding with only that figure's source evidence. Use the exact claim labels 'return income', 'notice income', 'claimed credit', or 'available credit'. Never group figures into one finding.",
        "Cite the document ID and page or cell for each material finding.",
        "Report uncertain extraction as an open question; do not invent deadlines or legal conclusions.",
        "Document extraction reliability and warnings are supplied with each slice. Flag low-confidence or handwritten extraction for professional verification; never override those warnings with your own confidence label.",
      ].join("\n"),
    ),
    createTaxReconciliationAgent(),
    createTaxResearchAgent(),
    createSpecialistAgent(
      taxResponseDrafterProfile,
      [
        "You prepare a response draft for a qualified tax professional to review.",
        "Use only supplied findings and source evidence; cite each material assertion.",
        "Clearly label assumptions, unresolved questions, and legal points requiring current-law verification.",
        "Do not make a legal determination, approve the response, or submit a filing.",
      ].join("\n"),
    ),
  ];
}
