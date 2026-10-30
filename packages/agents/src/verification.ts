import type { NumericClaim, ReviewFlag } from "./contracts.js";

export interface VerifiableFinding {
  id: string;
  taskId: string;
  title: string;
  severity: string;
  evidenceIds: readonly string[];
  claims: readonly NumericClaim[];
}

export interface VerificationResult {
  passed: boolean;
  flags: ReviewFlag[];
}

const MATERIAL_SEVERITIES = new Set(["high", "medium"]);

function tolerance(value: number): number {
  return Math.max(0.005, Math.abs(value) * 1e-9);
}

function normalizeLabel(label: string): string {
  return label.trim().toLowerCase().replace(/\s+/g, " ");
}

/** Recomputes totals and reconciliations claimed by agents. */
export function checkTotals(
  findings: readonly VerifiableFinding[],
): ReviewFlag[] {
  const flags: ReviewFlag[] = [];
  for (const finding of findings) {
    for (const claim of finding.claims) {
      if (claim.value === null || !claim.components?.length) continue;
      const recomputed = claim.components.reduce((sum, item) => sum + item, 0);
      if (Math.abs(recomputed - claim.value) > tolerance(claim.value)) {
        flags.push({
          id: `check:total:${finding.id}:${normalizeLabel(claim.label)}`,
          code: "total-mismatch",
          severity: "high",
          text: `"${claim.label}" is stated as ${claim.value} but its components sum to ${Number(recomputed.toFixed(6))}.`,
          findingIds: [finding.id],
        });
      }
    }
  }
  return flags;
}

/** Every material finding must cite at least one evidence item. */
export function checkEvidencePresence(
  findings: readonly VerifiableFinding[],
): ReviewFlag[] {
  return findings
    .filter(
      (finding) =>
        MATERIAL_SEVERITIES.has(finding.severity) &&
        finding.evidenceIds.length === 0,
    )
    .map((finding) => ({
      id: `check:evidence:${finding.id}`,
      code: "missing-evidence" as const,
      severity: "high" as const,
      text: `Material finding "${finding.title}" cites no evidence.`,
      findingIds: [finding.id],
    }));
}

/** Figures and dates with the same label must agree across tasks. */
export function checkConsistency(
  findings: readonly VerifiableFinding[],
): ReviewFlag[] {
  const flags: ReviewFlag[] = [];
  const values = new Map<string, Array<{ findingId: string; value: number }>>();
  const dates = new Map<string, Array<{ findingId: string; date: string }>>();
  for (const finding of findings) {
    for (const claim of finding.claims) {
      const label = normalizeLabel(claim.label);
      if (claim.value !== null) {
        values.set(label, [
          ...(values.get(label) ?? []),
          { findingId: finding.id, value: claim.value },
        ]);
      }
      if (claim.date !== null) {
        dates.set(label, [
          ...(dates.get(label) ?? []),
          { findingId: finding.id, date: claim.date.trim() },
        ]);
      }
    }
  }
  for (const [label, items] of values) {
    const first = items[0];
    if (
      items.some(
        (item) => Math.abs(item.value - first.value) > tolerance(first.value),
      )
    ) {
      flags.push({
        id: `check:figure:${label}`,
        code: "inconsistent-figure",
        severity: "medium",
        text: `"${label}" has conflicting values: ${[...new Set(items.map((item) => item.value))].join(", ")}.`,
        findingIds: [...new Set(items.map((item) => item.findingId))],
      });
    }
  }
  for (const [label, items] of dates) {
    if (new Set(items.map((item) => item.date)).size > 1) {
      flags.push({
        id: `check:date:${label}`,
        code: "inconsistent-date",
        severity: "medium",
        text: `"${label}" has conflicting dates: ${[...new Set(items.map((item) => item.date))].join(", ")}.`,
        findingIds: [...new Set(items.map((item) => item.findingId))],
      });
    }
  }
  return flags;
}

/** Plain TypeScript checks that run before any review model call. */
export function runDeterministicChecks(
  findings: readonly VerifiableFinding[],
): VerificationResult {
  const flags = [
    ...checkTotals(findings),
    ...checkEvidencePresence(findings),
    ...checkConsistency(findings),
  ];
  return { passed: flags.length === 0, flags };
}
