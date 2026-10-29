"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  useEffect,
  useRef,
  useMemo,
  useState,
  type ChangeEvent,
  type DragEvent,
  type FormEvent,
} from "react";
import {
  ArrowLeft,
  ArrowRight,
  FileUp,
  Info,
  ListChecks,
  Plus,
  Trash2,
} from "lucide-react";
import {
  ExtractionMethodSchema,
  UseCaseSchema,
  type DocumentMetadataDto,
  type DocumentState,
  type ExtractionMethod,
  type SyntheticWorkflowFixture,
  type UseCase,
} from "@evianta/core";
import {
  deriveIntakeOpenQuestions,
  validateUploadFile,
  workflowSpecs,
} from "../intake";
import { useSession } from "../session/SessionProvider";
import { Button } from "./Button";
import { PrivateGate } from "./PrivateGate";
import { StatusBadge } from "./Badges";

interface SelectedDocument {
  file: File;
  state: "selected" | "uploading" | DocumentState;
  uploadFailed: boolean;
}

const documentStateLabels: Record<SelectedDocument["state"], string> = {
  selected: "Selected",
  uploading: "Uploading",
  uploaded: "Uploaded",
  processing: "Reading",
  ready: "Ready",
  failed: "Failed",
};

export function CaseIntake({
  sourceSample,
}: {
  sourceSample?: SyntheticWorkflowFixture;
}) {
  const { session } = useSession();

  if (!session) {
    return (
      <div className="reading-column">
        <p className="page-eyebrow">New private case</p>
        <h1 className="page-title">Start with the context.</h1>
        <p className="page-description">
          {sourceSample
            ? `You are preparing a private copy of “${sourceSample.case.title}”. The public sample will remain read-only.`
            : "Choose a workflow and add the records you want to review. Your private files are never part of a public sample."}
        </p>
        <PrivateGate />
      </div>
    );
  }

  return (
    <SessionCaseIntake key={session.accessToken} sourceSample={sourceSample} />
  );
}

