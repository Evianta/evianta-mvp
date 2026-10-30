"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, type FormEvent } from "react";
import {
  Activity,
  ArrowUp,
  ChartNoAxesCombined,
  FileText,
  FileUp,
  Landmark,
  Trash2,
} from "lucide-react";
import {
  UseCaseSchema,
  liveWorkflows,
  type DocumentMetadataDto,
  type IntakeConfiguration,
  type SyntheticWorkflowFixture,
  type UseCase,
} from "@evianta/core";
import {
  deriveIntakeOpenQuestions,
  formatFileSize,
  intakeCaseDetails,
  starterPrompts,
  validateUploadFile,
  workflowSpecs,
} from "../intake";
import { ApiError } from "../api/errors";
import { useSession } from "../session/SessionProvider";
import { useAccessKeyDialog } from "./AccessKeyDialogProvider";
import { Button } from "./Button";
import { StatusBadge } from "./Badges";

interface SelectedDocument {
  file: File;
  state: "selected" | "uploading" | DocumentMetadataDto["state"];
  retryable: boolean;
}

const stateLabels = {
  selected: "Selected",
  uploading: "Uploading",
  uploaded: "Uploaded",
  processing: "Reading",
  ready: "Ready",
  partial: "Partly read",
  failed: "Failed",
};

function isRejected(reason: unknown): boolean {
  return (
    reason instanceof ApiError &&
    reason.status >= 400 &&
    reason.status < 500 &&
    reason.status !== 408
  );
}

export function CaseIntake({
  sourceSample,
}: {
  sourceSample?: SyntheticWorkflowFixture;
}) {
  const { session } = useSession();
  const [suggestion, setSuggestion] = useState<UseCase | null>(null);
  const previousSession = useRef(session);
  useEffect(() => {
    if (previousSession.current && previousSession.current !== session)
      setSuggestion(null);
    previousSession.current = session;
  }, [session]);

  return (
    <TaskComposer
      key={session?.accessToken ?? "preview"}
      sourceSample={sourceSample}
      initialSuggestion={suggestion}
      onPreviewSuggestion={setSuggestion}
    />
  );
}

