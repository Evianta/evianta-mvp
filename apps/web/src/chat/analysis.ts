import type { UseCase } from "@evianta/core";
import { isTabularSource, matchingWorkflows } from "../intake";

export interface AttachedFile {
  id: string;
  file: File;
  header?: string;
  sample?: string;
}

export interface SlotSpec {
  id: string;
  label: string;
  hint: string;
  pattern: RegExp;
  accepts?: (name: string) => boolean;
  skippable: boolean;
}

export interface FactSpec {
  id: string;
  label: string;
  question: string;
  pattern: RegExp;
  chips: string[];
  freeTextHint: string;
}

export interface Draft {
  prompt: string;
  files: AttachedFile[];
  workflow: UseCase | null;
  answers: Record<string, string>;
  skippedSlots: string[];
}

export type NextStep =
  | { type: "workflow"; candidates: UseCase[] }
  | { type: "document"; slot: SlotSpec }
  | { type: "fact"; fact: FactSpec }
  | { type: "ready"; assignments: SlotAssignment[] };

export interface SlotAssignment {
  slot: SlotSpec;
  fileId: string | null;
  assumed: boolean;
}

export const workflowSlots: Record<UseCase, SlotSpec[]> = {
  "data-analysis": [
    {
      id: "dataset",
      label: "the dataset to analyze",
      hint: "A CSV, TSV, Excel or JSON file with your rows.",
      pattern: /sales|revenue|data|report|register|export|orders|transactions/i,
      accepts: isTabularSource,
      skippable: false,
    },
  ],
  "tax-notice": [
    {
      id: "notice",
      label: "the notice or intimation",
      hint: "The PDF or scan you received from the department.",
      pattern: /notice|intimation|demand|143|148|scn|order|communication/i,
      skippable: true,
    },
    {
      id: "return",
      label: "your return or income summary",
      hint: "The filed ITR, computation of income, or a similar summary. Form 26AS or AIS also help.",
      pattern: /itr|return|computation|income|summary|26as|ais|form.?16|tds/i,
      skippable: true,
    },
  ],
  "msme-payment": [
    {
      id: "invoices",
      label: "your invoice records",
      hint: "An invoice register, sales ledger or the invoices themselves.",
      pattern: /invoice|bill|sales|receivable|outstanding|ageing|aging/i,
      skippable: true,
    },
    {
      id: "payments",
      label: "your payment records",
      hint: "A bank statement, receipts or a ledger showing what was paid.",
      pattern: /payment|receipt|bank|statement|remittance|received|ledger/i,
      skippable: true,
    },
  ],
};

const assessmentYearPattern =
  /\b(?:ay|a\.y\.|assessment\s+year|fy|financial\s+year)\s*[:-]?\s*20\d\d(?:\s*[-\u2013/]\s*\d{2,4})?|\b20\d\d\s*[-\u2013]\s*\d{2}\b/i;

export const workflowFacts: Record<UseCase, FactSpec[]> = {
  "data-analysis": [],
  "tax-notice": [
    {
      id: "assessment-year",
      label: "Assessment year",
      question: "Which assessment year is this notice for?",
      pattern: assessmentYearPattern,
      chips: ["AY 2025-26", "AY 2024-25", "AY 2023-24", "Not sure"],
      freeTextHint: "Or type it, for example AY 2024-25.",
    },
  ],
  "msme-payment": [
    {
      id: "payment-terms",
      label: "Agreed payment terms",
      question: "What payment terms were agreed with the buyer?",
      pattern: /\b\d{1,3}\s*days?\b|payment\s+terms?|no\s+written\s+agreement/i,
      chips: [
        "Within 15 days",
        "Within 30 days",
        "Up to 45 days",
        "No written agreement",
      ],
      freeTextHint: "Or type the terms, for example 60 days from delivery.",
    },
  ],
};

export const workflowLabels: Record<UseCase, string> = {
  "data-analysis": "Business data analysis",
  "tax-notice": "Income-tax notice response",
  "msme-payment": "MSME delayed-payment dispute",
};

