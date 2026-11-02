import type { AgentProfile, AgentProfileRepository } from "@evianta/core";
import { AgentProfileSetSchema } from "@evianta/core";
import {
  defineStructuredAgent,
  type Agent,
  type AgentResult,
} from "./agent.js";
import { businessDataAnalystProfile } from "./data-analysis.js";
import {
  PlanningInputSchema,
  PlanningOutputSchema,
  ReviewInputSchema,
  ReviewOutputSchema,
  SpecialistInputSchema,
  SpecialistModelOutputSchema,
  SpecialistOutputSchema,
  type PlanningInput,
  type PlanningOutput,
  type ReviewInput,
  type ReviewOutput,
  type SpecialistInput,
  type SpecialistModelOutput,
  type SpecialistOutput,
} from "./contracts.js";

export type SpecialistAgent = Agent<
  SpecialistInput,
  SpecialistOutput,
  SpecialistModelOutput
>;
export type ReviewAgent = Agent<ReviewInput, ReviewOutput>;
export type CoordinatorAgent = Agent<PlanningInput, PlanningOutput>;

export const COORDINATOR_ROLE = "coordinator";
export const REVIEWER_ROLE = "independent-reviewer";
export const GENERIC_ANALYST_ROLE = "generic-analyst";

export const coordinatorProfile: AgentProfile = {
  id: "agent-coordinator",
  role: COORDINATOR_ROLE,
  displayName: "Evianta",
  specialty: "Lead agent and work planning",
  summary:
    "Your lead agent. Understands the task, asks for what is missing, plans the work across specialists and brings back a review-ready result.",
  capabilities: [
    "Adapt the reference plan to uploaded documents",
    "Assign specialist roles and dependencies",
  ],
  tools: [],
  procedures: [
    "Start from the registered reference plan",
    "Keep every required specialist and review task",
  ],
  outputFormats: ["task plan"],
  limitations: ["Does not perform specialist analysis itself"],
  modelTier: "mid",
  enabled: true,
  kind: "lead",
  workflows: ["data-analysis", "tax-notice", "msme-payment"],
};

export const reviewerProfile: AgentProfile = {
  id: "agent-independent-reviewer",
  role: REVIEWER_ROLE,
  displayName: "Independent Reviewer",
  specialty: "Quality review",
  summary:
    "Reviews specialist work after deterministic checks for soundness and unsupported claims.",
  capabilities: [
    "Recompute totals and cross-check figures",
    "Flag unsupported or missing-evidence claims",
    "Raise open questions for the professional reviewer",
  ],
  tools: [],
  procedures: [
    "Run deterministic checks before any model review",
    "Record unresolved items as open questions",
  ],
  outputFormats: ["review notes", "open questions"],
  limitations: ["Does not approve deliverables"],
  modelTier: "high",
  enabled: true,
  kind: "reviewer",
  workflows: ["data-analysis", "tax-notice", "msme-payment"],
};

export const genericAnalystProfile: AgentProfile = {
  id: "agent-generic-analyst",
  role: GENERIC_ANALYST_ROLE,
  displayName: "Generic Analyst",
  specialty: "General document analysis",
  summary:
    "Summarizes case documents into evidence-linked findings for engine testing and simple cases.",
  capabilities: ["Summarize documents", "Cite document evidence"],
  tools: [],
  procedures: ["Cite a document location for every material finding"],
  outputFormats: ["findings"],
  limitations: ["No workflow-specific expertise"],
  modelTier: "cheap",
  enabled: true,
  kind: "specialist",
  workflows: [],
};

export function createSpecialistAgent(
  profile: AgentProfile,
  systemPrompt: string,
): SpecialistAgent {
  systemPrompt = [
    systemPrompt,
    "Source excerpts marked excerptsTruncated are partial. Preserve their evidence IDs and source locations, and flag material assertions that cannot be supported by the supplied excerpts.",
  ].join("\n");
  const structured = defineStructuredAgent({
    profile,
    systemPrompt,
    inputSchema: SpecialistInputSchema,
    outputSchema: SpecialistModelOutputSchema,
  });
  return {
    ...structured,
    async run(input, context): Promise<AgentResult<SpecialistOutput>> {
      const result = await structured.run(input, context);
      return {
        ...result,
        output: SpecialistOutputSchema.parse(result.output),
      };
    },
  };
}

export function createGenericAnalystAgent(): SpecialistAgent {
  return createSpecialistAgent(
    genericAnalystProfile,
    [
      "You are a careful analyst working on a professional case.",
      "Use only the provided document slices and prior findings.",
      "Return findings with evidence that cites a document ID and page or quote.",
      "Report figures as claims; include components when a figure is a total.",
    ].join("\n"),
  );
}

export function createReviewAgent(): ReviewAgent {
  return defineStructuredAgent({
    profile: reviewerProfile,
    systemPrompt: [
      "You independently review specialist findings.",
      "Deterministic checks already recomputed totals, evidence presence and consistency; do not repeat them.",
      "Assess narrative soundness, missing requirements and unsupported claims.",
      "Review every assertion in the supplied drafts, even when it has no corresponding finding. Compare draft text with source-backed findings and flag unsupported figures, deadlines, and legal conclusions.",
      "Source excerpts marked excerptsTruncated are partial; use their evidence IDs and source locations for traceability, and flag concerns that cannot be assessed from the supplied excerpt.",
      "Return each unresolved concern as an item with a severity.",
    ].join("\n"),
    inputSchema: ReviewInputSchema,
    outputSchema: ReviewOutputSchema,
  });
}

export function createCoordinatorAgent(): CoordinatorAgent {
  return defineStructuredAgent({
    profile: coordinatorProfile,
    systemPrompt: [
      "You plan professional casework as a dependency graph of tasks.",
      "Adapt the reference plan to the uploaded documents.",
      "Never drop a required task, and only assign available roles.",
      "Dependencies must reference task keys in your plan and must not form cycles.",
    ].join("\n"),
    inputSchema: PlanningInputSchema,
    outputSchema: PlanningOutputSchema,
  });
}

export interface AgentDirectoryEntry {
  profile: AgentProfile;
}

/**
 * Upserts each agent's co-located profile into the persistent directory.
 * Idempotent: profiles are keyed by role.
 */
export async function seedAgentDirectoryAsync(
  repository: Pick<AgentProfileRepository, "upsert">,
  agents: readonly AgentDirectoryEntry[] = [
    { profile: coordinatorProfile },
    { profile: businessDataAnalystProfile },
    { profile: genericAnalystProfile },
    { profile: reviewerProfile },
  ],
): Promise<AgentProfile[]> {
  const profiles = AgentProfileSetSchema.parse(
    agents.map((agent) => agent.profile),
  );
  for (const profile of profiles) await repository.upsert(profile);
  return profiles;
}