function TaskComposer({
  sourceSample,
  initialSuggestion,
  onPreviewSuggestion,
}: {
  sourceSample?: SyntheticWorkflowFixture;
  initialSuggestion: UseCase | null;
  onPreviewSuggestion: (workflow: UseCase) => void;
}) {
  const { session, api } = useSession();
  const { openAccessKeyDialog } = useAccessKeyDialog();
  const router = useRouter();
  const [useCase, setUseCase] = useState<UseCase | "">(
    sourceSample?.case.useCase ?? initialSuggestion ?? "",
  );
  const [prompt, setPrompt] = useState(
    session && sourceSample
      ? sourceSample.case.description
      : initialSuggestion
        ? starterPrompts[initialSuggestion]
        : "",
  );
  const [title, setTitle] = useState(
    session && sourceSample ? `${sourceSample.case.title} (copy)` : "",
  );
  const [files, setFiles] = useState<SelectedDocument[]>([]);
  const [configuration, setConfiguration] =
    useState<IntakeConfiguration | null>(null);
  const [configurationAttempt, setConfigurationAttempt] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [phase, setPhase] = useState("");
  const [pending, setPending] = useState(false);
  const [createdCaseId, setCreatedCaseId] = useState<string | null>(null);
  const [uncertain, setUncertain] = useState(false);
  const [possibleCases, setPossibleCases] = useState<string[]>([]);
  const active = useRef(true);
  const inFlight = useRef(false);
  const composing = useRef(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const spec = useCase ? workflowSpecs[useCase] : null;
  const available = Boolean(
    useCase && configuration?.workflows.includes(useCase),
  );
  const frozen = pending || Boolean(createdCaseId) || uncertain;
  const openQuestions = useCase
    ? deriveIntakeOpenQuestions(
        useCase,
        files.map(({ file }) => file.name),
      )
    : [];

  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);

  useEffect(() => {
    if (!session) return;
    let current = true;
    setError(null);
    void api
      .getIntakeConfiguration()
      .then((result) => {
        if (current) setConfiguration(result);
      })
      .catch((reason: unknown) => {
        if (current)
          setError(
            `Task settings could not be loaded: ${reason instanceof Error ? reason.message : "Request failed."}`,
          );
      });
    return () => {
      current = false;
    };
  }, [api, session, configurationAttempt]);

  function chooseSuggestion(workflow: UseCase) {
    if (
      session &&
      prompt.trim() &&
      prompt !== starterPrompts[workflow] &&
      !window.confirm("Replace your current prompt with this suggestion?")
    )
      return;
    setUseCase(workflow);
    setPrompt(starterPrompts[workflow]);
    setError(null);
    if (!session) onPreviewSuggestion(workflow);
    else inputRef.current?.focus();
  }

  function chooseFiles(selected: File[]) {
    if (!session || !spec || !configuration || pending || uncertain) return;
    if (files.length + selected.length > configuration.uploadMaxFiles) {
      setError(
        `Select at most ${configuration.uploadMaxFiles} files for this task.`,
      );
      return;
    }
    const limits = {
      ...spec,
      maxFileBytes: Math.min(spec.maxFileBytes, configuration.uploadMaxBytes),
    };
    const invalid = selected
      .map((file) => validateUploadFile(file, limits))
      .find(Boolean);
    if (invalid) {
      setError(invalid);
      return;
    }
    setError(null);
    setFiles((current) => [
      ...current,
      ...selected.map(
        (file): SelectedDocument => ({
          file,
          state: "selected",
          retryable: false,
        }),
      ),
    ]);
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!session || inFlight.current || uncertain) return;
    setError(null);
    if (!useCase || !available || !configuration || !spec) {
      setError(
        useCase
          ? "This workflow is coming next and cannot start live work."
          : "Choose a workflow before starting.",
      );
      return;
    }
    const details = intakeCaseDetails(prompt, title);
    if (!prompt.trim() || !details.success) {
      setError(
        "Enter a task prompt of up to 5,000 characters and an optional title of up to 200 characters.",
      );
      return;
    }
    if (!files.length) {
      setError(
        "Attach a CSV or Excel source dataset before starting data analysis.",
      );
      return;
    }
    const invalid = files
      .map(({ file }) =>
        validateUploadFile(file, {
          ...spec,
          maxFileBytes: Math.min(
            spec.maxFileBytes,
            configuration.uploadMaxBytes,
          ),
        }),
      )
      .find(Boolean);
    if (invalid || files.length > configuration.uploadMaxFiles) {
      setError(
        invalid ??
          `Select at most ${configuration.uploadMaxFiles} files for this task.`,
      );
      return;
    }
    inFlight.current = true;
    setPending(true);
    let caseId = createdCaseId;
    try {
      if (!caseId) {
        setPhase("Creating case...");
        try {
          const created = await api.createCase({
            ...details.data,
            useCase,
            sourceCaseId: sourceSample?.case.id ?? null,
          });
          if (!active.current) return;
          caseId = created.id;
          setCreatedCaseId(caseId);
        } catch (reason) {
          if (!active.current) return;
          if (!isRejected(reason)) {
            setUncertain(true);
            setPhase("Case creation outcome is uncertain.");
            // Creation has no idempotency key. Never infer ownership of a matching concurrent draft.
            try {
              const cases = await api.listCases();
              if (!active.current) return;
              setPossibleCases(
                cases
                  .filter(
                    (record) =>
                      record.title === details.data.title &&
                      record.description === prompt &&
                      record.useCase === useCase,
                  )
                  .map((record) => record.id),
              );
            } catch (lookupError) {
              if (!active.current) return;
              throw new Error(
                `Creation could not be confirmed, and Cases could not be checked: ${lookupError instanceof Error ? lookupError.message : "Request failed."} Do not submit again; check Cases after reconnecting.`,
              );
            }
            throw new Error(
              "Case creation could not be confirmed. Check Cases before starting another task; this request will not be sent again.",
            );
          }
          throw reason;
        }
      }

      for (const item of files) {
        if (item.state !== "selected" && !item.retryable) continue;
        setPhase(`Uploading and reading ${item.file.name}...`);
        setFiles((current) =>
          current.map((entry) =>
            entry === item ? { ...entry, state: "uploading" } : entry,
          ),
        );
        let document: DocumentMetadataDto;
        try {
          document = await api.uploadDocument(caseId, item.file, "mixed");
          if (!active.current) return;
        } catch (reason) {
          if (!active.current) return;
          const retryable = isRejected(reason);
          setFiles((current) =>
            current.map((entry) =>
              entry.file === item.file
                ? { ...entry, state: "failed", retryable }
                : entry,
            ),
          );
          if (!retryable) {
            setUncertain(true);
            const workspace = await api.getCaseWorkspace(caseId);
            if (!active.current) return;
            const stored = workspace.documents.some(
              (entry) =>
                entry.name === item.file.name &&
                entry.sizeBytes === item.file.size,
            );
            throw new Error(
              stored
                ? "The upload response was lost, but a matching document is stored. Open the created case to check its reading status. It will not be uploaded again."
                : "The upload outcome cannot be established. Open the created case to check before uploading again.",
            );
          }
          throw reason;
        }
        setFiles((current) =>
          current.map((entry) =>
            entry.file === item.file
              ? { ...entry, state: document.state, retryable: false }
              : entry,
          ),
        );
        if (document.state === "failed" || document.state === "partial") {
          throw new Error(
            `${item.file.name} could not be fully read. Open the created case to inspect the source before continuing. Successful uploads are kept.`,
          );
        }
      }

      setPhase("Checking source readiness...");
      const workspace = await api.getCaseWorkspace(caseId);
      if (!active.current) return;
      if (
        workspace.documents.some((document) =>
          ["failed", "partial"].includes(document.state),
        )
      ) {
        throw new Error(
          "A source document could not be fully read. Open the created case to review it before starting.",
        );
      }
      if (
        !workspace.documents.length ||
        workspace.documents.some((document) => document.state !== "ready")
      ) {
        setPhase(
          "Sources are still being prepared. Start analysis in the case when ready.",
        );
        router.push(`/cases/${caseId}`);
        return;
      }
      setPhase("Ready. Starting task...");
      setUncertain(true);
      try {
        await api.startRun(caseId);
        if (!active.current) return;
      } catch (reason) {
        if (!active.current) return;
        // A lost response can still mean admission succeeded, even if execution already finished.
        const latest = await api.getLatestRun(caseId);
        if (!active.current) return;
        if (!latest) {
          setUncertain(true);
          throw new Error(
            `The run was not confirmed: ${reason instanceof Error ? reason.message : "Request failed."} Open the created case to check and recover; Start task will not dispatch again.`,
          );
        }
      }
      router.push(`/cases/${caseId}`);
    } catch (reason) {
      if (!active.current) return;
      setPhase("Task needs attention.");
      setError(
        `${caseId ? "Case created. " : ""}${reason instanceof Error ? reason.message : "The task could not be started."}`,
      );
    } finally {
      if (active.current) {
        setPending(false);
        inFlight.current = false;
      }
    }
  }

  return (
    <section
      className="task-entry reading-column"
      aria-labelledby="task-heading"
    >
      <div className="task-entry-heading">
        <span className="brand-mark mx-auto mb-4">
          <Activity size={23} aria-hidden="true" />
        </span>
        <h1 id="task-heading" className="page-title">
          What would you like to work on?
        </h1>
        <p className="page-description">
          Describe the task and attach your records. Follow progress, results
          and evidence in a private case.
        </p>
      </div>
      {sourceSample && (
        <div className="surface-card mt-5 p-4 text-sm">
          <p className="font-medium">Copying a synthetic workflow</p>
          <p className="mt-1 text-xs text-muted-foreground">
            Only the workflow setup for "{sourceSample.case.title}" is copied.
            The public sample stays read-only; its files and results are not
            copied.
          </p>
          <Link
            className="mt-2 inline-block text-xs text-primary underline"
            href={`/samples/${sourceSample.case.id}`}
          >
            Back to sample
          </Link>
        </div>
      )}
      <form className="mt-7 space-y-4" onSubmit={submit} aria-busy={pending}>
        <div
          className="task-composer"
          onDragOver={(event) => event.preventDefault()}
          onDrop={(event) => {
            event.preventDefault();
            if (available) chooseFiles(Array.from(event.dataTransfer.files));
          }}
        >
          <div className="px-5 pt-4">
            <label htmlFor="task-prompt" className="field-label">
              Task prompt
            </label>
            <textarea
              ref={inputRef}
              id="task-prompt"
              className="task-prompt"
              rows={3}
              value={prompt}
              disabled={!session || frozen}
              onChange={(event) => setPrompt(event.target.value)}
              placeholder="Describe what you want to understand or prepare..."
              aria-describedby="prompt-help"
              onCompositionStart={() => {
                composing.current = true;
              }}
              onCompositionEnd={() => {
                composing.current = false;
              }}
              onKeyDown={(event) => {
                if (
                  event.key === "Enter" &&
                  !event.shiftKey &&
                  !event.nativeEvent.isComposing &&
                  !composing.current &&
                  event.nativeEvent.keyCode !== 229
                ) {
                  event.preventDefault();
                  event.currentTarget.form?.requestSubmit();
                }
              }}
            />
          </div>
          <div className="task-composer-toolbar">
            <div className="min-w-0 flex-1">
              <label htmlFor="workflow" className="field-label">
                Workflow
              </label>
              <select
                id="workflow"
                className="select-input !w-auto max-w-full !rounded-full !py-1.5 !text-xs"
                value={useCase}
                disabled={!session || frozen}
                onChange={(event) => {
                  const parsed = UseCaseSchema.safeParse(event.target.value);
                  setUseCase(parsed.success ? parsed.data : "");
                }}
              >
                <option value="">Choose a workflow</option>
                {(Object.keys(workflowSpecs) as UseCase[]).map((workflow) => (
                  <option key={workflow} value={workflow}>
                    {workflowSpecs[workflow].label}
                    {!liveWorkflows.includes(workflow) ? " - Coming next" : ""}
                  </option>
                ))}
              </select>
            </div>
            <label className="task-attachment" htmlFor="case-files">
              <FileUp size={15} aria-hidden="true" /> Files
              <input
                id="case-files"
                className="sr-only"
                aria-label="Attach records"
                aria-describedby="accepted-files"
                type="file"
                multiple
                disabled={!session || !available || pending || uncertain}
                accept={
                  spec
                    ? [
                        ...spec.allowedExtensions,
                        ...spec.allowedMimeTypes,
                      ].join(",")
                    : undefined
                }
                onChange={(event) => {
                  chooseFiles(Array.from(event.target.files ?? []));
                  event.target.value = "";
                }}
              />
            </label>
            <Button
              type="submit"
              className="!rounded-full"
              disabled={
                !session || pending || uncertain || !available || !prompt.trim()
              }
            >
              {pending
                ? "Starting task..."
                : createdCaseId
                  ? "Resume task setup"
                  : "Start task"}
              <ArrowUp size={16} aria-hidden="true" />
            </Button>
          </div>
          {files.length > 0 && (
            <ul
              aria-label="Selected documents"
              className="mx-5 divide-y divide-border border-t border-border"
              aria-live="polite"
            >
              {files.map(({ file, state, retryable }, index) => (
                <li
                  className="flex flex-wrap items-center gap-2 py-2 text-xs"
                  key={index}
                >
                  <span className="min-w-0 flex-1 break-all">{file.name}</span>
                  <StatusBadge
                    tone={
                      state === "ready"
                        ? "success"
                        : state === "failed"
                          ? "danger"
                          : "neutral"
                    }
                  >
                    {stateLabels[state]}
                  </StatusBadge>
                  {retryable && (
                    <Button
                      size="sm"
                      variant="secondary"
                      disabled={pending || uncertain}
                      onClick={(event) =>
                        event.currentTarget.form?.requestSubmit()
                      }
                    >
                      Retry {file.name}
                    </Button>
                  )}
                  <button
                    type="button"
                    className="icon-button"
                    aria-label={`Remove ${file.name}`}
                    disabled={
                      pending ||
                      uncertain ||
                      (Boolean(createdCaseId) &&
                        state !== "selected" &&
                        !retryable &&
                        state !== "failed" &&
                        state !== "partial")
                    }
                    onClick={() =>
                      setFiles((current) =>
                        current.filter((_, position) => position !== index),
                      )
                    }
                  >
                    <Trash2 size={16} aria-hidden="true" />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
        <div className="task-suggestions" aria-label="Starter suggestions">
          {(Object.keys(starterPrompts) as UseCase[]).map((workflow) => {
            const Icon =
              workflow === "data-analysis"
                ? ChartNoAxesCombined
                : workflow === "tax-notice"
                  ? FileText
                  : Landmark;
            return (
              <button
                key={workflow}
                type="button"
                className="task-suggestion"
                title={starterPrompts[workflow]}
                disabled={frozen}
                onClick={() => chooseSuggestion(workflow)}
                aria-pressed={useCase === workflow}
              >
                <Icon size={14} className="text-primary" aria-hidden="true" />
                {workflowSpecs[workflow].label}
                {!liveWorkflows.includes(workflow) && (
                  <span className="text-warning">Coming next</span>
                )}
              </button>
            );
          })}
        </div>
        {useCase && !liveWorkflows.includes(useCase) && (
          <p className="text-center text-xs text-warning" role="status">
            Coming next. This workflow cannot start live work yet.
          </p>
        )}
        <p
          id="prompt-help"
          className="text-center text-[11px] text-muted-foreground"
        >
          Enter to start. Shift+Enter for a new line. Up to 5,000 characters.
        </p>
        <p
          id="accepted-files"
          className="text-center text-[11px] text-muted-foreground"
        >
          {spec
            ? spec.allowedExtensions.join(", ")
            : "Choose a workflow to see accepted files"}
          {configuration && spec && (
            <>
              {" "}
              / Up to{" "}
              {formatFileSize(
                Math.min(spec.maxFileBytes, configuration.uploadMaxBytes),
              )}{" "}
              per file; {configuration.uploadMaxFiles} files per task
            </>
          )}
          {spec?.allowedMimeTypes.includes("application/pdf") && (
            <>
              {" "}
              / PDF files are limited to{" "}
              {Math.min(
                spec.maxPdfPages,
                configuration?.documentMaxPages ?? spec.maxPdfPages,
              )}{" "}
              pages.
            </>
          )}
        </p>
        <details>
          <summary className="cursor-pointer text-xs font-medium">
            Recommended documents and optional case details
          </summary>
          <div className="mt-4 space-y-3">
            <label htmlFor="case-title" className="field-label">
              Case title (optional)
            </label>
            <input
              id="case-title"
              className="text-input"
              value={title}
              disabled={!session || frozen}
              onChange={(event) => setTitle(event.target.value)}
            />
            <p className="mx-auto max-w-xl text-center text-[11px] leading-relaxed text-muted-foreground">
              Otherwise named from the first nonempty prompt line, up to 200
              characters.
            </p>
            {spec && (
              <p className="text-xs">
                Required to run: {spec.requiredDocuments.join(", ")}.
              </p>
            )}
            <p className="text-center text-xs text-muted-foreground">
              {openQuestions.length} optional documents suggested. These
              suggestions do not block starting.
            </p>
            <ul className="space-y-1 text-xs text-muted-foreground">
              {openQuestions.map((question) => (
                <li key={question.id}>{question.text}</li>
              ))}
            </ul>
          </div>
        </details>
        <p className="text-xs text-muted-foreground">
          Start task creates a private case, uploads and reads your files, and
          starts work when ready. Extraction and execution may use paid models
          under your existing limits.
        </p>
        {!session && (
          <p className="text-xs text-muted-foreground">
            Sign in before entering private prompts or selecting files. Only
            your selected static suggestion is kept through sign-in.
          </p>
        )}
        {error && (
          <div
            role="alert"
            className="rounded-lg border border-danger/20 bg-danger/[0.05] p-3 text-sm text-danger"
          >
            {error}
            {createdCaseId && (
              <Link
                className="mt-2 block font-medium underline"
                href={`/cases/${createdCaseId}`}
              >
                Open created case
              </Link>
            )}
            {uncertain && !createdCaseId && (
              <Link className="mt-2 block underline" href="/cases">
                Check Cases
              </Link>
            )}
            {possibleCases.map((id) => (
              <Link
                className="mt-2 block underline"
                key={id}
                href={`/cases/${id}`}
              >
                Inspect matching case
              </Link>
            ))}
          </div>
        )}
        <p className="text-center text-xs text-muted-foreground" role="status">
          {phase ||
            (session && !configuration ? "Loading task settings..." : "")}
        </p>
        <div className="flex flex-wrap justify-center gap-3">
          {session && !configuration && error && (
            <Button
              variant="secondary"
              onClick={() => setConfigurationAttempt((attempt) => attempt + 1)}
            >
              Retry task settings
            </Button>
          )}
          {!session && (
            <Button variant="secondary" onClick={() => openAccessKeyDialog()}>
              Enter access key
            </Button>
          )}
        </div>
      </form>
    </section>
  );
}
