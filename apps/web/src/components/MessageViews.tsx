"use client";

import Link from "next/link";
import {
  ArrowRight,
  CircleAlert,
  CircleCheck,
  CircleDashed,
  CircleX,
  FileText,
  KeyRound,
  LoaderCircle,
  Paperclip,
  Square,
} from "lucide-react";
import type { UseCase } from "@evianta/core";
import { workflowBlurbs, workflowLabels } from "../chat/analysis";
import {
  formatCost,
  isTerminalStatus,
  type ProgressState,
} from "../chat/narration";
import type { ResultSummary } from "../chat/results";
import type {
  ChatMessage,
  InspectTarget,
  NoticeAction,
  StepStatus,
} from "../chat/types";
import { formatFileSize } from "../intake";
import { AgentAvatar } from "./AgentAvatar";
import { Button } from "./Button";
import { Chip, type ChipTone } from "./Chip";
import { StreamedText } from "./StreamedText";

export interface MessageContext {
  progressFor: (runId: string) => ProgressState | null;
  resultFor: (runId: string) => ResultSummary | null;
  findingTitlesFor: (caseId: string) => Record<string, string>;
  isActiveRun: (runId: string) => boolean;
  busy: boolean;
  signedIn: boolean;
  onSignIn: () => void;
  onChooseWorkflow: (messageId: string, workflow: UseCase) => void;
  onAttach: () => void;
  onSkipSlot: (messageId: string, slotId: string, label: string) => void;
  onAnswer: (messageId: string, answer: string) => void;
  onStop: () => void;
  onNoticeAction: (action: NoticeAction) => void;
  onInspect: (target: InspectTarget, caseId?: string) => void;
}

const severityTone: Record<string, ChipTone> = {
  high: "danger",
  medium: "warning",
  low: "neutral",
  info: "neutral",
};

function StepIcon({ status }: { status: StepStatus }) {
  if (status === "done")
    return (
      <CircleCheck size={16} className="text-success" aria-hidden="true" />
    );
  if (status === "failed")
    return <CircleX size={16} className="text-danger" aria-hidden="true" />;
  if (status === "active")
    return (
      <LoaderCircle
        size={16}
        className="animate-spin text-primary"
        aria-hidden="true"
      />
    );
  return (
    <CircleDashed
      size={16}
      className="text-muted-foreground"
      aria-hidden="true"
    />
  );
}

export function EviantaFrame({
  children,
  wide = false,
}: {
  children: React.ReactNode;
  wide?: boolean;
}) {
  return (
    <div className="msg msg-evianta">
      <AgentAvatar role="coordinator" name="Evianta" size="sm" />
      <div className={wide ? "msg-body msg-body-wide" : "msg-body"}>
        <p className="msg-author">Evianta</p>
        {children}
      </div>
    </div>
  );
}

