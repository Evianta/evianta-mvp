import type { RunDto, RunEvent } from "@evianta/core";

export type RosterState = "working" | "done" | "failed";

export interface RosterEntry {
  role: string;
  name: string;
  state: RosterState;
}

export interface ProgressLine {
  id: string;
  text: string;
  tone: "info" | "success" | "warning" | "danger";
}

export interface ProgressState {
  caseId: string;
  runId: string;
  status: RunDto["status"] | "starting";
  roster: RosterEntry[];
  lines: ProgressLine[];
  findingIds: string[];
  lastSequence: number;
  costUsd: number | null;
  costUnknown: boolean;
  waitingQuestionIds: string[];
  failures: Array<{ taskId: string; message: string }>;
}

export function createProgress(caseId: string, run: RunDto): ProgressState {
  return {
    caseId,
    runId: run.id,
    status: run.status,
    roster: [],
    lines: [],
    findingIds: [],
    lastSequence: 0,
    costUsd: run.usage.costUsd,
    costUnknown: run.usage.costStatus === "unknown",
    waitingQuestionIds: [],
    failures: [],
  };
}

const maxLines = 8;

function withLine(
  state: ProgressState,
  event: RunEvent,
  text: string,
  tone: ProgressLine["tone"],
): ProgressLine[] {
  return [...state.lines, { id: event.id, text, tone }].slice(-maxLines);
}

function setRole(
  roster: RosterEntry[],
  role: string,
  name: string,
  next: RosterState,
): RosterEntry[] {
  const existing = roster.find((entry) => entry.role === role);
  if (!existing) return [...roster, { role, name, state: next }];
  return roster.map((entry) =>
    entry.role === role ? { ...entry, state: next } : entry,
  );
}

export function applyRunEvent(
  state: ProgressState,
  event: RunEvent,
  nameOf: (role: string) => string,
): ProgressState {
  if (event.sequence <= state.lastSequence) return state;
  const base = { ...state, lastSequence: event.sequence };
  const payload = event.payload;
  switch (payload.type) {
    case "run-started":
      return {
        ...base,
        status: "running",
        lines: withLine(
          base,
          event,
          "Plan ready. Bringing in the specialists.",
          "info",
        ),
      };
    case "task-started": {
      const name = nameOf(payload.role);
      return {
        ...base,
        status: "running",
        roster: setRole(base.roster, payload.role, name, "working"),
        lines: withLine(base, event, `${name} is working on it.`, "info"),
      };
    }
    case "task-completed": {
      const name = nameOf(payload.role);
      return {
        ...base,
        failures: base.failures.filter(
          (failure) => failure.taskId !== payload.taskId,
        ),
        roster: setRole(base.roster, payload.role, name, "done"),
        lines: withLine(base, event, `${name} finished.`, "success"),
      };
    }
    case "task-failed": {
      const name = nameOf(payload.role);
      return {
        ...base,
        failures: [
          ...base.failures.filter(
            (failure) => failure.taskId !== payload.taskId,
          ),
          {
            taskId: payload.taskId,
            message: `${name}: ${payload.error.message}`,
          },
        ],
        roster: setRole(base.roster, payload.role, name, "failed"),
        lines: withLine(
          base,
          event,
          `${name} ran into a problem: ${payload.error.message}`,
          "danger",
        ),
      };
    }
    case "finding-added":
      return base.findingIds.includes(payload.findingId)
        ? base
        : { ...base, findingIds: [...base.findingIds, payload.findingId] };
    case "cost-updated":
      return {
        ...base,
        costUsd: payload.usage.costUsd,
        costUnknown: payload.usage.costStatus === "unknown",
      };
    case "run-completed":
      return {
        ...base,
        status: "completed",
        lines: withLine(
          base,
          event,
          "All done. Pulling the results together.",
          "success",
        ),
      };
    case "run-failed":
      return {
        ...base,
        status: "failed",
        lines: withLine(
          base,
          event,
          `The run stopped: ${payload.error.message}`,
          "danger",
        ),
      };
    case "run-cancelled":
      return {
        ...base,
        status: "cancelled",
        lines: withLine(
          base,
          event,
          "Stopped. Finished work is kept.",
          "warning",
        ),
      };
    case "limit-reached":
      return {
        ...base,
        status: "limit-reached",
        lines: withLine(
          base,
          event,
          "A usage limit was reached. Finished work is kept.",
          "warning",
        ),
      };
    case "input-required":
      return {
        ...base,
        status: "waiting-for-input",
        waitingQuestionIds: payload.questionIds,
        lines: withLine(
          base,
          event,
          "I need a little more information to continue.",
          "warning",
        ),
      };
  }
}

export function isTerminalStatus(status: ProgressState["status"]): boolean {
  return [
    "completed",
    "partially-completed",
    "failed",
    "cancelled",
    "limit-reached",
  ].includes(status);
}

export function progressTitle(status: ProgressState["status"]): string {
  switch (status) {
    case "completed":
      return "Work finished";
    case "partially-completed":
      return "Work partly finished";
    case "failed":
      return "Work could not finish";
    case "cancelled":
      return "Work stopped";
    case "limit-reached":
      return "Usage limit reached";
    case "waiting-for-input":
      return "Waiting for your answer";
    default:
      return "Working on your task";
  }
}

export function formatCost(costUsd: number | null, unknown: boolean): string {
  if (unknown) return "Cost unknown";
  if (costUsd === null) return "Cost pending";
  return new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 4,
  }).format(costUsd);
}
