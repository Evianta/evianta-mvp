import { MemorySaver } from "@langchain/langgraph";
import { describe, expect, it } from "vitest";
import {
  PlanRegistry,
  PlanValidationError,
  compileTaskGraph,
  createTrivialReferencePlan,
  runDeterministicChecks,
  seedAgentDirectoryAsync,
  validateAdaptedPlan,
  validateTaskGraph,
  type ReferencePlan,
  type VerifiableFinding,
} from "../src/index.js";
import { newMemoryStore } from "./harness.js";

function finding(
  overrides: Partial<VerifiableFinding> = {},
): VerifiableFinding {
  return {
    id: "f1",
    taskId: "t1",
    title: "Revenue",
    severity: "high",
    evidenceIds: ["e1"],
    claims: [],
    ...overrides,
  };
}

describe("agent directory", () => {
  it("seeds profiles idempotently", async () => {
    const store = newMemoryStore();
    await seedAgentDirectoryAsync(store.repositories.agentProfiles);
    await seedAgentDirectoryAsync(store.repositories.agentProfiles);
    expect(await store.repositories.agentProfiles.listEnabled()).toHaveLength(
      3,
    );
  });
});

describe("deterministic verification", () => {
  it("catches a wrong total", () => {
    const result = runDeterministicChecks([
      finding({
        claims: [
          { label: "Total", value: 100, components: [40, 50], date: null },
        ],
      }),
    ]);
    expect(result.passed).toBe(false);
    expect(result.flags.map((flag) => flag.code)).toEqual(["total-mismatch"]);
  });

  it("catches a material finding without evidence", () => {
    const result = runDeterministicChecks([finding({ evidenceIds: [] })]);
    expect(result.flags.map((flag) => flag.code)).toEqual(["missing-evidence"]);
    expect(
      runDeterministicChecks([finding({ evidenceIds: [], severity: "low" })])
        .passed,
    ).toBe(true);
  });

  it("flags inconsistent figures and dates across findings", () => {
    const result = runDeterministicChecks([
      finding({
        claims: [
          { label: "Rent", value: 10, components: null, date: "2026-01-01" },
        ],
      }),
      finding({
        id: "f2",
        claims: [
          { label: " rent ", value: 12, components: null, date: "2026-02-01" },
        ],
      }),
    ]);
    expect(result.flags.map((flag) => flag.code).sort()).toEqual([
      "inconsistent-date",
      "inconsistent-figure",
    ]);
    expect(result.flags[0].findingIds).toEqual(["f1", "f2"]);
  });

  it("passes a consistent case", () => {
    const result = runDeterministicChecks([
      finding({
        claims: [
          { label: "Total", value: 90, components: [40, 50], date: null },
        ],
      }),
      finding({
        id: "f2",
        claims: [{ label: "total", value: 90, components: null, date: null }],
      }),
    ]);
    expect(result).toEqual({ passed: true, flags: [] });
  });
});

describe("task graph validation", () => {
  it("orders dependencies first", () => {
    const ordered = validateTaskGraph([
      { id: "c", dependencyIds: ["a", "b"] },
      { id: "b", dependencyIds: ["a"] },
      { id: "a", dependencyIds: [] },
    ]);
    expect(ordered.map((task) => task.id)).toEqual(["a", "b", "c"]);
  });

  it("rejects cycles, self, missing and duplicate dependencies", () => {
    expect(() =>
      validateTaskGraph([
        { id: "a", dependencyIds: ["b"] },
        { id: "b", dependencyIds: ["a"] },
      ]),
    ).toThrow(PlanValidationError);
    expect(() =>
      validateTaskGraph([{ id: "a", dependencyIds: ["a"] }]),
    ).toThrow(PlanValidationError);
    expect(() =>
      validateTaskGraph([{ id: "a", dependencyIds: ["x"] }]),
    ).toThrow(PlanValidationError);
    expect(() =>
      validateTaskGraph([
        { id: "a", dependencyIds: [] },
        { id: "a", dependencyIds: [] },
      ]),
    ).toThrow(PlanValidationError);
  });

  it("refuses to compile an invalid graph", () => {
    expect(() =>
      compileTaskGraph(
        [{ id: "run:a", dependencyIds: ["run:a"] }] as never,
        async () => ({}),
        new MemorySaver(),
      ),
    ).toThrow(PlanValidationError);
  });
});

describe("plans", () => {
  const reference: ReferencePlan = {
    ...createTrivialReferencePlan("tax-notice"),
    tasks: [
      {
        key: "analysis",
        role: "generic-analyst",
        title: "Analysis",
        dependsOn: [],
        required: true,
        instructions: "Analyze.",
      },
      {
        key: "extra",
        role: "generic-analyst",
        title: "Extra",
        dependsOn: ["analysis"],
        required: false,
        instructions: "Extra.",
      },
    ],
  };
  const roles = new Set(["generic-analyst"]);

  it("accepts an adapted plan that keeps required tasks", () => {
    const tasks = validateAdaptedPlan(
      reference,
      {
        tasks: [
          {
            key: "analysis",
            assignedRole: "generic-analyst",
            dependsOn: [],
            instructions: "Go.",
          },
        ],
      },
      roles,
    );
    expect(tasks).toEqual([
      {
        key: "analysis",
        role: "generic-analyst",
        title: "Analysis",
        dependsOn: [],
        instructions: "Go.",
      },
    ]);
  });

  it("rejects missing required tasks, unknown roles and cycles", () => {
    const task = (
      key: string,
      dependsOn: string[] = [],
      role = "generic-analyst",
    ) => ({
      key,
      assignedRole: role,
      dependsOn,
      instructions: "",
    });
    expect(() =>
      validateAdaptedPlan(reference, { tasks: [task("extra")] }, roles),
    ).toThrow(PlanValidationError);
    expect(() =>
      validateAdaptedPlan(
        reference,
        { tasks: [task("analysis"), task("x", [], "ghost")] },
        roles,
      ),
    ).toThrow(PlanValidationError);
    expect(() =>
      validateAdaptedPlan(
        reference,
        { tasks: [task("analysis", ["x"]), task("x", ["analysis"])] },
        roles,
      ),
    ).toThrow(PlanValidationError);
  });

  it("registers only valid reference plans", () => {
    const registry = new PlanRegistry();
    expect(() =>
      registry.register({
        ...reference,
        tasks: [{ ...reference.tasks[0], dependsOn: ["analysis"] }],
      }),
    ).toThrow(PlanValidationError);
    registry.register(reference);
    expect(registry.get("tax-notice").tasks).toHaveLength(2);
  });
});
