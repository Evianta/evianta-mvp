import type { RunDto, RunEvent } from "@evianta/core";
import { describe, expect, it } from "vitest";
import {
  applyRunEvent,
  createProgress,
  formatCost,
  isTerminalStatus,
} from "../src/chat/narration.js";
import {
  buildResult,
  isInputFinding,
  pendingInputQuestions,
} from "../src/chat/results.js";
import { chatReducer, type ChatMessage } from "../src/chat/types.js";
import type { CaseWorkspace } from "../src/api/client.js";

const usage = {
  inputUnits: 0,
  outputUnits: 0,
  totalUnits: 0,
  costUsd: 0.01,
  costStatus: "estimated" as const,
  reservedUsd: 0,
};
const run = {
  id: "run-1",
  caseId: "case-1",
  status: "running",
  usage,
} as unknown as RunDto;

let sequence = 0;
function event(payload: RunEvent["payload"]): RunEvent {
  sequence += 1;
  return {
    id: `e${sequence}`,
    caseId: "case-1",
    runId: "run-1",
    sequence,
    occurredAt: "2026-11-02T00:00:00.000Z",
    payload,
  };
}
const nameOf = (role: string) => `Agent ${role}`;

describe("run narration", () => {
  it("tracks the roster, findings, cost and waiting state from events", () => {
    sequence = 0;
    let state = createProgress("case-1", run);
    state = applyRunEvent(
      state,
      event({ type: "run-started", planVersion: 1 }),
      nameOf,
    );
    state = applyRunEvent(
      state,
      event({ type: "task-started", taskId: "t1", role: "analyst" }),
      nameOf,
    );
    expect(state.roster).toEqual([
      { role: "analyst", name: "Agent analyst", state: "working" },
    ]);
    expect(state.lines.at(-1)?.text).toBe("Agent analyst is working on it.");
    state = applyRunEvent(
      state,
      event({ type: "finding-added", findingId: "f1" }),
      nameOf,
    );
    state = applyRunEvent(
      state,
      event({ type: "finding-added", findingId: "f1" }),
      nameOf,
    );
    expect(state.findingIds).toEqual(["f1"]);
    state = applyRunEvent(
      state,
      event({
        type: "task-completed",
        taskId: "t1",
        role: "analyst",
        usage,
      }),
      nameOf,
    );
    expect(state.roster[0]?.state).toBe("done");
    state = applyRunEvent(
      state,
      event({ type: "input-required", questionIds: ["q1"] }),
      nameOf,
    );
    expect(state.status).toBe("waiting-for-input");
    expect(state.waitingQuestionIds).toEqual(["q1"]);
    expect(isTerminalStatus(state.status)).toBe(false);
  });

  it("ignores replayed events and marks terminal outcomes", () => {
    sequence = 0;
    const started = event({ type: "run-started", planVersion: 1 });
    let state = applyRunEvent(createProgress("case-1", run), started, nameOf);
    const again = applyRunEvent(state, started, nameOf);
    expect(again).toBe(state);
    state = applyRunEvent(
      state,
      event({
        type: "task-failed",
        taskId: "t2",
        role: "reviewer",
        error: { code: "x", message: "Bad input" },
      }),
      nameOf,
    );
    expect(state.roster[0]?.state).toBe("failed");
    state = applyRunEvent(
      state,
      event({ type: "run-completed", deliverableIds: [] }),
      nameOf,
    );
    expect(isTerminalStatus(state.status)).toBe(true);
  });

  it("never invents a cost", () => {
    expect(formatCost(null, false)).toBe("Cost pending");
    expect(formatCost(0.5, true)).toBe("Cost unknown");
    expect(formatCost(0.5, false)).toContain("0.5");
  });
});

function finding(
  id: string,
  severity: "high" | "medium" | "low" | "info",
  confidence: number,
  questions: { id: string; status: "open" | "resolved"; text: string }[] = [],
) {
  return {
    id,
    caseId: "case-1",
    title: `Finding ${id}`,
    description: "d",
    severity,
    confidence,
    evidenceIds: ["e1"],
    assumptions: [],
    openQuestions: questions.map((question) => ({
      ...question,
      severity: "medium" as const,
      resolutionNote: null,
      actorId: null,
      updatedAt: null,
    })),
    createdAt: "2026-11-02T00:00:00.000Z",
  };
}

describe("result summary", () => {
  const workspace = {
    case: {},
    documents: [{ id: "d1" }, { id: "d2" }],
    evidence: [{ id: "e1" }],
    approvals: [],
    findings: [
      finding("low-1", "low", 0.9),
      finding("high-1", "high", 0.6, [
        { id: "q1", status: "open", text: "Which year?" },
        { id: "q2", status: "resolved", text: "Done" },
      ]),
      finding("t1:input:1", "info", 1, [
        { id: "t1:input:1:q0", status: "open", text: "Upload payments" },
      ]),
    ],
    deliverables: [
      {
        id: "dl1",
        title: "Response pack",
        format: "document",
        summary: "Pack ready, 1 item needs attention.",
        version: 1,
        createdAt: "2026-11-02T00:00:00.000Z",
        sections: [{ findingIds: ["low-1", "high-1"] }],
      },
    ],
  } as unknown as CaseWorkspace;

  it("ranks by severity, hides input prompts and counts open questions", () => {
    const result = buildResult(workspace, run);
    expect(result.headline).toBe("Pack ready, 1 item needs attention.");
    expect(result.findings.map((item) => item.id)).toEqual(["high-1", "low-1"]);
    expect(result.totalFindings).toBe(2);
    expect(result.openQuestions).toBe(1);
    expect(result.sourceCount).toBe(2);
    expect(result.deliverables[0]?.title).toBe("Response pack");
  });

  it("finds mid-run questions that need an answer", () => {
    expect(isInputFinding({ id: "t1:input:1" })).toBe(true);
    expect(pendingInputQuestions(workspace)).toEqual([
      { id: "t1:input:1:q0", text: "Upload payments", severity: "medium" },
    ]);
  });
});

describe("chat reducer", () => {
  const base: ChatMessage = {
    id: "s",
    from: "evianta",
    type: "setup",
    steps: [{ id: "case", label: "Create", status: "pending" }],
  };

  it("adds once, patches and updates steps", () => {
    let state = chatReducer([], { type: "add", message: base });
    state = chatReducer(state, { type: "add", message: base });
    expect(state).toHaveLength(1);
    state = chatReducer(state, {
      type: "step",
      id: "s",
      stepId: "case",
      patch: { status: "done" },
    });
    expect(state[0]).toMatchObject({ steps: [{ status: "done" }] });
    state = chatReducer(state, { type: "reset" });
    expect(state).toEqual([]);
  });
});
