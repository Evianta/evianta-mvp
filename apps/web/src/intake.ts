import { CreateCaseRequestSchema, type UseCase } from "@evianta/core";

export const starterPrompts: Record<UseCase, string> = {
  "data-analysis":
    "Analyze my sales spreadsheet, highlight trends and anomalies, and create a dashboard.",
  "tax-notice":
    "Help me review an income-tax notice, reconcile the records, and prepare a response for professional review.",
  "msme-payment":
    "Reconcile my invoices and payments, identify overdue amounts, and prepare a follow-up case pack.",
};

export interface IntakeAttachmentHint {
  name: string;
  header?: string;
}

const workflowSignals: Record<UseCase, RegExp> = {
  "data-analysis":
    /\b(sales|revenue|dashboard|data\s+analysis|analy[sz]e.{0,30}(?:data|spreadsheet)|dataset|trends|anomalies)\b/i,
  "tax-notice":
    /\b(tax|tds|itr|ais|form\s*26as|intimation|assessment|143\s*\(\s*1\s*\)|income.tax)\b/i,
  "msme-payment":
    /\b(msme|invoice|invoices|overdue|delayed.payment|payment|payments|receivable|receivables)\b/i,
};

export function matchingWorkflows(
  prompt: string,
  attachments: IntakeAttachmentHint[],
): UseCase[] {
  const text = [
    prompt,
    ...attachments.map(({ name, header }) =>
      `${name} ${header ?? ""}`.replaceAll(/[_-]/g, " "),
    ),
  ].join("\n");
  return (Object.keys(workflowSignals) as UseCase[]).filter((workflow) =>
    workflowSignals[workflow].test(text),
  );
}

export function inferIntakeWorkflow(
  prompt: string,
  attachments: IntakeAttachmentHint[],
): UseCase | null {
  const matches = matchingWorkflows(prompt, attachments);
  return matches.length === 1 ? matches[0] : null;
}

export function intakeCaseDetails(prompt: string, title: string) {
  const derivedTitle =
    prompt
      .split(/\r?\n/)
      .find((line) => line.trim())
      ?.trim()
      .slice(0, 200) ?? "";
  return CreateCaseRequestSchema.pick({
    title: true,
    description: true,
  }).safeParse({
    title: title.trim() || derivedTitle,
    description: prompt,
  });
}

export interface WorkflowSpec {
  label: string;
  summary: string;
  requiredDocuments: string[];
  recommendedDocuments: string[];
  maxFileBytes: number;
  maxPdfPages: number;
  allowedExtensions: string[];
  allowedMimeTypes: string[];
}

const attachmentMimeTypes: Record<string, string> = {
  ".csv": "text/csv",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".pdf": "application/pdf",
  ".xls": "application/vnd.ms-excel",
  ".tsv": "text/tab-separated-values",
  ".tab": "text/tab-separated-values",
  ".json": "application/json",
  ".txt": "text/plain",
  ".text": "text/plain",
  ".md": "text/markdown",
  ".markdown": "text/markdown",
};
const allowedExtensions = Object.keys(attachmentMimeTypes);
const allowedMimeTypes = [...new Set(Object.values(attachmentMimeTypes))];
const tabularSourceExtensions = new Set([
  ".csv",
  ".tsv",
  ".tab",
  ".xlsx",
  ".xls",
  ".json",
]);

export function isTabularSource(fileName: string): boolean {
  const extension = /\.[^.]+$/.exec(fileName)?.[0].toLowerCase();
  return extension !== undefined && tabularSourceExtensions.has(extension);
}

export const workflowSpecs: Record<UseCase, WorkflowSpec> = {
  "data-analysis": {
    label: "Data analysis",
    summary: "Check a dataset, reconcile totals, and surface material trends.",
    requiredDocuments: ["Source dataset"],
    recommendedDocuments: ["Data dictionary", "Reporting-period notes"],
    maxFileBytes: 25 * 1024 * 1024,
    maxPdfPages: 80,
    allowedExtensions,
    allowedMimeTypes,
  },
  "tax-notice": {
    label: "Tax notice",
    summary: "Reconcile a notice against return and credit records.",
    requiredDocuments: ["Notice", "Return or income summary"],
    recommendedDocuments: ["Credit statements", "Prior correspondence"],
    maxFileBytes: 25 * 1024 * 1024,
    maxPdfPages: 120,
    allowedExtensions,
    allowedMimeTypes,
  },
  "msme-payment": {
    label: "MSME delayed payment",
    summary: "Reconcile invoices and payments into a source-linked chronology.",
    requiredDocuments: ["Invoice records", "Payment records"],
    recommendedDocuments: ["Delivery confirmation", "Correspondence"],
    maxFileBytes: 25 * 1024 * 1024,
    maxPdfPages: 120,
    allowedExtensions,
    allowedMimeTypes,
  },
};

export interface IntakeOpenQuestion {
  id: string;
  text: string;
  severity: "low" | "medium";
}

export function deriveIntakeOpenQuestions(
  useCase: UseCase,
  selectedDocumentNames: string[],
): IntakeOpenQuestion[] {
  const selected = new Set(selectedDocumentNames.map(normalizeDocumentName));
  return workflowSpecs[useCase].recommendedDocuments
    .filter((name) => !selected.has(normalizeDocumentName(name)))
    .map((name) => ({
      id: `missing-${normalizeDocumentName(name).replaceAll(" ", "-")}`,
      text: `Consider adding ${name.toLowerCase()} to strengthen the evidence.`,
      severity: "low",
    }));
}

export function validateUploadFile(
  file: Pick<File, "name" | "size" | "type">,
  spec: WorkflowSpec,
): string | null {
  if (file.size === 0) return "Empty files are not allowed.";
  if (file.size > spec.maxFileBytes) {
    return `Each file must be at most ${formatFileSize(spec.maxFileBytes)}.`;
  }
  const extension = /\.[^.]+$/.exec(file.name)?.[0].toLowerCase();
  const inferredMimeType = extension
    ? attachmentMimeTypes[extension]
    : undefined;
  if (
    !extension ||
    !spec.allowedExtensions.includes(extension) ||
    !inferredMimeType ||
    !spec.allowedMimeTypes.includes(inferredMimeType)
  ) {
    return "This workflow does not accept that file type.";
  }
  return null;
}

function normalizeDocumentName(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/\.[^.]+$/, "")
    .replace(/[-_]+/g, " ")
    .replace(/\s+/g, " ");
}

export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round((bytes / 1024) * 10) / 10} KB`;
  return `${Math.round((bytes / (1024 * 1024)) * 10) / 10} MB`;
}
