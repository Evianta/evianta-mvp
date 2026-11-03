"use client";

import Link from "next/link";
import { ArrowRight, FileText } from "lucide-react";
import type { AgentProfile } from "@evianta/core";
import type { CaseWorkspace } from "../api/client";
import {
  agentNameForRole,
  buildDirectory,
  type DirectoryAgent,
} from "../agents";
import type { InspectTarget } from "../chat/types";
import { formatFileSize } from "../intake";
import { AgentInspector } from "./AgentsClient";
import { StatusBadge } from "./Badges";
import { Chip } from "./Chip";
import { InspectorPanel } from "./InspectorPanel";
import { DeliverableExport } from "./DeliverableExport";

const documentStateLabels: Record<string, string> = {
  uploaded: "Uploaded",
  processing: "Being read",
  ready: "Ready",
  partial: "Partly read",
  failed: "Could not be read",
};

function locationLabel(
  evidence: CaseWorkspace["evidence"][number],
): string | null {
  if (evidence.kind !== "document") return evidence.citation.url;
  const parts = [
    evidence.location.page ? `page ${evidence.location.page}` : null,
    evidence.location.sheet,
    evidence.location.cellRange,
    evidence.location.rowRange
      ? `rows ${evidence.location.rowRange.start}-${evidence.location.rowRange.end}`
      : null,
  ].filter(Boolean);
  return parts.length ? parts.join(", ") : null;
}

