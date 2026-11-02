"use client";

import { useEffect, useState } from "react";
import Image from "next/image";
import {
  ArrowUpRight,
  Check,
  CircleAlert,
  Download,
  FileText,
  MessageSquareText,
} from "lucide-react";
import {
  isApprovalCurrent,
  type Approval,
  type Deliverable,
  type DeliverableSection,
  type Evidence,
} from "@evianta/core";
import type { CaseWorkspace, WebApiClient } from "../api/client";
import { sourcePreviewMimeType } from "../source-preview";
import { Button } from "./Button";

function evidenceLocation(evidence: Evidence): string {
  if (evidence.kind !== "document") return evidence.sourceRef;
  const { location } = evidence;
  return [
    location.page === undefined ? null : `Page ${location.page}`,
    location.sheet,
    location.cellRange,
    location.rowRange
      ? `Rows ${location.rowRange.start}–${location.rowRange.end}`
      : null,
    location.textQuote ? `“${location.textQuote}”` : null,
  ]
    .filter((item): item is string => item !== null)
    .join(" · ");
}

function originalDraft(section: DeliverableSection): string | null {
  if (typeof section.content === "string") return section.content;
  if (typeof section.content === "object" && section.content !== null) {
    if (
      "report" in section.content &&
      typeof section.content.report === "object" &&
      section.content.report !== null &&
      "summary" in section.content.report &&
      typeof section.content.report.summary === "string"
    ) {
      return section.content.report.summary;
    }
    if (
      "summary" in section.content &&
      typeof section.content.summary === "string"
    ) {
      return section.content.summary;
    }
  }
  return null;
}

function initialDraft(section: DeliverableSection): string {
  if (typeof section.reviewerContent === "string")
    return section.reviewerContent;
  return originalDraft(section) ?? "";
}

function httpCitationUrl(evidence: Evidence): string | null {
  if (evidence.kind !== "research") return null;
  const url = new URL(evidence.citation.url);
  return url.protocol === "https:" || url.protocol === "http:"
    ? url.href
    : null;
}

