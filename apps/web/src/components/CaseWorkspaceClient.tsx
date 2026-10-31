"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { useAutoAnimate } from "@formkit/auto-animate/react";
import {
  ArrowLeft,
  CircleAlert,
  FileCheck2,
  Play,
  RefreshCw,
  StopCircle,
} from "lucide-react";
import {
  liveWorkflows,
  type Case,
  type RunDto,
  type RunEvent,
} from "@evianta/core";
import type { CaseWorkspace } from "../api/client";
import { formatDate } from "../format";
import { useSession } from "../session/SessionProvider";
import { Button } from "./Button";
import { EmptyState } from "./EmptyState";
import { LoadingSkeleton } from "./LoadingSkeleton";
import { PrivateGate } from "./PrivateGate";
import { StatusBadge, type StatusTone } from "./Badges";
import { DataAnalysisResults } from "./DataAnalysisResults";

const workflowNames: Record<Case["useCase"], string> = {
  "data-analysis": "Data analysis",
  "tax-notice": "Tax notice",
  "msme-payment": "Delayed payment",
};

const eventLabels: Record<RunEvent["payload"]["type"], string> = {
  "run-started": "Analysis started",
  "task-started": "A review task started",
  "task-completed": "A review task completed",
  "task-failed": "A review task needs attention",
  "finding-added": "A finding was added",
  "cost-updated": "Usage estimate updated",
  "run-completed": "Analysis completed",
  "run-failed": "Analysis stopped with an error",
  "run-cancelled": "Analysis cancelled",
  "limit-reached": "Usage limit reached",
  "input-required": "Your input is needed",
};

const terminalStatuses = new Set([
  "completed",
  "partially-completed",
  "failed",
  "cancelled",
  "limit-reached",
  "waiting-for-input",
]);

function statusTone(status: RunDto["status"]): StatusTone {
  if (status === "completed") return "success";
  if (status === "running") return "info";
  if (status === "limit-reached" || status === "waiting-for-input")
    return "warning";
  if (status === "failed" || status === "cancelled") return "danger";
  return "neutral";
}

function formatUsd(value: number): string {
  return new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 4,
  }).format(value);
}

export function CaseWorkspaceClient({ caseId }: { caseId: string }) {
  const { session } = useSession();
  if (!session) return <PrivateGate />;

  return (
    <SessionCaseWorkspace
      key={`${caseId}:${session.accessToken}`}
      caseId={caseId}
    />
  );
}