export const workflowBlurbs: Record<UseCase, string> = {
  "data-analysis": "Trends, anomalies and a dashboard from your spreadsheet.",
  "tax-notice": "Reconcile a notice with your records and draft a response.",
  "msme-payment":
    "Reconcile invoices and payments into a chronology and case pack.",
};

function fileText(file: AttachedFile): string {
  return `${file.file.name} ${file.header ?? ""}`.replaceAll(/[_-]/g, " ");
}

export function hintsFor(files: AttachedFile[]) {
  return files.map((item) => ({ name: item.file.name, header: item.header }));
}

export function candidateWorkflows(
  prompt: string,
  files: AttachedFile[],
): UseCase[] {
  return matchingWorkflows(prompt, hintsFor(files));
}

export function resolveWorkflow(draft: Draft): UseCase | null {
  if (draft.workflow) return draft.workflow;
  const candidates = candidateWorkflows(draft.prompt, draft.files);
  return candidates.length === 1 ? (candidates[0] ?? null) : null;
}

export function assignSlots(
  workflow: UseCase,
  files: AttachedFile[],
): SlotAssignment[] {
  const used = new Set<string>();
  const slots = workflowSlots[workflow];
  const assignments: SlotAssignment[] = slots.map((slot) => {
    const match = files.find(
      (item) =>
        !used.has(item.id) &&
        (slot.accepts?.(item.file.name) ?? true) &&
        slot.pattern.test(fileText(item)),
    );
    if (match) used.add(match.id);
    return { slot, fileId: match?.id ?? null, assumed: false };
  });
  // A leftover file is assumed to fill a gap; the agents raise a question if it does not fit.
  for (const assignment of assignments) {
    if (assignment.fileId) continue;
    const leftover = files.find(
      (item) =>
        !used.has(item.id) &&
        (assignment.slot.accepts?.(item.file.name) ?? true),
    );
    if (leftover) {
      used.add(leftover.id);
      assignment.fileId = leftover.id;
      assignment.assumed = true;
    }
  }
  return assignments;
}

function factKnown(fact: FactSpec, draft: Draft): boolean {
  if (draft.answers[fact.id]) return true;
  const text = [
    draft.prompt,
    ...draft.files.map((item) => item.sample ?? ""),
    ...draft.files.map(fileText),
  ].join("\n");
  return fact.pattern.test(text);
}

export function planNextStep(draft: Draft): NextStep {
  const workflow = resolveWorkflow(draft);
  if (!workflow) {
    const candidates = candidateWorkflows(draft.prompt, draft.files);
    return {
      type: "workflow",
      candidates: candidates.length > 1 ? candidates : [],
    };
  }
  const assignments = assignSlots(workflow, draft.files);
  const missing = assignments.find(
    ({ slot, fileId }) => !fileId && !draft.skippedSlots.includes(slot.id),
  );
  if (missing) return { type: "document", slot: missing.slot };
  const fact = workflowFacts[workflow].find((item) => !factKnown(item, draft));
  if (fact) return { type: "fact", fact };
  return { type: "ready", assignments };
}

export function buildTaskDescription(draft: Draft, limit = 5000): string {
  const workflow = resolveWorkflow(draft);
  const notes: string[] = [];
  if (workflow) {
    for (const fact of workflowFacts[workflow]) {
      const answer = draft.answers[fact.id];
      if (answer) notes.push(`${fact.label}: ${answer}`);
    }
    for (const slotId of draft.skippedSlots) {
      const slot = workflowSlots[workflow].find((item) => item.id === slotId);
      if (slot) notes.push(`Not available: ${slot.label}`);
    }
  }
  const base = draft.prompt.trim();
  if (!notes.length) return base.slice(0, limit);
  const extra = `\n\nDetails provided in chat:\n${notes.map((note) => `- ${note}`).join("\n")}`;
  return `${base.slice(0, Math.max(0, limit - extra.length))}${extra}`;
}