function SessionCaseIntake({
  sourceSample,
}: {
  sourceSample?: SyntheticWorkflowFixture;
}) {
  const { api } = useSession();
  const router = useRouter();
  const [useCase, setUseCase] = useState<UseCase>(
    sourceSample?.case.useCase ?? "msme-payment",
  );
  const [title, setTitle] = useState(
    sourceSample ? `${sourceSample.case.title} (copy)` : "",
  );
  const [description, setDescription] = useState(
    sourceSample?.case.description ?? "",
  );
  const [files, setFiles] = useState<SelectedDocument[]>([]);
  const [extractionMethod, setExtractionMethod] =
    useState<ExtractionMethod>("mixed");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [createdCaseId, setCreatedCaseId] = useState<string | null>(null);
  const active = useRef(true);
  const spec = workflowSpecs[useCase];

  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  const openQuestions = useMemo(
    () =>
      deriveIntakeOpenQuestions(
        useCase,
        files.map(({ file }) => file.name),
      ),
    [files, useCase],
  );

  function chooseFiles(event: ChangeEvent<HTMLInputElement>) {
    const selected = Array.from(event.target.files ?? []);
    const invalid = selected.find((file) => validateUploadFile(file, spec));
    if (invalid) {
      setError(validateUploadFile(invalid, spec));
      event.target.value = "";
      return;
    }
    setError(null);
    setFiles((current) => [
      ...current,
      ...selected.map((file): SelectedDocument => ({
        file,
        state: "selected",
        uploadFailed: false,
      })),
    ]);
    event.target.value = "";
  }

  function dropFiles(event: DragEvent<HTMLLabelElement>) {
    event.preventDefault();
    const selected = Array.from(event.dataTransfer.files);
    const invalid = selected.find((file) => validateUploadFile(file, spec));
    if (invalid) {
      setError(validateUploadFile(invalid, spec));
      return;
    }
    setError(null);
    setFiles((current) => [
      ...current,
      ...selected.map((file): SelectedDocument => ({
        file,
        state: "selected",
        uploadFailed: false,
      })),
    ]);
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    const invalidFile = files.find(({ file }) =>
      validateUploadFile(file, spec),
    );
    if (invalidFile) {
      setError(validateUploadFile(invalidFile.file, spec));
      return;
    }
    setPending(true);
    let createdId = createdCaseId;
    try {
      if (!createdId) {
        const created = await api.createCase({
          title: title.trim(),
          description: description.trim(),
          useCase,
          sourceCaseId: sourceSample?.case.id ?? null,
        });
        if (!active.current) return;
        createdId = created.id;
        setCreatedCaseId(created.id);
      }
      if (!createdId) {
        throw new Error("The case could not be created.");
      }
      for (const { file, state, uploadFailed } of files) {
        if (state !== "selected" && !uploadFailed) continue;
        setFiles((current) =>
          current.map((item) =>
            item.file === file ? { ...item, state: "uploading" } : item,
          ),
        );
        let document: DocumentMetadataDto;
        try {
          document = await api.uploadDocument(
            createdId,
            file,
            extractionMethod,
          );
          if (!active.current) return;
        } catch (reason) {
          if (!active.current) return;
          setFiles((current) =>
            current.map((item) =>
              item.file === file
                ? { ...item, state: "failed", uploadFailed: true }
                : item,
            ),
          );
          throw reason;
        }
        setFiles((current) =>
          current.map((item) =>
            item.file === file
              ? { ...item, state: document.state, uploadFailed: false }
              : item,
          ),
        );
      }
      router.push(`/cases/${createdId}`);
    } catch (reason) {
      if (!active.current) return;
      const detail =
        reason instanceof Error
          ? reason.message
          : "The case could not be created.";
      setError(
        createdId
          ? `Case created, but an upload did not finish: ${detail}`
          : detail,
      );
    } finally {
      if (active.current) setPending(false);
    }
  }

  return (
    <div className="reading-column">
      <Link
        href={sourceSample ? `/samples/${sourceSample.case.id}` : "/cases"}
        className="inline-flex items-center gap-2 text-xs text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft size={14} aria-hidden="true" />
        {sourceSample ? "Back to sample" : "Your cases"}
      </Link>
      <div className="mt-7">
        <p className="page-eyebrow">Private case intake</p>
        <h1 className="page-title">Start with the context.</h1>
        <p className="page-description">
          Give the case a clear purpose, then add the records that should inform
          the review.
        </p>
      </div>

      {sourceSample && (
        <div className="mt-5 flex items-start gap-3 rounded-lg border border-info/20 bg-info/[0.05] p-4">
          <Info
            size={17}
            className="mt-0.5 shrink-0 text-info"
            aria-hidden="true"
          />
          <div>
            <p className="text-sm font-medium">Copying a synthetic workflow</p>
            <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
              Only the workflow setup is copied. The sample’s synthetic files
              and results are not copied into your private case.
            </p>
          </div>
        </div>
      )}

      <form className="mt-6 space-y-5" onSubmit={submit}>
        <section
          className="surface-card space-y-4 p-5 sm:p-6"
          aria-labelledby="case-context"
        >
          <div>
            <h2 id="case-context" className="text-sm font-semibold">
              Case context
            </h2>
            <p className="mt-1 text-xs text-muted-foreground">
              Keep it specific. You can update these details later.
            </p>
          </div>
          <div>
            <label className="field-label" htmlFor="case-title">
              Case title
            </label>
            <input
              className="text-input"
              id="case-title"
              maxLength={200}
              value={title}
              disabled={Boolean(createdCaseId)}
              onChange={(event) => setTitle(event.target.value)}
              placeholder="For example, Q4 vendor payment review"
              required
            />
            <p className="mt-1 text-right text-[10px] text-muted-foreground">
              {title.length}/200
            </p>
          </div>
          <div>
            <label className="field-label" htmlFor="workflow">
              Workflow
            </label>
            <select
              className="select-input"
              id="workflow"
              value={useCase}
              disabled={Boolean(createdCaseId)}
              onChange={(event) => {
                const parsed = UseCaseSchema.safeParse(event.target.value);
                if (parsed.success) setUseCase(parsed.data);
              }}
            >
              {(["data-analysis", "tax-notice", "msme-payment"] as const).map(
                (key) => (
                  <option key={key} value={key}>
                    {workflowSpecs[key].label}
                  </option>
                ),
              )}
            </select>
            <p className="mt-2 text-xs text-muted-foreground">{spec.summary}</p>
          </div>
          <div>
            <label className="field-label" htmlFor="extraction-method">
              Extraction method
            </label>
            <select
              className="select-input"
              id="extraction-method"
              value={extractionMethod}
              onChange={(event) => {
                const parsed = ExtractionMethodSchema.safeParse(
                  event.target.value,
                );
                if (parsed.success) setExtractionMethod(parsed.data);
              }}
            >
              <option value="mixed">Automatic selection</option>
              <option value="parse">Structured data parsing</option>
              <option value="pdf-text">Document text extraction</option>
              <option value="ocr">OCR</option>
              <option value="handwriting">Handwriting recognition</option>
            </select>
            <p className="mt-2 text-xs text-muted-foreground">
              OCR and handwriting recognition may need additional review.
            </p>
          </div>
          <div>
            <label className="field-label" htmlFor="case-description">
              What should the review answer?
            </label>
            <textarea
              className="text-area"
              id="case-description"
              maxLength={5000}
              value={description}
              disabled={Boolean(createdCaseId)}
              onChange={(event) => setDescription(event.target.value)}
              placeholder="Add the question, period, parties, or other relevant context."
            />
          </div>
        </section>

        <section
          className="surface-card p-5 sm:p-6"
          aria-labelledby="document-checklist"
        >
          <div className="flex items-start justify-between gap-3">
            <div>
              <h2 id="document-checklist" className="text-sm font-semibold">
                Document checklist
              </h2>
              <p className="mt-1 text-xs text-muted-foreground">
                Missing recommended documents become open questions, not
                blockers.
              </p>
            </div>
            <ListChecks
              size={18}
              className="text-muted-foreground"
              aria-hidden="true"
            />
          </div>
          <div className="mt-4 grid gap-2 sm:grid-cols-2">
            {spec.requiredDocuments.map((document) => (
              <div
                className="flex items-center justify-between gap-3 rounded-md bg-background px-3 py-2.5"
                key={document}
              >
                <span className="text-xs">{document}</span>
                <StatusBadge tone="warning">Needed</StatusBadge>
              </div>
            ))}
            {spec.recommendedDocuments.map((document) => (
              <div
                className="flex items-center justify-between gap-3 rounded-md bg-background px-3 py-2.5"
                key={document}
              >
                <span className="text-xs">{document}</span>
                <StatusBadge>Recommended</StatusBadge>
              </div>
            ))}
          </div>
          <label
            className="dropzone relative mt-5 cursor-pointer"
            htmlFor="case-files"
            onDragOver={(event) => event.preventDefault()}
            onDrop={dropFiles}
          >
            <span>
              <span className="empty-state-icon mx-auto">
                <FileUp size={20} aria-hidden="true" />
              </span>
              <span className="mt-3 block text-sm font-medium">
                Drop records here or browse
              </span>
              <span className="mt-1 block text-xs text-muted-foreground">
                {spec.allowedMimeTypes
                  .map((type) => type.split("/").at(-1))
                  .join(", ")}{" "}
                · Up to {Math.round(spec.maxFileBytes / (1024 * 1024))} MB per
                file
              </span>
              <span className="mt-1 block text-[10px] text-muted-foreground">
                PDF files are limited to {spec.maxPdfPages} pages; page count is
                verified during processing.
              </span>
            </span>
            <input
              id="case-files"
              type="file"
              multiple
              accept={spec.allowedMimeTypes.join(",")}
              onChange={chooseFiles}
            />
          </label>
          {files.length > 0 && (
            <ul
              className="mt-3 divide-y divide-border"
              aria-label="Selected documents"
            >
              {files.map(({ file, state }, index) => (
                <li
                  className="flex items-center gap-3 py-2"
                  key={`${file.name}-${index}`}
                >
                  <FileUp
                    size={15}
                    className="text-muted-foreground"
                    aria-hidden="true"
                  />
                  <span className="min-w-0 flex-1 truncate text-xs">
                    {file.name}
                  </span>
                  <StatusBadge
                    tone={
                      state === "ready"
                        ? "success"
                        : state === "failed"
                          ? "danger"
                          : state === "processing" || state === "uploading"
                            ? "info"
                            : "neutral"
                    }
                  >
                    {documentStateLabels[state]}
                  </StatusBadge>
                  <span className="mono-number text-[10px] text-muted-foreground">
                    {(file.size / (1024 * 1024)).toFixed(1)} MB
                  </span>
                  <button
                    className="icon-button h-8 w-8"
                    type="button"
                    aria-label={`Remove ${file.name}`}
                    onClick={() =>
                      setFiles((current) =>
                        current.filter((_, itemIndex) => itemIndex !== index),
                      )
                    }
                  >
                    <Trash2 size={14} aria-hidden="true" />
                  </button>
                </li>
              ))}
            </ul>
          )}
          {openQuestions.length > 0 && (
            <div className="mt-4 rounded-lg border border-warning/20 bg-warning/[0.045] p-4">
              <div className="flex items-center gap-2 text-xs font-semibold text-warning">
                <Info size={15} aria-hidden="true" />
                {openQuestions.length} open{" "}
                {openQuestions.length === 1 ? "question" : "questions"} to
                resolve
              </div>
              <ul className="mt-2 space-y-1.5 pl-5 text-xs text-muted-foreground">
                {openQuestions.map((question) => (
                  <li className="list-disc" key={question.id}>
                    {question.text}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </section>

        {error && (
          <div
            className="rounded-lg border border-danger/20 bg-danger/[0.05] p-4 text-sm text-danger"
            role="alert"
          >
            {error}
            {createdCaseId && (
              <Link
                className="ml-2 inline-flex items-center gap-1 font-semibold underline"
                href={`/cases/${createdCaseId}`}
              >
                Open created case <ArrowRight size={13} aria-hidden="true" />
              </Link>
            )}
          </div>
        )}

        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-[11px] text-muted-foreground">
            {createdCaseId
              ? "The case already exists. Retrying sends only documents that have not uploaded successfully."
              : "Uploads go to private storage. No analysis starts until you choose to run it."}
          </p>
          <Button type="submit" disabled={pending || !title.trim()}>
            {pending
              ? createdCaseId
                ? "Uploading documents..."
                : "Creating case..."
              : createdCaseId
                ? "Retry remaining uploads"
                : "Create private case"}
            {!pending && <Plus size={15} aria-hidden="true" />}
          </Button>
        </div>
      </form>
    </div>
  );
}