function SessionCaseWorkspace({ caseId }: { caseId: string }) {
  const [timelineRef] = useAutoAnimate<HTMLOListElement>();
  const { session, api } = useSession();
  const [record, setRecord] = useState<Case | null>(null);
  const [workspace, setWorkspace] = useState<CaseWorkspace | null>(null);
  const [run, setRun] = useState<RunDto | null>(null);
  const [events, setEvents] = useState<RunEvent[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [pendingAction, setPendingAction] = useState(false);
  const [uncertainAction, setUncertainAction] = useState(false);
  const actionInFlight = useRef(false);
  const lastSequence = useRef(0);
  const runId = run?.id;
  const runStatus = run?.status;

  useEffect(() => {
    let active = true;
    setRecord(null);
    setRun(null);
    setEvents([]);
    lastSequence.current = 0;
    setError(null);
    if (!session)
      return () => {
        active = false;
      };

    setLoading(true);
    void Promise.all([api.getCaseWorkspace(caseId), api.getLatestRun(caseId)])
      .then(([caseWorkspace, latestRun]) => {
        if (active) {
          setWorkspace(caseWorkspace);
          setRecord(caseWorkspace.case);
          setRun(latestRun);
        }
      })
      .catch((reason: unknown) => {
        if (active)
          setError(
            reason instanceof Error
              ? reason.message
              : "The case could not be loaded.",
          );
      })
      .finally(() => {
        if (active) setLoading(false);
      });

    return () => {
      active = false;
    };
  }, [api, caseId, session]);

  const preparing = workspace?.documents.some((document) =>
    ["uploaded", "processing"].includes(document.state),
  );
  useEffect(() => {
    if (!preparing || run) return;
    let active = true;
    let timer: number;
    const refresh = async () => {
      try {
        const result = await api.getCaseWorkspace(caseId);
        if (active) setWorkspace(result);
      } catch (reason: unknown) {
        if (active)
          setError(
            `Source preparation could not be refreshed: ${reason instanceof Error ? reason.message : "Request failed."}`,
          );
      } finally {
        if (active) timer = window.setTimeout(() => void refresh(), 2000);
      }
    };
    timer = window.setTimeout(() => void refresh(), 2000);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [api, caseId, preparing, run]);

  useEffect(() => {
    if (!runId || !runStatus || !session) return;
    const replayOnly = terminalStatuses.has(runStatus);
    if (replayOnly && lastSequence.current > 0) return;
    const controller = new AbortController();
    void api
      .streamRunEvents(runId, {
        afterSequence: lastSequence.current,
        caseId,
        replayOnly,
        signal: controller.signal,
        onEvent(event) {
          lastSequence.current = Math.max(lastSequence.current, event.sequence);
          setError(null);
          setEvents((current) =>
            current.some((existing) => existing.sequence === event.sequence)
              ? current
              : [...current, event].slice(-30),
          );
          if (event.payload.type === "run-completed") {
            void api
              .getCaseWorkspace(caseId)
              .then((caseWorkspace) => setWorkspace(caseWorkspace))
              .catch((reason: unknown) => {
                setError(
                  reason instanceof Error
                    ? reason.message
                    : "The completed analysis could not be loaded.",
                );
              });
          }
          if (replayOnly) return;
          setRun((current) => {
            if (!current) return current;
            switch (event.payload.type) {
              case "run-started":
                return {
                  ...current,
                  status: "running",
                  updatedAt: event.occurredAt,
                };
              case "run-completed":
                return {
                  ...current,
                  status: "completed",
                  updatedAt: event.occurredAt,
                };
              case "run-failed":
                return {
                  ...current,
                  status: "failed",
                  updatedAt: event.occurredAt,
                };
              case "run-cancelled":
                return {
                  ...current,
                  status: "cancelled",
                  updatedAt: event.occurredAt,
                };
              case "limit-reached":
                return {
                  ...current,
                  status: "limit-reached",
                  updatedAt: event.occurredAt,
                };
              case "input-required":
                return {
                  ...current,
                  status: "waiting-for-input",
                  inputRequired: true,
                  updatedAt: event.occurredAt,
                };
              case "cost-updated":
                return {
                  ...current,
                  usage: event.payload.usage,
                  updatedAt: event.occurredAt,
                };
              default:
                return current;
            }
          });
        },
        onResync() {
          setError(
            "Some progress events were missed. The stream is resynchronizing.",
          );
        },
      })
      .catch((reason: unknown) => {
        if (!controller.signal.aborted) {
          setError(
            reason instanceof Error
              ? reason.message
              : "The progress stream disconnected.",
          );
        }
      });
    return () => controller.abort();
  }, [api, caseId, runId, runStatus, session]);

  async function startRun() {
    if (!record || actionInFlight.current || uncertainAction) return;
    actionInFlight.current = true;
    setError(null);
    setPendingAction(true);
    try {
      const created = await api.startRun(record.id);
      setEvents([]);
      lastSequence.current = 0;
      setRun(created);
    } catch (reason) {
      setUncertainAction(true);
      try {
        const latest = await api.getLatestRun(record.id);
        if (latest && latest.id !== run?.id) {
          setEvents([]);
          lastSequence.current = 0;
          setRun(latest);
          setUncertainAction(false);
        } else {
          setError(
            `${reason instanceof Error ? reason.message : "Analysis could not be started."} No new run was confirmed. Reopen the case to check before trying again.`,
          );
        }
      } catch (lookupError) {
        setError(
          `Run outcome could not be checked: ${lookupError instanceof Error ? lookupError.message : "Request failed."} Reopen the case after reconnecting; this request will not be sent again.`,
        );
      }
    } finally {
      setPendingAction(false);
      actionInFlight.current = false;
    }
  }

  async function cancelRun() {
    if (
      !run ||
      !window.confirm(
        "Cancel this analysis? Work already completed will remain available.",
      )
    ) {
      return;
    }
    setError(null);
    setPendingAction(true);
    try {
      setRun(await api.cancelRun(run.id));
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : "The run could not be cancelled.",
      );
    } finally {
      setPendingAction(false);
    }
  }

  async function retryRun() {
    if (!run) return;
    setError(null);
    setPendingAction(true);
    try {
      const retried = await api.retryRun(run.id);
      setEvents([]);
      lastSequence.current = 0;
      setRun(retried);
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : "The run could not be retried.",
      );
    } finally {
      setPendingAction(false);
    }
  }

  if (!session) return <PrivateGate />;

  if (loading) {
    return <LoadingSkeleton rows={4} />;
  }

  if (error && !record) {
    return (
      <div className="reading-column">
        <Link
          href="/cases"
          className="inline-flex items-center gap-2 text-xs text-muted-foreground"
        >
          <ArrowLeft size={14} aria-hidden="true" /> Your cases
        </Link>
        <div className="surface-card mt-6 p-5" role="alert">
          <p className="text-sm font-semibold text-danger">
            This case could not be loaded.
          </p>
          <p className="mt-2 text-xs text-muted-foreground">{error}</p>
        </div>
      </div>
    );
  }

  if (!record) return null;

  const activeRun = run
    ? ["running", "queued", "waiting-for-input"].includes(run.status)
    : false;
  const canRetry =
    run && (run.status === "failed" || run.status === "partially-completed");
  const canStartAnalysis =
    liveWorkflows.includes(record.useCase) &&
    !preparing &&
    Boolean(
      workspace?.documents.some((document) => document.state === "ready"),
    );

  return (
    <div>
      <Link
        href="/cases"
        className="inline-flex items-center gap-2 text-xs text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft size={14} aria-hidden="true" /> Your cases
      </Link>
      <div className="mt-6 flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <StatusBadge>{workflowNames[record.useCase]}</StatusBadge>
            <StatusBadge tone="success">Private case</StatusBadge>
          </div>
          <h1 className="page-title mt-3">{record.title}</h1>
          <p className="page-description">
            {record.description || "No case description provided."}
          </p>
          <p className="mt-3 text-[11px] text-muted-foreground">
            Updated {formatDate(record.updatedAt)}
          </p>
        </div>
        {!run ? (
          <Button
            onClick={startRun}
            disabled={pendingAction || uncertainAction || !canStartAnalysis}
          >
            <Play size={15} aria-hidden="true" />
            {pendingAction ? "Starting..." : "Start analysis"}
          </Button>
        ) : activeRun ? (
          <Button variant="danger" onClick={cancelRun} disabled={pendingAction}>
            <StopCircle size={15} aria-hidden="true" />
            Cancel run
          </Button>
        ) : canRetry ? (
          <Button
            variant="secondary"
            onClick={retryRun}
            disabled={pendingAction}
          >
            <RefreshCw size={15} aria-hidden="true" />
            Retry analysis
          </Button>
        ) : (
          <Button
            variant="secondary"
            onClick={startRun}
            disabled={pendingAction || uncertainAction || !canStartAnalysis}
          >
            <RefreshCw size={15} aria-hidden="true" />
            Run again
          </Button>
        )}
      </div>

      {workspace && workspace.documents.length > 0 && (
        <section
          className="surface-card mt-5 p-4"
          aria-labelledby="source-files-heading"
        >
          <h2 id="source-files-heading" className="text-xs font-semibold">
            Source files
          </h2>
          <ul className="mt-3 divide-y divide-border">
            {workspace.documents.map((document) => (
              <li
                className="flex flex-wrap items-center justify-between gap-2 py-2 text-xs"
                key={document.id}
              >
                <span className="font-medium">{document.name}</span>
                <StatusBadge
                  tone={
                    document.state === "ready"
                      ? "success"
                      : document.state === "failed"
                        ? "danger"
                        : "neutral"
                  }
                >
                  {document.state}
                </StatusBadge>
              </li>
            ))}
          </ul>
        </section>
      )}
      {!canStartAnalysis && (
        <p className="mt-3 text-xs text-muted-foreground" role="status">
          {!liveWorkflows.includes(record.useCase)
            ? "Coming next. This workflow is not available for live work."
            : preparing
              ? "Reading source files. Start analysis here when preparation finishes."
              : "Upload and finish processing a CSV or Excel file before starting analysis."}
        </p>
      )}

      {error && (
        <div
          className="mt-5 flex items-start gap-2 rounded-lg border border-warning/25 bg-warning/[0.06] p-3 text-xs text-warning"
          role="status"
        >
          <CircleAlert
            size={15}
            className="mt-0.5 shrink-0"
            aria-hidden="true"
          />
          {error}
        </div>
      )}

      <div className="mt-7 grid gap-5 lg:grid-cols-[minmax(0,1.3fr)_minmax(260px,0.7fr)]">
        <section
          className="surface-card overflow-hidden"
          aria-labelledby="run-progress-heading"
        >
          <div className="flex items-center justify-between gap-3 border-b border-border px-5 py-4">
            <div>
              <h2 id="run-progress-heading" className="text-sm font-semibold">
                Progress and decisions
              </h2>
              <p className="mt-1 text-[11px] text-muted-foreground">
                Typed updates from the run stream
              </p>
            </div>
            {run ? (
              <StatusBadge tone={statusTone(run.status)}>
                {run.status.replaceAll("-", " ")}
              </StatusBadge>
            ) : (
              <StatusBadge>Not started</StatusBadge>
            )}
          </div>
          {run ? (
            <div className="p-5">
              <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg bg-background p-4">
                <div>
                  <p className="text-xs font-medium">Run {run.id}</p>
                  <p className="mt-1 text-[10px] text-muted-foreground">
                    Plan version {run.planVersion} · Updated{" "}
                    {formatDate(run.updatedAt)}
                  </p>
                </div>
                <p className="mono-number text-xs">
                  {run.usage.costStatus === "unknown"
                    ? "Cost unknown"
                    : run.usage.costUsd === null
                      ? "Cost pending"
                      : formatUsd(run.usage.costUsd)}
                </p>
              </div>
              {run.status === "limit-reached" && (
                <p className="mt-4 rounded-md bg-warning/10 p-3 text-xs text-warning">
                  The usage limit was reached. Completed work is preserved;
                  review the usage details before retrying.
                </p>
              )}
              {run.status === "waiting-for-input" && (
                <p className="mt-4 rounded-md bg-info/10 p-3 text-xs text-info">
                  The workflow needs your input before it can continue.
                </p>
              )}
              {events.length > 0 ? (
                <ol
                  className="timeline mt-6"
                  aria-label="Run event timeline"
                  ref={timelineRef}
                >
                  {[...events].reverse().map((event) => (
                    <li className="timeline-item" key={event.id}>
                      <p className="text-xs font-medium">
                        {eventLabels[event.payload.type]}
                      </p>
                      <p className="mt-1 text-[10px] text-muted-foreground">
                        {formatDate(event.occurredAt)} · Event {event.sequence}
                      </p>
                    </li>
                  ))}
                </ol>
              ) : (
                <p className="mt-5 text-xs text-muted-foreground">
                  {activeRun
                    ? "Waiting for the first progress event…"
                    : "No progress events were recorded for this run."}
                </p>
              )}
              {canRetry && (
                <p className="mt-2 flex items-center gap-2 text-[11px] text-muted-foreground">
                  <RefreshCw size={13} aria-hidden="true" />
                  Retrying keeps work already completed by the prior run.
                </p>
              )}
            </div>
          ) : (
            <EmptyState
              icon={Play}
              title="Analysis has not started"
              description="Start a run when the case context and source records are ready."
            />
          )}
        </section>

        <section
          className="surface-card p-5"
          aria-labelledby="findings-heading"
        >
          <div className="flex items-center gap-3">
            <span className="icon-tile icon-tile-teal">
              <FileCheck2 size={18} aria-hidden="true" />
            </span>
            <div>
              <h2 id="findings-heading" className="text-sm font-semibold">
                Findings and evidence
              </h2>
              <p className="mt-1 text-[11px] text-muted-foreground">
                Source links stay visible
              </p>
            </div>
          </div>
          {record.useCase === "data-analysis" ? (
            <DataAnalysisResults workspace={workspace} />
          ) : (
            <div className="mt-5 rounded-lg border border-dashed border-border p-4">
              <p className="text-xs font-medium">
                {events.some((event) => event.payload.type === "finding-added")
                  ? "Finding events received"
                  : "No findings to review yet"}
              </p>
              <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
                Findings appear here only after they are returned by the
                authenticated API. This page does not invent private results.
              </p>
            </div>
          )}
          <div className="mt-4 grid grid-cols-2 gap-2">
            <div className="rounded-md bg-background p-3">
              <p className="text-[10px] text-muted-foreground">Input tokens</p>
              <p className="mono-number mt-1 text-sm">
                {run?.usage.inputUnits ?? "—"}
              </p>
            </div>
            <div className="rounded-md bg-background p-3">
              <p className="text-[10px] text-muted-foreground">Output tokens</p>
              <p className="mono-number mt-1 text-sm">
                {run?.usage.outputUnits ?? "—"}
              </p>
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}
