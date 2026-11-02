import {
  createTaxNoticePlan,
  createTaxNoticeSpecialists,
} from "@evianta/agents";
import { describe, expect, it, vi } from "vitest";
import {
  CASE_ID,
  OWNER,
  createHarness,
  makeCase,
  newMemoryStore,
  seedAsync,
} from "../../../packages/agents/test/harness.js";
import { createApiMockProvider } from "../src/runtime.js";

describe("API mock runtime", () => {
  it("completes tax planning, specialist work and independent review", async () => {
    const store = newMemoryStore();
    await seedAsync(store.repositories);
    await store.repositories.cases.replaceOwned(
      makeCase(CASE_ID, { useCase: "tax-notice" }),
      OWNER,
    );
    const provider = createApiMockProvider();
    const calls = vi.spyOn(provider, "generateStructured");
    const h = createHarness({
      repositories: store.repositories,
      provider,
      plan: createTaxNoticePlan(),
      specialists: createTaxNoticeSpecialists(),
      coordinator: true,
    });
    const run = await h.orchestrator.createRunAsync({
      ownerId: OWNER,
      caseId: CASE_ID,
    });

    expect((await h.worker.runOnceAsync())?.run?.status).toBe("completed");
    expect(
      calls.mock.calls.some(([request]) =>
        request.system.startsWith("You plan"),
      ),
    ).toBe(true);
    expect(
      calls.mock.calls.some(([request]) =>
        request.system.startsWith("You independently"),
      ),
    ).toBe(true);
    const tasks = await store.repositories.tasks.listForRun(run.id, {
      ownerId: OWNER,
      caseId: CASE_ID,
    });
    expect(tasks).toHaveLength(5);
    expect(
      tasks.every(
        (task) => task.status === "completed" && task.lastError === null,
      ),
    ).toBe(true);
    expect(tasks.every((task) => task.attemptCount === 1)).toBe(true);
    expect(calls).toHaveBeenCalledTimes(4);
  });
});
