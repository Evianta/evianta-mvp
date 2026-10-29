import type { UseCase } from "@evianta/core";

export interface WorkflowSpec {
  label: string;
  summary: string;
  requiredDocuments: string[];
  recommendedDocuments: string[];
  maxFileBytes: number;
  maxPdfPages: number;
  allowedMimeTypes: string[];
}

export const workflowSpecs: Record<UseCase, WorkflowSpec> = {
  "data-analysis": {
    label: "Data analysis",
    summary: "Check a dataset, reconcile totals, and surface material trends.",
    requiredDocuments: ["Source dataset"],
    recommendedDocuments: ["Data dictionary", "Reporting-period notes"],
    maxFileBytes: 25 * 1024 * 1024,
    maxPdfPages: 80,
    allowedMimeTypes: [
      "text/csv",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ],
  },
  "tax-notice": {
    label: "Tax notice",
    summary: "Reconcile a notice against return and credit records.",
    requiredDocuments: ["Notice", "Return or income summary"],
    recommendedDocuments: ["Credit statements", "Prior correspondence"],
    maxFileBytes: 25 * 1024 * 1024,
    maxPdfPages: 120,
    allowedMimeTypes: ["application/pdf", "text/csv"],
  },
  "msme-payment": {
    label: "MSME delayed payment",
    summary: "Reconcile invoices and payments into a source-linked chronology.",
    requiredDocuments: ["Invoice records", "Payment records"],
    recommendedDocuments: ["Delivery confirmation", "Correspondence"],
    maxFileBytes: 25 * 1024 * 1024,
    maxPdfPages: 120,
    allowedMimeTypes: ["application/pdf", "text/csv"],
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
  if (file.size > spec.maxFileBytes) {
    return `Each file must be smaller than ${formatFileSize(spec.maxFileBytes)}.`;
  }
  const extension = file.name.split(".").at(-1)?.toLowerCase();
  const inferredMimeType =
    extension === "csv"
      ? "text/csv"
      : extension === "pdf"
        ? "application/pdf"
        : extension === "xlsx"
          ? "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
          : file.type;
  if (!spec.allowedMimeTypes.includes(inferredMimeType)) {
    return "This workflow does not accept that file type.";
  }
  return null;
}

function normalizeDocumentName(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/\.(csv|pdf|xlsx)$/i, "")
    .replace(/[-_]+/g, " ")
    .replace(/\s+/g, " ");
}

function formatFileSize(bytes: number): string {
  return `${Math.round(bytes / (1024 * 1024))} MB`;
}
