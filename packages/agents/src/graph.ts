import {
  Annotation,
  END,
  START,
  StateGraph,
  type BaseCheckpointSaver,
} from "@langchain/langgraph";
import type { Task } from "@evianta/core";
import type { NumericClaim } from "./contracts.js";
import { validateTaskGraph } from "./plan.js";

/** Bump when node semantics or state shape change incompatibly. */
export const TASK_GRAPH_VERSION = "task-dag/1";

export type TaskOutcomeStatus =
  | "completed"
  | "failed"
  | "skipped"
  | "cancelled"
  | "limit-reached";

export interface TaskOutcomeFinding {
  id: string;
  title: string;
  description: string;
  severity: string;
  evidenceIds: string[];
  claims: NumericClaim[];
}

export interface TaskOutcome {
  taskId: string;
  role: string;
  status: TaskOutcomeStatus;
  sourceTaskId: string;
  summary: string;
  findings: TaskOutcomeFinding[];
  evidenceIds: string[];
  provider: string | null;
  model: string | null;
  modelTier: "cheap" | "mid" | "high";
}

export const TaskGraphState = Annotation.Root({
  graphVersion: Annotation<string>(),
  planVersion: Annotation<number>(),
  instructions: Annotation<Record<string, string>>({
    reducer: (left, right) => ({ ...left, ...right }),
    default: () => ({}),
  }),
  results: Annotation<Record<string, TaskOutcome>>({
    reducer: (left, right) => ({ ...left, ...right }),
    default: () => ({}),
  }),
  resumeKeys: Annotation<string[]>({
    reducer: (left, right) => [...new Set([...left, ...right])],
    default: () => [],
  }),
});

export type TaskGraphStateValue = typeof TaskGraphState.State;
export type TaskGraphUpdate = typeof TaskGraphState.Update;

export type TaskNodeHandler = (
  task: Task,
  state: TaskGraphStateValue,
) => Promise<TaskGraphUpdate>;

interface DynamicGraphBuilder {
  addNode(name: string, action: (state: TaskGraphStateValue) => unknown): void;
  addEdge(from: string | string[], to: string): void;
  compile(options: { checkpointer: BaseCheckpointSaver }): CompiledTaskGraph;
}

export interface CompiledTaskGraph {
  invoke(
    input: unknown,
    config: { configurable: { thread_id: string }; recursionLimit?: number },
  ): Promise<TaskGraphStateValue>;
  getState(config: { configurable: { thread_id: string } }): Promise<{
    values: Partial<TaskGraphStateValue>;
    next: string[];
    tasks: Array<{
      id: string;
      name: string;
      interrupts: Array<{ id?: string; value?: unknown }>;
    }>;
    config?: { configurable?: Record<string, unknown> };
  }>;
}

export function nodeNameFor(taskId: string): string {
  // LangGraph reserves ":" and "|" for checkpoint namespaces.
  return `task/${encodeURIComponent(taskId)}`;
}

/**
 * Compiles a persisted task plan into a LangGraph state graph. Tasks fan out
 * from START, joins wait for every dependency, and sinks fan in to END.
 * Domain task IDs remain the application contract.
 */
export function compileTaskGraph(
  tasks: readonly Task[],
  handler: TaskNodeHandler,
  checkpointer: BaseCheckpointSaver,
): CompiledTaskGraph {
  const ordered = validateTaskGraph(tasks);
  const builder = new StateGraph(
    TaskGraphState,
  ) as unknown as DynamicGraphBuilder;
  const dependents = new Set(tasks.flatMap((task) => task.dependencyIds));
  for (const task of ordered) {
    builder.addNode(nodeNameFor(task.id), (state) => handler(task, state));
  }
  for (const task of ordered) {
    const node = nodeNameFor(task.id);
    if (task.dependencyIds.length === 0) {
      builder.addEdge(START, node);
    } else {
      builder.addEdge(task.dependencyIds.map(nodeNameFor), node);
    }
    if (!dependents.has(task.id)) builder.addEdge(node, END);
  }
  return builder.compile({ checkpointer });
}
