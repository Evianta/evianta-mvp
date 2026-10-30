import { PlanValidationError } from "./errors.js";

export interface PlanNode {
  id: string;
  dependencyIds: readonly string[];
}

/**
 * Validates task dependencies and returns a dependency-respecting order.
 * Fails fast on duplicate IDs, unknown/self dependencies and cycles.
 */
export function validateTaskGraph<T extends PlanNode>(
  tasks: readonly T[],
): T[] {
  const issues: string[] = [];
  const byId = new Map<string, T>();
  for (const task of tasks) {
    if (byId.has(task.id)) issues.push(`duplicate task ${task.id}`);
    byId.set(task.id, task);
  }
  for (const task of tasks) {
    for (const dependencyId of task.dependencyIds) {
      if (dependencyId === task.id) {
        issues.push(`task ${task.id} depends on itself`);
      } else if (!byId.has(dependencyId)) {
        issues.push(`task ${task.id} depends on missing task ${dependencyId}`);
      }
    }
  }
  if (issues.length) throw new PlanValidationError("Invalid task plan", issues);

  const order: T[] = [];
  const state = new Map<string, "visiting" | "done">();
  const visit = (task: T, path: string[]): void => {
    const current = state.get(task.id);
    if (current === "done") return;
    if (current === "visiting") {
      const cycle = [...path.slice(path.indexOf(task.id)), task.id];
      throw new PlanValidationError("Task plan contains a cycle", [
        cycle.join(" -> "),
      ]);
    }
    state.set(task.id, "visiting");
    for (const dependencyId of task.dependencyIds) {
      visit(byId.get(dependencyId)!, [...path, task.id]);
    }
    state.set(task.id, "done");
    order.push(task);
  };
  for (const task of tasks) visit(task, []);
  return order;
}