export function ChatInspector({
  target,
  onClose,
  onInspect,
  workspace,
  caseId,
  profiles,
  localFiles,
}: {
  target: InspectTarget | null;
  onClose: () => void;
  onInspect: (target: InspectTarget) => void;
  workspace: CaseWorkspace | null;
  caseId: string | null;
  profiles: AgentProfile[];
  localFiles: { name: string; size: number }[];
}) {
  if (target?.kind === "agent") {
    const entry: DirectoryAgent = buildDirectory(profiles).find(
      (agent) => agent.role === target.role,
    ) ?? {
      role: target.role,
      displayName: agentNameForRole(target.role, profiles),
      tagline: "Specialist",
      summary: "",
      category: "specialist",
      workflows: [],
      capabilities: [],
      procedures: [],
      outputs: [],
      limitations: [],
      tools: [],
      speed: null,
      avatar: null,
    };
    return <AgentInspector agent={entry} onClose={onClose} />;
  }

  const finding =
    target?.kind === "finding"
      ? workspace?.findings.find((item) => item.id === target.id)
      : undefined;
  const deliverable =
    target?.kind === "deliverable"
      ? workspace?.deliverables.find((item) => item.id === target.id)
      : undefined;
  const document =
    target?.kind === "document"
      ? (workspace?.documents.find(
          (item) => item.id === target.id || item.name === target.name,
        ) ?? null)
      : null;
  const local =
    target?.kind === "document"
      ? localFiles.find((file) => file.name === target.name)
      : undefined;

  let title = "Details";
  let description: string | undefined;
  if (target?.kind === "finding") {
    title = finding?.title ?? "Finding";
    description = finding
      ? `${finding.severity} severity, ${Math.round(finding.confidence * 100)}% confidence`
      : undefined;
  } else if (target?.kind === "deliverable") {
    title = deliverable?.title ?? "Deliverable";
    description = deliverable ? `Version ${deliverable.version}` : undefined;
  } else if (target?.kind === "document") {
    title = target.name;
    description = "Source document";
  }

  const documentsById = new Map(
    workspace?.documents.map((item) => [item.id, item]),
  );
  const evidenceById = new Map(
    workspace?.evidence.map((item) => [item.id, item]),
  );

  return (
    <InspectorPanel
      open={Boolean(target)}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={title}
      description={description}
      leading={
        <span className="icon-tile icon-tile-teal">
          <FileText size={18} aria-hidden="true" />
        </span>
      }
    >
      {target?.kind === "finding" &&
        (finding ? (
          <div className="space-y-5 text-sm">
            <p className="whitespace-pre-wrap leading-relaxed">
              {finding.description}
            </p>
            {finding.assumptions.length > 0 && (
              <section>
                <h3 className="inspector-heading">Assumptions</h3>
                <ul className="mt-2 list-disc space-y-1.5 pl-5 text-muted-foreground">
                  {finding.assumptions.map((assumption, index) => (
                    <li key={index}>{assumption}</li>
                  ))}
                </ul>
              </section>
            )}
            {finding.openQuestions.length > 0 && (
              <section>
                <h3 className="inspector-heading">Open questions</h3>
                <ul className="mt-2 space-y-2">
                  {finding.openQuestions.map((question) => (
                    <li key={question.id}>
                      {question.text}
                      <span className="ml-2 text-xs capitalize text-muted-foreground">
                        {question.severity}
                      </span>
                    </li>
                  ))}
                </ul>
              </section>
            )}
            <section>
              <h3 className="inspector-heading">Sources</h3>
              {finding.evidenceIds.length === 0 ? (
                <p className="mt-2 text-muted-foreground">
                  No supporting source is linked to this finding.
                </p>
              ) : (
                <ul className="mt-2 flex flex-col gap-2">
                  {finding.evidenceIds.map((id) => {
                    const evidence = evidenceById.get(id);
                    if (!evidence) return null;
                    const name =
                      evidence.kind === "document"
                        ? (documentsById.get(evidence.documentId)?.name ??
                          "Document")
                        : evidence.citation.title;
                    const where = locationLabel(evidence);
                    return (
                      <li key={id}>
                        <Chip
                          icon={<FileText size={13} aria-hidden="true" />}
                          onClick={() =>
                            evidence.kind === "document"
                              ? onInspect({
                                  kind: "document",
                                  id: evidence.documentId,
                                  name,
                                })
                              : undefined
                          }
                        >
                          {name}
                          {where ? ` (${where})` : ""}
                        </Chip>
                      </li>
                    );
                  })}
                </ul>
              )}
            </section>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">
            Loading the finding...
          </p>
        ))}
      {target?.kind === "deliverable" &&
        (deliverable ? (
          <div className="space-y-5 text-sm">
            <p className="leading-relaxed">{deliverable.summary}</p>
            <DeliverableExport
              deliverable={deliverable}
              context={workspace?.case}
            />
            <section>
              <h3 className="inspector-heading">Sections</h3>
              <ul className="mt-2 space-y-2">
                {deliverable.sections.map((section) => (
                  <li
                    key={section.id}
                    className="flex items-center justify-between gap-3"
                  >
                    <span>{section.title}</span>
                    <StatusBadge
                      tone={
                        section.reviewStatus === "accepted"
                          ? "success"
                          : section.reviewStatus === "changes-requested"
                            ? "warning"
                            : "neutral"
                      }
                    >
                      {section.reviewStatus.replaceAll("-", " ")}
                    </StatusBadge>
                  </li>
                ))}
              </ul>
            </section>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">Loading...</p>
        ))}
      {target?.kind === "document" && (
        <dl className="space-y-3 text-sm">
          <div>
            <dt className="inspector-heading">Type</dt>
            <dd>{document?.mimeType ?? "Selected file"}</dd>
          </div>
          <div>
            <dt className="inspector-heading">Size</dt>
            <dd>{formatFileSize(document?.sizeBytes ?? local?.size ?? 0)}</dd>
          </div>
          <div>
            <dt className="inspector-heading">Status</dt>
            <dd>
              {document
                ? (documentStateLabels[document.state] ?? document.state)
                : "Waiting to be uploaded"}
            </dd>
          </div>
        </dl>
      )}
      {caseId && target && (
        <Link
          href={`/cases/${encodeURIComponent(caseId)}`}
          className="button-link button-link-secondary mt-6"
        >
          Open the full case <ArrowRight size={14} aria-hidden="true" />
        </Link>
      )}
    </InspectorPanel>
  );
}
