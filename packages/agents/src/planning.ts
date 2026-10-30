import {
  TaskPlanSchema,
  type Case,
  type Deliverable,
  type Task,
  type UseCase,
} from "@evianta/core";
import type { AgentContext } from "./agent.js";
import type { PlanningOutput } from "./contracts.js";
import { PlanValidationError } from "./errors.js";
import { validateTaskGraph } from "./plan.js";
import { GENERIC_ANALYST_ROLE, type CoordinatorAgent } from "./roles.js";
import { emptyUsageSummary } from "./usage.js";

const TASK_KEY = /^[a-z0-9][a-z0-9-]{0,62}$/;

export interface ReferencePlanTask {
  key: string;
  role: string;
  title: string;
  dependsOn: string[];
  required: boolean;
  instructions: string;
}

export interface ReferencePlan {
  useCase: UseCase;
  version: number;
  title: string;
  format: Deliverable["format"];
  tasks: ReferencePlanTask[];
}

export interface PlannedTask {
  key: string;
  role: string;
  title: string;
  dependsOn: string[];
  instructions: string;
}

export interface PlanResult {
  tasks: PlannedTask[];
  adapted: boolean;
  planningCall: boolean;
}

function validateKeys(tasks: readonly { key: string }[]): void {
  const invalid = tasks.filter((task) => !TASK_KEY.test(task.key));
  if (invalid.length) {
    throw new PlanValidationError(
      "Task keys must be lowercase identifiers",
      invalid.map((task) => task.key),
    );
  }
}

function asGraph(tasks: readonly PlannedTask[]) {
  return tasks.map((task) => ({ id: task.key, dependencyIds: task.dependsOn }));
}

export class PlanRegistry {
  private readonly plans = new Map<UseCase, ReferencePlan>();

  register(plan: ReferencePlan): this {
    validateKeys(plan.tasks);
    validateTaskGraph(
      plan.tasks.map((task) => ({
        id: task.key,
        dependencyIds: task.dependsOn,
      })),
    );
    if (!plan.tasks.length) {
      throw new PlanValidationError("A reference plan needs at least one task");
    }
    this.plans.set(plan.useCase, structuredClone(plan));
    return this;
  }

  get(useCase: UseCase): ReferencePlan {
    const plan = this.plans.get(useCase);
    if (!plan) {
      throw new PlanValidationError(
        `No reference plan is registered for ${useCase}`,
      );
    }
    return structuredClone(plan);
  }

  instructionsFor(useCase: UseCase, key: string): string | undefined {
    return this.plans.get(useCase)?.tasks.find((task) => task.key === key)
      ?.instructions;
  }
}

/** A single-task plan used to exercise the engine before workflows exist. */
export function createTrivialReferencePlan(useCase: UseCase): ReferencePlan {
  return {
    useCase,
    version: 1,
    title: "Case analysis",
    format: "report",
    tasks: [
      {
        key: "analysis",
        role: GENERIC_ANALYST_ROLE,
        title: "Analysis",
        dependsOn: [],
        required: true,
        instructions: "Summarize the case documents into cited findings.",
      },
    ],
  };
}

/**
 * Checks a coordinator plan against its reference plan: required tasks keep
 * their role, roles exist, keys are valid and the dependencies form a DAG.
 */
