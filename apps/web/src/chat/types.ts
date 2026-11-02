import type { UseCase } from "@evianta/core";

export type StepStatus = "pending" | "active" | "done" | "failed";

export interface SetupStep {
  id: string;
  label: string;
  status: StepStatus;
  detail?: string;
}

export type NoticeAction =
  | { kind: "open-case"; caseId: string }
  | { kind: "open-cases" }
  | { kind: "new-task" }
  | { kind: "retry" };

export type ChatMessage =
  | {
      id: string;
      from: "user";
      text: string;
      files: { name: string; size: number }[];
    }
  | {
      id: string;
      from: "evianta";
      type: "text";
      text: string;
      animate: boolean;
    }
  | { id: string; from: "evianta"; type: "sign-in" }
  | {
      id: string;
      from: "evianta";
      type: "workflow-choice";
      options: UseCase[];
      chosen?: UseCase;
    }
  | {
      id: string;
      from: "evianta";
      type: "missing-document";
      slotId: string;
      label: string;
      hint: string;
      skippable: boolean;
      resolved?: "attached" | "skipped";
    }
  | {
      id: string;
      from: "evianta";
      type: "question";
      origin: "intake" | "run";
      questionId: string;
      text: string;
      chips: string[];
      hint?: string;
      answered?: string;
    }
  | { id: string; from: "evianta"; type: "setup"; steps: SetupStep[] }
  | { id: string; from: "evianta"; type: "progress"; runId: string }
  | { id: string; from: "evianta"; type: "result"; runId: string }
  | {
      id: string;
      from: "evianta";
      type: "notice";
      tone: "info" | "warning" | "danger";
      text: string;
      action?: NoticeAction;
    };

export type InspectTarget =
  | { kind: "finding"; id: string }
  | { kind: "deliverable"; id: string }
  | { kind: "document"; id: string | null; name: string }
  | { kind: "agent"; role: string };

export type ChatAction =
  | { type: "add"; message: ChatMessage }
  | { type: "patch"; id: string; patch: Partial<ChatMessage> }
  | { type: "step"; id: string; stepId: string; patch: Partial<SetupStep> }
  | { type: "reset" };

export function chatReducer(
  state: ChatMessage[],
  action: ChatAction,
): ChatMessage[] {
  switch (action.type) {
    case "add":
      return state.some((message) => message.id === action.message.id)
        ? state
        : [...state, action.message];
    case "patch":
      return state.map((message) =>
        message.id === action.id
          ? ({ ...message, ...action.patch } as ChatMessage)
          : message,
      );
    case "step":
      return state.map((message) =>
        message.id === action.id && "steps" in message
          ? {
              ...message,
              steps: message.steps.map((step) =>
                step.id === action.stepId ? { ...step, ...action.patch } : step,
              ),
            }
          : message,
      );
    case "reset":
      return [];
  }
}