export function MessageView({
  message,
  context,
}: {
  message: ChatMessage;
  context: MessageContext;
}) {
  if (message.from === "user") {
    return (
      <div className="msg msg-user">
        <div className="msg-user-bubble">
          {message.files.length > 0 && (
            <ul className="msg-user-files" aria-label="Attached files">
              {message.files.map((file, index) => (
                <li key={`${file.name}-${index}`}>
                  <Chip
                    icon={<Paperclip size={13} aria-hidden="true" />}
                    title={formatFileSize(file.size)}
                    onClick={() =>
                      context.onInspect({
                        kind: "document",
                        id: null,
                        name: file.name,
                      })
                    }
                  >
                    {file.name}
                  </Chip>
                </li>
              ))}
            </ul>
          )}
          {message.text && (
            <p className="whitespace-pre-wrap">{message.text}</p>
          )}
        </div>
      </div>
    );
  }

  switch (message.type) {
    case "text":
      return (
        <EviantaFrame>
          <StreamedText
            text={message.text}
            animate={message.animate}
            className="msg-text"
          />
        </EviantaFrame>
      );
    case "sign-in":
      return (
        <EviantaFrame>
          <div className="card-inline">
            <p className="msg-text">
              To work on this privately, I need your access key first. Your
              message and files stay right here until you are in.
            </p>
            {context.signedIn ? (
              <p className="mt-3 flex items-center gap-2 text-sm text-success">
                <CircleCheck size={16} aria-hidden="true" /> Signed in
              </p>
            ) : (
              <Button className="mt-3" onClick={context.onSignIn}>
                <KeyRound size={16} aria-hidden="true" /> Enter access key
              </Button>
            )}
          </div>
        </EviantaFrame>
      );
    case "workflow-choice":
      return (
        <EviantaFrame>
          <div className="card-inline">
            <p className="msg-text">
              I could not tell which type of work you mean. Which of these
              should I do?
            </p>
            <ul className="choice-list">
              {message.options.map((workflow) => (
                <li key={workflow}>
                  <button
                    type="button"
                    className="choice-option"
                    data-chosen={
                      message.chosen === workflow ? "true" : undefined
                    }
                    disabled={Boolean(message.chosen) || context.busy}
                    onClick={() =>
                      context.onChooseWorkflow(message.id, workflow)
                    }
                  >
                    <span className="text-sm font-medium">
                      {workflowLabels[workflow]}
                    </span>
                    <span className="mt-0.5 block text-xs text-muted-foreground">
                      {workflowBlurbs[workflow]}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        </EviantaFrame>
      );
    case "missing-document":
      return (
        <EviantaFrame>
          <div className="card-inline">
            <p className="msg-text">
              I still need {message.label}. {message.hint}
            </p>
            {message.resolved ? (
              <p className="mt-3 text-sm text-muted-foreground">
                {message.resolved === "attached"
                  ? "Thanks, I have it."
                  : "Understood. I will note it as not available."}
              </p>
            ) : (
              <div className="mt-3 flex flex-wrap gap-2">
                <Button size="sm" onClick={context.onAttach}>
                  <Paperclip size={15} aria-hidden="true" /> Attach a file
                </Button>
                {message.skippable && (
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() =>
                      context.onSkipSlot(
                        message.id,
                        message.slotId,
                        message.label,
                      )
                    }
                  >
                    I do not have it
                  </Button>
                )}
              </div>
            )}
          </div>
        </EviantaFrame>
      );
    case "question":
      return (
        <EviantaFrame>
          <div className="card-inline">
            <p className="msg-text">{message.text}</p>
            {message.answered ? (
              <p className="mt-3 text-sm text-muted-foreground">
                Noted: {message.answered}
              </p>
            ) : (
              <>
                {message.chips.length > 0 && (
                  <ul className="mt-3 flex flex-wrap gap-2">
                    {message.chips.map((chip) => (
                      <li key={chip}>
                        <Chip
                          tone="teal"
                          onClick={() => context.onAnswer(message.id, chip)}
                        >
                          {chip}
                        </Chip>
                      </li>
                    ))}
                  </ul>
                )}
                <p className="mt-3 text-xs text-muted-foreground">
                  {message.hint ?? "Type your answer below."}
                </p>
              </>
            )}
          </div>
        </EviantaFrame>
      );
    case "setup":
      return (
        <EviantaFrame wide>
          <ol className="setup-list" aria-label="Task setup">
            {message.steps.map((step) => (
              <li key={step.id} data-status={step.status}>
                <StepIcon status={step.status} />
                <span className="min-w-0 flex-1">
                  <span className="block text-sm">{step.label}</span>
                  {step.detail && (
                    <span className="block text-xs text-muted-foreground">
                      {step.detail}
                    </span>
                  )}
                </span>
              </li>
            ))}
          </ol>
        </EviantaFrame>
      );
    case "progress":
      return (
        <EviantaFrame wide>
          <ProgressCard context={context} runId={message.runId} />
        </EviantaFrame>
      );
    case "result":
      return (
        <EviantaFrame wide>
          <ResultCard context={context} runId={message.runId} />
        </EviantaFrame>
      );
    case "notice":
      return (
        <EviantaFrame>
          <div className={`card-inline notice-${message.tone}`} role="status">
            <p className="msg-text flex items-start gap-2">
              <CircleAlert
                size={16}
                className="mt-0.5 shrink-0"
                aria-hidden="true"
              />
              <span>{message.text}</span>
            </p>
            {message.action && (
              <Button
                className="mt-3"
                size="sm"
                variant="secondary"
                onClick={() =>
                  message.action && context.onNoticeAction(message.action)
                }
              >
                {message.action.kind === "open-case"
                  ? "Open the case"
                  : message.action.kind === "open-cases"
                    ? "Check your cases"
                    : message.action.kind === "retry"
                      ? "Try again"
                      : "Start a new task"}
              </Button>
            )}
          </div>
        </EviantaFrame>
      );
  }
}

function ProgressCard({
  context,
  runId,
}: {
  context: MessageContext;
  runId: string;
}) {
  const progress = context.progressFor(runId);
  if (!progress) return null;
  const titles = context.findingTitlesFor(progress.caseId);
  const finished = isTerminalStatus(progress.status);
  const running = !finished && progress.status !== "waiting-for-input";
  const latest = progress.lines.at(-1);
  return (
    <div className="card-inline progress-card" aria-live="polite">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm font-medium">
          {progress.status === "waiting-for-input"
            ? "Waiting for your answer"
            : finished
              ? "Work finished"
              : "Working on your task"}
        </p>
        <div className="flex items-center gap-3">
          <span className="mono-number text-xs text-muted-foreground">
            {formatCost(progress.costUsd, progress.costUnknown)}
          </span>
          {running && context.isActiveRun(runId) && (
            <Button size="sm" variant="secondary" onClick={context.onStop}>
              <Square size={13} aria-hidden="true" /> Stop
            </Button>
          )}
        </div>
      </div>
      {progress.roster.length > 0 && (
        <ul className="roster" aria-label="Team">
          {progress.roster.map((entry) => (
            <li key={entry.role}>
              <button
                type="button"
                className="roster-chip"
                data-state={entry.state}
                onClick={() =>
                  context.onInspect(
                    { kind: "agent", role: entry.role },
                    progress.caseId,
                  )
                }
                aria-label={`${entry.name}, ${entry.state}. Show profile`}
              >
                <AgentAvatar role={entry.role} name={entry.name} size="sm" />
                <span className="min-w-0">
                  <span className="block truncate text-xs font-medium">
                    {entry.name}
                  </span>
                  <span className="block text-xs text-muted-foreground">
                    {entry.state === "working"
                      ? "Working"
                      : entry.state === "done"
                        ? "Done"
                        : "Needs attention"}
                  </span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {latest && (
        <p className="mt-3 text-sm text-muted-foreground">{latest.text}</p>
      )}
      {!latest && running && (
        <p className="mt-3 text-sm text-muted-foreground">Getting started...</p>
      )}
      {progress.findingIds.length > 0 && (
        <div className="mt-3">
          <p className="text-xs font-medium text-muted-foreground">
            {finished ? "Findings" : "Findings so far"}
          </p>
          <ul className="mt-2 flex flex-wrap gap-2">
            {progress.findingIds.map((id) => (
              <li key={id}>
                <Chip
                  tone="teal"
                  icon={<FileText size={13} aria-hidden="true" />}
                  onClick={() =>
                    context.onInspect({ kind: "finding", id }, progress.caseId)
                  }
                >
                  {titles[id] ?? "New finding"}
                </Chip>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function ResultCard({
  context,
  runId,
}: {
  context: MessageContext;
  runId: string;
}) {
  const result = context.resultFor(runId);
  const progress = context.progressFor(runId);
  if (!result || !progress) return null;
  const usage = result.usage;
  return (
    <div className="card-inline result-card">
      <p className="text-xs font-semibold uppercase tracking-wide text-primary">
        Result
      </p>
      <StreamedText
        text={result.headline}
        animate
        className="mt-2 text-base font-medium leading-relaxed"
      />
      <dl className="result-metrics">
        <div>
          <dt>Findings</dt>
          <dd className="mono-number">{result.totalFindings}</dd>
        </div>
        <div>
          <dt>Open questions</dt>
          <dd className="mono-number">{result.openQuestions}</dd>
        </div>
        <div>
          <dt>Sources</dt>
          <dd className="mono-number">{result.sourceCount}</dd>
        </div>
        <div>
          <dt>Usage</dt>
          <dd className="mono-number">
            {usage
              ? formatCost(usage.costUsd, usage.costStatus === "unknown")
              : "-"}
          </dd>
        </div>
      </dl>
      {result.findings.length > 0 && (
        <div className="mt-4">
          <p className="text-xs font-medium text-muted-foreground">
            Top findings
          </p>
          <ul className="mt-2 flex flex-col gap-2">
            {result.findings.map((finding) => (
              <li key={finding.id}>
                <button
                  type="button"
                  className="finding-row"
                  onClick={() =>
                    context.onInspect({ kind: "finding", id: finding.id })
                  }
                >
                  <Chip tone={severityTone[finding.severity] ?? "neutral"}>
                    {finding.severity}
                  </Chip>
                  <span className="min-w-0 flex-1 text-left text-sm">
                    {finding.title}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {finding.evidenceCount}{" "}
                    {finding.evidenceCount === 1 ? "source" : "sources"}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
      {result.deliverables.length > 0 && (
        <div className="mt-4">
          <p className="text-xs font-medium text-muted-foreground">
            Deliverables
          </p>
          <ul className="mt-2 flex flex-wrap gap-2">
            {result.deliverables.map((deliverable) => (
              <li key={deliverable.id}>
                <Chip
                  tone="success"
                  icon={<FileText size={13} aria-hidden="true" />}
                  onClick={() =>
                    context.onInspect({
                      kind: "deliverable",
                      id: deliverable.id,
                    })
                  }
                >
                  {deliverable.title}
                </Chip>
              </li>
            ))}
          </ul>
        </div>
      )}
      <div className="mt-5 flex flex-wrap items-center justify-between gap-3">
        <p className="max-w-md text-xs text-muted-foreground">
          This is prepared work for professional review, not a final
          determination.
        </p>
        <Link
          href={`/cases/${encodeURIComponent(progress.caseId)}`}
          className="button-link bg-primary text-primary-foreground shadow-soft"
        >
          Open full details <ArrowRight size={14} aria-hidden="true" />
        </Link>
      </div>
    </div>
  );
}