export function ReviewEvidenceWorkspace({
  caseId,
  workspace,
  api,
  selectedEvidenceId,
  onSelectEvidence,
  onDeliverableSaved,
  onApprovalSaved,
}: {
  caseId: string;
  workspace: CaseWorkspace;
  api: WebApiClient;
  selectedEvidenceId: string | null;
  onSelectEvidence: (id: string) => void;
  onDeliverableSaved: (deliverable: Deliverable) => void;
  onApprovalSaved: (approval: Approval) => void;
}) {
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [comments, setComments] = useState<Record<string, string>>({});
  const [approvalNote, setApprovalNote] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sourceUrl, setSourceUrl] = useState<string | null>(null);
  const [sourceText, setSourceText] = useState<string | null>(null);
  const [sourceLoading, setSourceLoading] = useState(false);
  const [sourceError, setSourceError] = useState<string | null>(null);
  const deliverable = [...workspace.deliverables].sort(
    (left, right) =>
      right.createdAt.localeCompare(left.createdAt) ||
      right.version - left.version,
  )[0];
  const selectedEvidence = workspace.evidence.find(
    (item) => item.id === selectedEvidenceId,
  );
  const selectedDocument =
    selectedEvidence?.kind === "document"
      ? workspace.documents.find(
          (document) => document.id === selectedEvidence.documentId,
        )
      : undefined;
  const citationUrl = selectedEvidence
    ? httpCitationUrl(selectedEvidence)
    : null;
  const sourceDocumentId = selectedDocument?.id ?? null;
  const previewMimeType = selectedDocument
    ? sourcePreviewMimeType(selectedDocument)
    : null;

  useEffect(() => {
    setDrafts({});
    setComments({});
    setError(null);
  }, [deliverable?.id]);

  useEffect(() => {
    if (!sourceDocumentId) {
      setSourceUrl(null);
      setSourceText(null);
      setSourceError(null);
      setSourceLoading(false);
      return;
    }
    let active = true;
    let objectUrl: string | null = null;
    setSourceUrl(null);
    setSourceText(null);
    setSourceLoading(true);
    setSourceError(null);
    void api
      .downloadDocument(caseId, sourceDocumentId)
      .then(async (blob) => {
        if (!active) return;
        if (
          previewMimeType === "text/csv" ||
          previewMimeType === "text/plain"
        ) {
          const text = await blob.text();
          if (!active) return;
          setSourceText(text.slice(0, 40_000));
        }
        if (!active) return;
        objectUrl = URL.createObjectURL(
          previewMimeType ? new Blob([blob], { type: previewMimeType }) : blob,
        );
        setSourceUrl(objectUrl);
      })
      .catch((reason: unknown) => {
        if (active) {
          setSourceError(
            reason instanceof Error
              ? reason.message
              : "The source could not be opened.",
          );
        }
      })
      .finally(() => {
        if (active) setSourceLoading(false);
      });
    return () => {
      active = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [api, caseId, sourceDocumentId, previewMimeType]);

  async function saveSection(
    section: DeliverableSection,
    update: {
      reviewerContent?: string;
      reviewStatus?: DeliverableSection["reviewStatus"];
      reviewComment?: string | null;
    },
  ) {
    if (!deliverable || pending) return;
    setPending(true);
    setError(null);
    try {
      const saved = await api.updateDeliverableSection(
        caseId,
        deliverable.id,
        section.id,
        { expectedVersion: deliverable.version, ...update },
      );
      if (update.reviewerContent !== undefined) {
        setDrafts((current) => {
          const next = { ...current };
          delete next[section.id];
          return next;
        });
      }
      if (update.reviewComment !== undefined) {
        setComments((current) => {
          const next = { ...current };
          delete next[section.id];
          return next;
        });
      }
      onDeliverableSaved(saved);
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : "The review changes could not be saved.",
      );
    } finally {
      setPending(false);
    }
  }

  function changedDraft(section: DeliverableSection): string | undefined {
    const draft = drafts[section.id];
    return draft === undefined || draft === initialDraft(section)
      ? undefined
      : draft;
  }

  function hasSectionChanges(section: DeliverableSection): boolean {
    return (
      (drafts[section.id] ?? initialDraft(section)) !== initialDraft(section) ||
      (comments[section.id] ?? section.reviewComment ?? "") !==
        (section.reviewComment ?? "")
    );
  }

  const hasUnsavedChanges =
    deliverable?.sections.some(hasSectionChanges) ?? false;

  async function approve() {
    if (!deliverable || pending) return;
    if (hasUnsavedChanges) {
      setError("Save your section edits and comments before approving.");
      return;
    }
    const unresolved = workspace.findings.flatMap((finding) =>
      finding.openQuestions.filter((question) => question.status === "open"),
    );
    const warning = unresolved.length
      ? `\n\n${unresolved.length} open question(s) will remain unresolved:\n${unresolved.map((question) => `• ${question.text}`).join("\n")}`
      : "";
    if (
      !window.confirm(
        `Approve ${deliverable.title} version ${deliverable.version}?${warning}`,
      )
    ) {
      return;
    }
    setPending(true);
    setError(null);
    try {
      const approval = await api.approveDeliverable(
        caseId,
        deliverable.id,
        deliverable.version,
        approvalNote,
      );
      onApprovalSaved(approval);
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : "The deliverable could not be approved.",
      );
    } finally {
      setPending(false);
    }
  }

  const approval = deliverable
    ? workspace.approvals.find(
        (item) =>
          item.deliverableId === deliverable.id &&
          isApprovalCurrent(item, deliverable),
      )
    : undefined;

  return (
    <section
      id="review-evidence-workspace"
      className="mt-5 grid gap-4 xl:grid-cols-2"
      aria-label="Review and evidence workspace"
    >
      <div className="surface-card p-5">
        <div className="flex items-start gap-3">
          <span className="icon-tile icon-tile-teal">
            <Check size={18} aria-hidden="true" />
          </span>
          <div>
            <h2 className="text-sm font-semibold">Review and approval</h2>
            <p className="mt-1 text-[11px] text-muted-foreground">
              Changes are saved against a deliverable version.
            </p>
          </div>
        </div>
        {deliverable ? (
          <div className="mt-5 space-y-4">
            <div className="rounded-lg border border-border bg-background p-3">
              <p className="text-xs font-semibold">{deliverable.title}</p>
              <p className="mt-1 text-[10px] text-muted-foreground">
                Version {deliverable.version} · {deliverable.format}
              </p>
            </div>
            {deliverable.sections.map((section) => (
              <article
                className="rounded-lg border border-border bg-background p-3"
                key={section.id}
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <h3 className="text-xs font-semibold">{section.title}</h3>
                  <span className="text-[10px] capitalize text-muted-foreground">
                    {section.reviewStatus.replaceAll("-", " ")}
                  </span>
                </div>
                {section.kind === "text" &&
                  (originalDraft(section) !== null ||
                    typeof section.reviewerContent === "string") && (
                    <div className="mt-3 space-y-2">
                      <label className="block text-[10px] text-muted-foreground">
                        Reviewer draft
                        <textarea
                          className="mt-1 min-h-28 w-full rounded-md border border-border bg-surface p-2 text-xs text-foreground"
                          disabled={pending}
                          value={drafts[section.id] ?? initialDraft(section)}
                          onChange={(event) =>
                            setDrafts((current) => ({
                              ...current,
                              [section.id]: event.target.value,
                            }))
                          }
                        />
                      </label>
                      {section.reviewerContent !== null && (
                        <details className="text-[10px] text-muted-foreground">
                          <summary className="cursor-pointer">
                            View original draft
                          </summary>
                          <p className="mt-2 whitespace-pre-wrap">
                            {originalDraft(section)}
                          </p>
                        </details>
                      )}
                      <Button
                        size="sm"
                        variant="secondary"
                        disabled={
                          pending ||
                          changedDraft(section) === undefined ||
                          !drafts[section.id]?.trim()
                        }
                        onClick={() =>
                          void saveSection(section, {
                            reviewerContent: changedDraft(section),
                          })
                        }
                      >
                        Save edit
                      </Button>
                      {section.reviewerContent !== null && (
                        <span className="ml-2 text-[10px] text-info">
                          Edited by reviewer
                        </span>
                      )}
                    </div>
                  )}
                {section.reviewComment && (
                  <p className="mt-2 text-xs text-muted-foreground">
                    Reviewer note: {section.reviewComment}
                  </p>
                )}
                <label className="mt-3 block text-[10px] text-muted-foreground">
                  Review comment
                  <textarea
                    className="mt-1 min-h-16 w-full rounded-md border border-border bg-surface p-2 text-xs text-foreground"
                    disabled={pending}
                    value={comments[section.id] ?? section.reviewComment ?? ""}
                    onChange={(event) =>
                      setComments((current) => ({
                        ...current,
                        [section.id]: event.target.value,
                      }))
                    }
                  />
                </label>
                <div className="mt-2 flex flex-wrap gap-2">
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={
                      pending ||
                      (section.reviewStatus === "accepted" &&
                        !hasSectionChanges(section))
                    }
                    onClick={() =>
                      void saveSection(section, {
                        reviewerContent: changedDraft(section),
                        reviewStatus: "accepted",
                        reviewComment:
                          (
                            comments[section.id] ?? section.reviewComment
                          )?.trim() || null,
                      })
                    }
                  >
                    Approve section
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={
                      pending ||
                      !(comments[section.id] ?? section.reviewComment)?.trim()
                    }
                    onClick={() =>
                      void saveSection(section, {
                        reviewerContent: changedDraft(section),
                        reviewStatus: "changes-requested",
                        reviewComment:
                          (
                            comments[section.id] ?? section.reviewComment
                          )?.trim() ?? "",
                      })
                    }
                  >
                    Needs changes
                  </Button>
                </div>
              </article>
            ))}
            {approval ? (
              <p className="rounded-md border border-success/25 bg-success/[0.05] p-3 text-xs">
                Approved on {new Date(approval.approvedAt).toLocaleString()}.
                {approval.unresolvedQuestionIds.length
                  ? ` ${approval.unresolvedQuestionIds.length} question(s) remain unresolved.`
                  : ""}
              </p>
            ) : (
              <div className="rounded-lg border border-border bg-background p-3">
                <label className="block text-[10px] text-muted-foreground">
                  Approval note (optional)
                  <textarea
                    className="mt-1 min-h-16 w-full rounded-md border border-border bg-surface p-2 text-xs text-foreground"
                    value={approvalNote}
                    onChange={(event) => setApprovalNote(event.target.value)}
                  />
                </label>
                {hasUnsavedChanges && (
                  <p
                    className="mt-2 text-xs text-muted-foreground"
                    role="status"
                  >
                    Save your section edits and comments before approving.
                  </p>
                )}
                <Button
                  className="mt-3"
                  disabled={pending || hasUnsavedChanges}
                  onClick={approve}
                >
                  {pending ? "Saving…" : "Approve deliverable"}
                </Button>
              </div>
            )}
          </div>
        ) : (
          <p className="mt-5 rounded-lg border border-dashed border-border p-4 text-xs text-muted-foreground">
            Deliverables are available for review after analysis completes.
          </p>
        )}
        {error && (
          <p
            className="mt-3 flex items-start gap-2 text-xs text-danger"
            role="alert"
          >
            <CircleAlert size={14} className="mt-0.5 shrink-0" />
            {error}
          </p>
        )}
      </div>

      <div className="surface-card p-5">
        <div className="flex items-start gap-3">
          <span className="icon-tile icon-tile-teal">
            <FileText size={18} aria-hidden="true" />
          </span>
          <div>
            <h2 className="text-sm font-semibold">Evidence viewer</h2>
            <p className="mt-1 text-[11px] text-muted-foreground">
              Select an evidence reference to open its private source.
            </p>
          </div>
        </div>
        {workspace.evidence.length > 0 ? (
          <ul className="mt-4 max-h-40 space-y-1 overflow-auto">
            {workspace.evidence.map((item) => (
              <li key={item.id}>
                <button
                  type="button"
                  className={`w-full rounded-md p-2 text-left text-[11px] hover:bg-muted/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary ${item.id === selectedEvidenceId ? "bg-muted/20" : ""}`}
                  onClick={() => onSelectEvidence(item.id)}
                >
                  <span className="font-medium">
                    {item.kind === "document"
                      ? (workspace.documents.find(
                          (document) => document.id === item.documentId,
                        )?.name ?? item.documentId)
                      : item.citation.title}
                  </span>
                  <span className="mt-1 block text-foreground">
                    {evidenceLocation(item)} · {item.confidence} confidence
                  </span>
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-4 rounded-lg border border-dashed border-border p-4 text-xs text-muted-foreground">
            Evidence references will appear here when the analysis produces
            them.
          </p>
        )}
        {selectedEvidence && (
          <div className="mt-4 border-t border-border pt-4">
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="text-xs font-semibold">
                  {selectedDocument?.name ?? selectedEvidence.sourceRef}
                </p>
                <p className="mt-1 text-[10px] text-muted-foreground">
                  {evidenceLocation(selectedEvidence)}
                </p>
              </div>
              {sourceUrl && selectedDocument && (
                <a
                  className="inline-flex items-center gap-1 text-[10px] text-primary hover:underline"
                  href={sourceUrl}
                  download={selectedDocument.name}
                >
                  <Download size={12} aria-hidden="true" /> Download
                </a>
              )}
            </div>
            {selectedEvidence.kind === "document" &&
              selectedEvidence.location.textQuote && (
                <blockquote className="mt-3 border-l-2 border-primary/40 pl-3 text-xs text-muted-foreground">
                  {selectedEvidence.location.textQuote}
                </blockquote>
              )}
            {selectedEvidence.kind === "research" && (
              <div className="mt-3 space-y-2 text-xs">
                <p className="font-semibold">
                  {selectedEvidence.citation.title}
                </p>
                <p>{selectedEvidence.citation.claim}</p>
                {selectedEvidence.citation.span && (
                  <blockquote className="border-l-2 border-primary/40 pl-3 text-muted-foreground">
                    {selectedEvidence.citation.span}
                  </blockquote>
                )}
              </div>
            )}
            {sourceLoading && (
              <p className="mt-3 text-xs text-muted-foreground" role="status">
                Opening source…
              </p>
            )}
            {sourceError && (
              <p className="mt-3 text-xs text-danger" role="alert">
                {sourceError}
              </p>
            )}
            {sourceUrl &&
              selectedDocument &&
              previewMimeType === "application/pdf" && (
                <iframe
                  className="mt-3 h-[26rem] w-full rounded-md border border-border"
                  src={`${sourceUrl}#page=${selectedEvidence.kind === "document" ? (selectedEvidence.location.page ?? 1) : 1}`}
                  title={`Source document ${selectedDocument.name}`}
                />
              )}
            {sourceUrl &&
              selectedDocument &&
              previewMimeType?.startsWith("image/") && (
                <Image
                  className="mt-3 max-h-[26rem] max-w-full rounded-md border border-border object-contain"
                  src={sourceUrl}
                  alt={`Source document ${selectedDocument.name}`}
                  width={1200}
                  height={900}
                  unoptimized
                  style={{ width: "auto", height: "auto" }}
                />
              )}
            {sourceText !== null && (
              <pre className="mt-3 max-h-[26rem] overflow-auto rounded-md border border-border bg-background p-3 text-[10px]">
                {sourceText}
              </pre>
            )}
            {sourceUrl &&
              selectedDocument &&
              previewMimeType === null &&
              sourceText === null && (
                <p className="mt-3 text-xs text-muted-foreground">
                  This spreadsheet format is available as a private download.
                  The evidence location above identifies the cited cells or
                  rows.
                </p>
              )}
            {citationUrl && (
              <a
                className="mt-3 inline-flex items-center gap-1 text-xs text-primary hover:underline"
                href={citationUrl}
                target="_blank"
                rel="noreferrer"
              >
                Open cited source <ArrowUpRight size={13} aria-hidden="true" />
              </a>
            )}
            <p className="mt-3 flex items-center gap-1 text-[10px] text-muted-foreground">
              <MessageSquareText size={12} aria-hidden="true" />
              {selectedEvidence.confidence} confidence ·{" "}
              {selectedEvidence.sourceRef}
            </p>
          </div>
        )}
      </div>
    </section>
  );
}
