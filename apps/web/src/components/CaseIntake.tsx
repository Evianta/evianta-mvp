"use client";

import Link from "next/link";
import Image from "next/image";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, type FormEvent } from "react";
import {
  ArrowUp,
  ChartNoAxesCombined,
  FileText,
  FileUp,
  Landmark,
  Trash2,
} from "lucide-react";
import {
  liveWorkflows,
  type DocumentMetadataDto,
  type IntakeConfiguration,
  type SyntheticWorkflowFixture,
  type UseCase,
} from "@evianta/core";
import {
  inferIntakeWorkflow,
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
  header?: string;
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
  const { session, api, signOutPending } = useSession();
  const { openAccessKeyDialog } = useAccessKeyDialog();
  const router = useRouter();
  const [selectedWorkflow, setSelectedWorkflow] = useState<UseCase | null>(
    sourceSample?.case.useCase ?? initialSuggestion,
  );
  const [prompt, setPrompt] = useState(
    session && sourceSample
      ? sourceSample.case.description
      : initialSuggestion
        ? starterPrompts[initialSuggestion]
        : "",
  );
  const [files, setFiles] = useState<SelectedDocument[]>([]);
  const [readingFiles, setReadingFiles] = useState(false);
  const [needsSelection, setNeedsSelection] = useState(false);
  const [createdWorkflow, setCreatedWorkflow] = useState<UseCase | null>(null);
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
  const fileReadInFlight = useRef(false);
  const inferredWorkflow = inferIntakeWorkflow(
    prompt,
    files.map(({ file, header }) => ({ name: file.name, header })),
  );
  const useCase = createdWorkflow ?? selectedWorkflow ?? inferredWorkflow;
  const spec = useCase ? workflowSpecs[useCase] : null;
  const available = Boolean(
    useCase && configuration?.workflows.includes(useCase),
  );
  const frozen = pending || readingFiles || Boolean(createdCaseId) || uncertain;
  const acceptedExtensions = [
    ...new Set(
      Object.values(workflowSpecs).flatMap(
        (workflow) => workflow.allowedExtensions,
      ),
    ),
  ];
  const acceptedMimeTypes = [
    ...new Set(
      Object.values(workflowSpecs).flatMap(
        (workflow) => workflow.allowedMimeTypes,
      ),
    ),
  ];

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
    setSelectedWorkflow(workflow);
    setNeedsSelection(false);
    setPrompt(starterPrompts[workflow]);
    setError(null);
    if (!session) onPreviewSuggestion(workflow);
    else inputRef.current?.focus();
  }

  async function chooseFiles(selected: File[]) {
    if (!selected.length) return;
    if (
      !session ||
      !configuration ||
      pending ||
      uncertain ||
      fileReadInFlight.current
    )
      return;
    if (files.length + selected.length > configuration.uploadMaxFiles) {
      setError(
        `Select at most ${configuration.uploadMaxFiles} files for this task.`,
      );
      return;
    }
    const limits = {
      ...workflowSpecs["data-analysis"],
      allowedMimeTypes: acceptedMimeTypes,
      maxFileBytes: configuration.uploadMaxBytes,
    };
    const invalid = selected
      .map((file) => validateUploadFile(file, limits))
      .find(Boolean);
    if (invalid) {
      setError(invalid);
      return;
    }
    setError(null);
    setReadingFiles(true);
    fileReadInFlight.current = true;
    try {
      const documents = await Promise.all(
        selected.map(
          async (file): Promise<SelectedDocument> => ({
            file,
            header: file.name.toLowerCase().endsWith(".csv")
              ? (await file.slice(0, 8192).text())
                  .split(/\r?\n/, 1)[0]
                  .replaceAll(/[_-]/g, " ")
              : undefined,
            state: "selected",
            retryable: false,
          }),
        ),
      );
      if (!active.current) return;
      setFiles((current) => [...current, ...documents]);
      if (!createdCaseId) setSelectedWorkflow(null);
      setNeedsSelection(false);
    } catch (reason) {
      if (active.current)
        setError(
          `An attachment could not be read: ${reason instanceof Error ? reason.message : "Try selecting the file again."}`,
        );
    } finally {
      if (active.current) setReadingFiles(false);
      fileReadInFlight.current = false;
    }
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!session || inFlight.current || fileReadInFlight.current || uncertain)
      return;
    setError(null);
    if (!useCase) {
      setNeedsSelection(true);
      setError(
        "I could not identify a single workflow from this message and its attachments. Choose the type of work below.",
      );
      return;
    }
    if (!available || !configuration || !spec) {
      setError(
        useCase
          ? "This workflow is coming next and cannot start live work."
          : "Choose a workflow before starting.",
      );
      return;
    }
    const details = intakeCaseDetails(prompt, "");
    if (!prompt.trim() || !details.success) {
      setError("Enter a task prompt of up to 5,000 characters.");
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
          setCreatedWorkflow(useCase);
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
        <Image
          src="/logo.svg"
          alt=""
          width={44}
          height={44}
          className="mx-auto mb-4"
          priority
        />
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
            void chooseFiles(Array.from(event.dataTransfer.files));
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
              onChange={(event) => {
                setPrompt(event.target.value);
                setSelectedWorkflow(null);
                setNeedsSelection(false);
                setError(null);
              }}
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
            <label className="task-attachment" htmlFor="case-files">
              <FileUp size={15} aria-hidden="true" /> Files
              <input
                id="case-files"
                className="sr-only"
                aria-label="Attach records"
                aria-describedby="accepted-files"
                type="file"
                multiple
                disabled={
                  !session ||
                  !configuration ||
                  pending ||
                  readingFiles ||
                  uncertain
                }
                accept={[...acceptedExtensions, ...acceptedMimeTypes].join(",")}
                onChange={(event) => {
                  void chooseFiles(Array.from(event.target.files ?? []));
                  event.target.value = "";
                }}
              />
            </label>
            <Button
              type="submit"
              className="ml-auto !rounded-full"
              disabled={
                !session ||
                pending ||
                readingFiles ||
                uncertain ||
                !configuration ||
                (Boolean(useCase) && !available) ||
                !prompt.trim()
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
                    onClick={() => {
                      setFiles((current) =>
                        current.filter((_, position) => position !== index),
                      );
                      if (!createdCaseId) setSelectedWorkflow(null);
                      setNeedsSelection(false);
                    }}
                  >
                    <Trash2 size={16} aria-hidden="true" />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
        {needsSelection && (
          <fieldset className="surface-card space-y-3 p-4">
            <legend className="px-1 text-sm font-medium">
              Which type of work did you mean?
            </legend>
            <p className="text-xs text-muted-foreground">
              Your message and files will stay as they are. No case is created
              until you choose Start task.
            </p>
            <div className="flex flex-wrap gap-2">
              {(Object.keys(workflowSpecs) as UseCase[]).map((workflow) => (
                <Button
                  key={workflow}
                  variant="secondary"
                  size="sm"
                  onClick={() => {
                    setSelectedWorkflow(workflow);
                    setNeedsSelection(false);
                    setError(null);
                  }}
                >
                  Choose {workflowSpecs[workflow].label}
                  {!liveWorkflows.includes(workflow) ? " - Coming next" : ""}
                </Button>
              ))}
            </div>
          </fieldset>
        )}
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
        {useCase && (
          <p
            className="text-center text-xs text-muted-foreground"
            role="status"
          >
            {selectedWorkflow || createdWorkflow ? "Selected" : "Detected"}:{" "}
            {workflowSpecs[useCase].label}.
            {!liveWorkflows.includes(useCase) &&
              " Coming next. This workflow cannot start live work yet."}
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
          {acceptedExtensions.join(", ")}
          {configuration && (
            <>
              {" "}
              / Up to {formatFileSize(configuration.uploadMaxBytes)} per file;{" "}
              {configuration.uploadMaxFiles} files per task
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
            (readingFiles
              ? "Checking attachment headers..."
              : session && !configuration
                ? "Loading task settings..."
                : "")}
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
            <Button
              variant="secondary"
              disabled={signOutPending}
              onClick={() => openAccessKeyDialog()}
            >
              Enter access key
            </Button>
          )}
        </div>
      </form>
    </section>
  );
}
