import type { Deliverable, Finding, RunDto } from "@evianta/core";
import type { CaseWorkspace } from "../api/client";

export interface ResultFinding {
  id: string;
  title: string;
  severity: Finding["severity"];
  confidence: number;
  evidenceCount: number;
}

export interface ResultSummary {
  headline: string;
  findings: ResultFinding[];
  totalFindings: number;
  openQuestions: number;
  deliverables: { id: string; title: string; format: Deliverable["format"] }[];
  sourceCount: number;
  evidenceCount: number;
  usage: RunDto["usage"] | null;
}

const severityRank: Record<Finding["severity"], number> = {
  high: 0,
  medium: 1,
  low: 2,
  info: 3,
};

export function isInputFinding(finding: Pick<Finding, "id">): boolean {
  return finding.id.includes(":input:");
}

export function latestDeliverable(
  workspace: CaseWorkspace,
): Deliverable | undefined {
  return [...workspace.deliverables].sort(
    (left, right) =>
      right.createdAt.localeCompare(left.createdAt) ||
      right.version - left.version,
  )[0];
}

export function buildResult(
  workspace: CaseWorkspace,
  run: RunDto | null,
  limit = 4,
): ResultSummary {
  const deliverable = latestDeliverable(workspace);
  const referenced = new Set(
    deliverable?.sections.flatMap((section) => section.findingIds) ?? [],
  );
  const findings = workspace.findings.filter(
    (finding) =>
      !isInputFinding(finding) &&
      (referenced.size === 0 || referenced.has(finding.id)),
  );
  const ranked = [...findings].sort(
    (left, right) =>
      severityRank[left.severity] - severityRank[right.severity] ||
      right.confidence - left.confidence,
  );
  return {
    headline:
      deliverable?.summary.trim() ||
      "The work is finished. Open the details to review it.",
    findings: ranked.slice(0, limit).map((finding) => ({
      id: finding.id,
      title: finding.title,
      severity: finding.severity,
      confidence: finding.confidence,
      evidenceCount: finding.evidenceIds.length,
    })),
    totalFindings: findings.length,
    openQuestions: findings.reduce(
      (total, finding) =>
        total +
        finding.openQuestions.filter((question) => question.status === "open")
          .length,
      0,
    ),
    deliverables: deliverable
      ? [
          {
            id: deliverable.id,
            title: deliverable.title,
            format: deliverable.format,
          },
        ]
      : [],
    sourceCount: workspace.documents.length,
    evidenceCount: workspace.evidence.length,
    usage: run?.usage ?? null,
  };
}

export interface PendingQuestion {
  id: string;
  text: string;
  severity: "high" | "medium" | "low";
}

export function pendingInputQuestions(
  workspace: CaseWorkspace,
): PendingQuestion[] {
  return workspace.findings
    .filter(isInputFinding)
    .flatMap((finding) => finding.openQuestions)
    .filter((question) => question.status === "open")
    .map((question) => ({
      id: question.id,
      text: question.text,
      severity: question.severity,
    }));
}
