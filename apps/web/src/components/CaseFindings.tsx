"use client";

import type { CaseWorkspace } from "../api/client";

export function CaseFindings({
  workspace,
  onOpenEvidence,
}: {
  workspace: CaseWorkspace | null;
  onOpenEvidence: (evidenceId: string) => void;
}) {
  const deliverable = [...(workspace?.deliverables ?? [])].sort(
    (left, right) =>
      right.createdAt.localeCompare(left.createdAt) ||
      right.version - left.version,
  )[0];
  const findingIds = new Set(
    (workspace?.deliverables ?? [])
      .filter((item) => item.runId === deliverable?.runId)
      .flatMap((item) =>
        item.sections.flatMap((section) => section.findingIds),
      ),
  );
  const findings = (workspace?.findings ?? []).filter((finding) =>
    findingIds.has(finding.id),
  );
  const evidenceById = new Map(
    workspace?.evidence.map((evidence) => [evidence.id, evidence]),
  );
  const documentsById = new Map(
    workspace?.documents.map((document) => [document.id, document]),
  );

  if (!findings.length) {
    return (
      <p className="mt-5 rounded-lg border border-dashed border-border p-4 text-xs text-muted-foreground">
        No findings are available for this deliverable yet.
      </p>
    );
  }

  return (
    <ul className="mt-5 space-y-3">
      {findings.map((finding) => (
        <li
          className="rounded-lg border border-border bg-background p-3"
          key={finding.id}
        >
          <div className="flex items-start justify-between gap-3">
            <h3 className="text-xs font-semibold">{finding.title}</h3>
            <span className="text-xs capitalize text-muted-foreground">
              {finding.severity} severity
            </span>
          </div>
          <p className="mt-1 text-xs text-muted-foreground">
            {Math.round(finding.confidence * 100)}% confidence
          </p>
          <p className="mt-2 whitespace-pre-wrap text-xs leading-relaxed">
            {finding.description}
          </p>
          {finding.assumptions.length > 0 && (
            <div className="mt-3">
              <h4 className="text-xs font-semibold">Assumptions</h4>
              <ul className="mt-1 list-disc space-y-1 pl-4 text-xs text-muted-foreground">
                {finding.assumptions.map((assumption, index) => (
                  <li key={index}>{assumption}</li>
                ))}
              </ul>
            </div>
          )}
          {finding.openQuestions.length > 0 && (
            <div className="mt-3">
              <h4 className="text-xs font-semibold">Questions</h4>
              <ul className="mt-1 space-y-2 text-xs">
                {finding.openQuestions.map((question) => (
                  <li key={question.id}>
                    <p>{question.text}</p>
                    <p className="mt-1 text-xs capitalize text-muted-foreground">
                      {question.severity} severity / {question.status}
                    </p>
                    {question.resolutionNote && (
                      <p className="mt-1 text-xs text-muted-foreground">
                        Resolution: {question.resolutionNote}
                      </p>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {finding.evidenceIds.length > 0 ? (
            <ul className="mt-3 space-y-2">
              {finding.evidenceIds.map((id) => {
                const evidence = evidenceById.get(id);
                if (!evidence) {
                  return (
                    <li className="text-xs text-danger" key={id}>
                      Evidence unavailable: {id}
                    </li>
                  );
                }
                const name =
                  evidence.kind === "document"
                    ? (documentsById.get(evidence.documentId)?.name ??
                      evidence.documentId)
                    : evidence.citation.title;
                const location =
                  evidence.kind === "document"
                    ? [
                        evidence.location.page
                          ? `page ${evidence.location.page}`
                          : null,
                        evidence.location.sheet,
                        evidence.location.cellRange,
                        evidence.location.rowRange
                          ? `rows ${evidence.location.rowRange.start}-${evidence.location.rowRange.end}`
                          : null,
                      ]
                        .filter(Boolean)
                        .join(", ")
                    : evidence.citation.url;
                return (
                  <li key={id}>
                    <button
                      type="button"
                      className="text-left text-xs text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                      onClick={() => onOpenEvidence(id)}
                    >
                      Evidence: {name}
                      {location ? ` (${location})` : ""}
                    </button>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {evidence.confidence} source confidence
                    </p>
                  </li>
                );
              })}
            </ul>
          ) : (
            <p className="mt-3 text-xs text-muted-foreground">
              No supporting evidence linked.
            </p>
          )}
        </li>
      ))}
    </ul>
  );
}