export function validateAdaptedPlan(
  reference: ReferencePlan,
  output: PlanningOutput,
  availableRoles: ReadonlySet<string>,
): PlannedTask[] {
  const tasks: PlannedTask[] = output.tasks.map((task) => ({
    key: task.key,
    role: task.assignedRole,
    title:
      reference.tasks.find((item) => item.key === task.key)?.title ?? task.key,
    dependsOn: [...new Set(task.dependsOn)],
    instructions: task.instructions,
  }));
  validateKeys(tasks);
  const issues: string[] = [];
  for (const task of tasks) {
    if (!availableRoles.has(task.role)) {
      issues.push(`task ${task.key} uses unknown role ${task.role}`);
    }
  }
  for (const required of reference.tasks.filter((task) => task.required)) {
    const planned = tasks.find((task) => task.key === required.key);
    if (!planned || planned.role !== required.role) {
      issues.push(
        `required task ${required.key} (${required.role}) is missing`,
      );
    }
  }
  if (issues.length) {
    throw new PlanValidationError("Coordinator plan is invalid", issues);
  }
  validateTaskGraph(asGraph(tasks));
  const ancestors = (
    key: string,
    graph: readonly { key: string; dependsOn: string[] }[],
  ) => {
    const seen = new Set<string>();
    const pending = [
      ...(graph.find((task) => task.key === key)?.dependsOn ?? []),
    ];
    while (pending.length) {
      const dependency = pending.pop()!;
      if (seen.has(dependency)) continue;
      seen.add(dependency);
      pending.push(
        ...(graph.find((task) => task.key === dependency)?.dependsOn ?? []),
      );
    }
    return seen;
  };
  for (const required of reference.tasks.filter((task) => task.required)) {
    const actual = ancestors(required.key, tasks);
    for (const dependency of ancestors(required.key, reference.tasks)) {
      if (
        reference.tasks.find((task) => task.key === dependency)?.required &&
        !actual.has(dependency)
      ) {
        throw new PlanValidationError(
          `Required dependency ${dependency} must precede ${required.key}`,
        );
      }
    }
  }
  return tasks;
}

export async function planCaseAsync(input: {
  reference: ReferencePlan;
  caseRecord: Case;
  documents: Array<{ id: string; name: string; mimeType: string }>;
  availableRoles: ReadonlySet<string>;
  coordinator?: CoordinatorAgent;
  context?: AgentContext;
}): Promise<PlanResult> {
  const referenceTasks: PlannedTask[] = input.reference.tasks.map((task) => ({
    key: task.key,
    role: task.role,
    title: task.title,
    dependsOn: task.dependsOn,
    instructions: task.instructions,
  }));
  // The reference plan already suffices for single-agent cases.
  if (
    input.reference.tasks.length === 1 ||
    !input.coordinator ||
    !input.context
  ) {
    validateTaskGraph(asGraph(referenceTasks));
    return { tasks: referenceTasks, adapted: false, planningCall: false };
  }
  const result = await input.coordinator.run(
    {
      useCase: input.caseRecord.useCase,
      description: input.caseRecord.description,
      documents: input.documents,
      referencePlan: input.reference.tasks.map((task) => ({
        key: task.key,
        role: task.role,
        dependsOn: task.dependsOn,
        required: task.required,
        instructions: task.instructions,
      })),
      availableRoles: [...input.availableRoles].sort(),
    },
    input.context,
  );
  try {
    return {
      tasks: validateAdaptedPlan(
        input.reference,
        result.output,
        input.availableRoles,
      ),
      adapted: true,
      planningCall: true,
    };
  } catch (error) {
    if (!(error instanceof PlanValidationError)) throw error;
    input.context.logger.warn("Coordinator plan rejected; using reference", {
      reason: error.message,
    });
    return { tasks: referenceTasks, adapted: false, planningCall: true };
  }
}

export function taskIdFor(runId: string, key: string): string {
  return `${runId}:${key}`;
}

export function taskKeyOf(task: Pick<Task, "id" | "runId">): string {
  return task.id.slice(task.runId.length + 1);
}

/** Converts planned tasks into validated, persistable task records. */
export function toTaskRecords(
  caseId: string,
  runId: string,
  planVersion: number,
  tasks: readonly PlannedTask[],
): Task[] {
  const records: Task[] = tasks.map((task) => ({
    id: taskIdFor(runId, task.key),
    caseId,
    runId,
    role: task.role,
    instructions: task.instructions,
    dependencyIds: task.dependsOn.map((key) => taskIdFor(runId, key)),
    status: "pending",
    attemptCount: 0,
    lastError: null,
    usage: emptyUsageSummary(),
  }));
  const parsed = TaskPlanSchema.safeParse({
    caseId,
    runId,
    version: planVersion,
    tasks: records,
  });
  if (!parsed.success) {
    throw new PlanValidationError(
      "Task plan failed schema validation",
      parsed.error.issues.map((issue) => issue.message),
    );
  }
  return parsed.data.tasks;
}
