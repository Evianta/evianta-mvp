import type { AgentProfile, UseCase } from "@evianta/core";

export type AgentCategory = "lead" | "specialist" | "reviewer" | "system";

export interface DirectoryAgent {
  role: string;
  displayName: string;
  tagline: string;
  summary: string;
  category: AgentCategory;
  workflows: UseCase[];
  capabilities: string[];
  procedures: string[];
  outputs: string[];
  limitations: string[];
  tools: string[];
  speed: string | null;
  avatar: string | null;
}

export const LEAD_ROLE = "coordinator";

export const categoryLabels: Record<AgentCategory, string> = {
  lead: "Lead agent",
  specialist: "Specialists",
  reviewer: "Reviewers",
  system: "System capabilities",
};

export const categoryOrder: AgentCategory[] = [
  "lead",
  "specialist",
  "reviewer",
  "system",
];

export const workflowLabels: Record<UseCase, string> = {
  "data-analysis": "Data analysis",
  "tax-notice": "Tax notice",
  "msme-payment": "MSME delayed payment",
};

const speedLabels: Record<AgentProfile["modelTier"], string> = {
  cheap: "Fast",
  mid: "Balanced",
  high: "Deep review",
};

const hiddenRoles = new Set(["generic-analyst"]);

const knownAvatars = new Set([
  "coordinator",
  "business-data-analyst",
  "tax-notice-analyst",
  "tax-notice-reconciliation",
  "tax-notice-research",
  "tax-notice-response-drafter",
  "msme-document-analysis",
  "msme-payment-reconciliation",
  "msme-evidence-analysis",
  "msme-legal-research",
  "msme-case-preparation",
  "independent-reviewer",
  "document-reader",
  "calculation-engine",
  "evidence-linker",
  "source-reader",
]);

export function avatarFor(role: string): string | null {
  const name = role === LEAD_ROLE ? "evianta" : role;
  return knownAvatars.has(role) ? `/agents/${name}.svg` : null;
}

function categoryOf(profile: AgentProfile): AgentCategory {
  if (profile.role === LEAD_ROLE) return "lead";
  if (profile.kind) return profile.kind;
  return profile.role.includes("reviewer") ? "reviewer" : "specialist";
}

export function toDirectoryAgent(profile: AgentProfile): DirectoryAgent {
  return {
    role: profile.role,
    displayName: profile.displayName,
    tagline: profile.specialty,
    summary: profile.summary,
    category: categoryOf(profile),
    workflows: profile.workflows ?? [],
    capabilities: profile.capabilities,
    procedures: profile.procedures,
    outputs: profile.outputFormats,
    limitations: profile.limitations,
    tools: profile.tools,
    speed: speedLabels[profile.modelTier],
    avatar: avatarFor(profile.role),
  };
}

export const systemAgents: DirectoryAgent[] = [
  {
    role: "document-reader",
    displayName: "Document Reader",
    tagline: "Reads PDFs, spreadsheets and text",
    summary:
      "Turns your uploads into searchable pages, tables and cells so every claim can point back to a source.",
    category: "system",
    workflows: ["data-analysis", "tax-notice", "msme-payment"],
    capabilities: [
      "Read PDF pages, CSV, Excel, JSON and text",
      "Keep page, row and cell locations",
      "Flag partly readable files",
    ],
    procedures: ["Deterministic parsing first", "OCR only when admitted"],
    outputs: ["source text", "tables"],
    limitations: ["Cannot read files that are damaged or password protected"],
    tools: [],
    speed: null,
    avatar: avatarFor("document-reader"),
  },
  {
    role: "calculation-engine",
    displayName: "Calculation Engine",
    tagline: "Exact arithmetic, no guessing",
    summary:
      "Computes totals, dates and reconciliations with deterministic code. Models only interpret the results.",
    category: "system",
    workflows: ["data-analysis", "tax-notice", "msme-payment"],
    capabilities: [
      "Totals, averages and period changes",
      "Date and interest-period math",
      "Cross-check figures between sources",
    ],
    procedures: ["Compute first, explain after"],
    outputs: ["verified figures"],
    limitations: ["Works only on figures present in your records"],
    tools: [],
    speed: null,
    avatar: avatarFor("calculation-engine"),
  },
  {
    role: "evidence-linker",
    displayName: "Evidence Linker",
    tagline: "Connects findings to sources",
    summary:
      "Attaches each finding to the exact page, row or cell it came from, so you can verify it in one click.",
    category: "system",
    workflows: ["data-analysis", "tax-notice", "msme-payment"],
    capabilities: [
      "Source-linked citations",
      "Reverse lookup from source to claims",
    ],
    procedures: ["No finding without a source reference"],
    outputs: ["evidence links"],
    limitations: ["Does not judge whether a source is legally sufficient"],
    tools: [],
    speed: null,
    avatar: avatarFor("evidence-linker"),
  },
];

export function buildDirectory(profiles: AgentProfile[]): DirectoryAgent[] {
  const agents = profiles
    .filter((profile) => !hiddenRoles.has(profile.role))
    .map(toDirectoryAgent);
  return [...agents, ...systemAgents].sort(
    (left, right) =>
      categoryOrder.indexOf(left.category) -
        categoryOrder.indexOf(right.category) ||
      left.displayName.localeCompare(right.displayName),
  );
}

export function agentNameForRole(
  role: string,
  profiles: readonly AgentProfile[],
): string {
  const profile = profiles.find((item) => item.role === role);
  if (profile) return profile.displayName;
  return role
    .split("-")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}
