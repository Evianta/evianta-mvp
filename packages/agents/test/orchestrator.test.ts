import { StoreError } from "@evianta/store";
import { MemorySaver } from "@langchain/langgraph";
import { beforeEach, describe, expect, it } from "vitest";
import {
  RunConflictError,
  RunNotFoundError,
  deliverableIdFor,
  summarizeUsage,
  type OrchestratorHooks,
} from "../src/index.js";
import {
  CASE_ID,
  Clock,
  LEASE_TTL_SECONDS,
  OWNER,
  ScriptedProvider,
  createHarness,
  newMemoryStore,
  planOf,
  reviewOutput,
  seedAsync,
  specialistOutput,
  type HarnessOptions,
  type Store,
} from "./harness.js";

const scope = { ownerId: OWNER, caseId: CASE_ID };

let store: Store;

beforeEach(async () => {
  store = newMemoryStore();
  await seedAsync(store.repositories);
});

function routes(...keys: string[]) {
  return Object.fromEntries([
    ...keys.map((key) => [key, () => specialistOutput(key)] as const),
    ["review", () => reviewOutput] as const,
  ]);
}

function harness(options: Omit<HarnessOptions, "repositories">) {
  return createHarness({ repositories: store.repositories, ...options });
}

async function startRunAsync(h: ReturnType<typeof harness>) {
  const run = await h.orchestrator.createRunAsync({
    ownerId: OWNER,
    caseId: CASE_ID,
  });
  const result = await h.worker.runOnceAsync();
  return { run, result };
}

async function tasksOf(runId: string) {
  const tasks = await store.repositories.tasks.listForRun(runId, scope);
  return Object.fromEntries(
    tasks.map((task) => [task.id.slice(runId.length + 1), task]),
  );
}

async function eventsOf(runId?: string) {
  const events = await store.repositories.events.listAfter(CASE_ID, 0, scope);
  return events.filter((event) => !runId || event.runId === runId);
}

async function expectConsistentEvents() {
  const events = await eventsOf();
  const sequences = events.map((event) => event.sequence);
  expect(sequences).toEqual([...sequences].sort((a, b) => a - b));
  expect(new Set(sequences).size).toBe(sequences.length);
  expect(new Set(events.map((event) => event.id)).size).toBe(events.length);
}

async function caseUsage() {
  return (await store.repositories.cases.findOwnedById(CASE_ID, OWNER))!.usage;
}

async function ledger() {
  return store.repositories.usageLedger.list({
    ownerId: OWNER,
    caseId: CASE_ID,
    limit: 5_000,
  });
}

describe("orchestrator", () => {
  it("runs a linear plan to completion with findings, evidence and usage", async () => {
    const provider = new ScriptedProvider(routes("a", "b"));
    const h = harness({
      provider,
      plan: planOf([{ key: "a" }, { key: "b", dependsOn: ["a"] }]),
    });
    const { run, result } = await startRunAsync(h);

    expect(result?.outcome).toBe("finalized");
    expect(result?.run?.status).toBe("completed");
    expect(result?.run?.leaseId).toBeNull();
    expect(provider.calls).toEqual(["a", "b"]);
    const tasks = await tasksOf(run.id);
    expect(tasks.a.status).toBe("completed");
    expect(tasks.a.attemptCount).toBe(1);
    expect(tasks.a.usage.totalUnits).toBe(500);
    expect(tasks.b.usage.costStatus).toBe("estimated");

    // Dependency findings flow into the dependent task input.
    const bInput = provider.inputs.get("b")![0] as {
      priorFindings: Array<{ findingId: string }>;
      documents: Array<{ documentId: string }>;
    };
    expect(bInput.priorFindings.map((item) => item.findingId)).toEqual([
      `${run.id}:a:finding:0`,
    ]);
    expect(bInput.documents[0].documentId).toBe("document-1");

    const findings = await store.repositories.findings.listForCase(scope);
    expect(findings.map((finding) => finding.id).sort()).toEqual([
      `${run.id}:a:finding:0`,
      `${run.id}:b:finding:0`,
    ]);
    const evidence = await store.repositories.evidence.listForCase(scope);
    expect(evidence).toHaveLength(2);
    expect(evidence[0]).toMatchObject({
      kind: "document",
      documentId: "document-1",
      location: { page: 1, textQuote: "Revenue 100" },
    });

    const deliverable = await store.repositories.deliverables.findOwnedById(
      deliverableIdFor(run.id),
      scope,
    );
    expect(deliverable?.sections).toHaveLength(2);
    expect(deliverable?.sections[0]).toMatchObject({
      title: "Section a",
      producingRole: "analyst",
      routingTier: "cheap",
      provider: "mock",
      model: "mock-spark",
      findingIds: [`${run.id}:a:finding:0`],
      evidenceIds: [`${run.id}:a:evidence:0:0`],
      reviewStatus: "pending",
    });

    const types = (await eventsOf(run.id)).map((event) => event.payload.type);
    expect(types[0]).toBe("run-started");
    expect(types.at(-1)).toBe("run-completed");
    expect(types).toEqual(
      expect.arrayContaining([
        "task-started",
        "finding-added",
        "task-completed",
        "cost-updated",
      ]),
    );
    await expectConsistentEvents();

    const entries = await ledger();
    expect(entries).toHaveLength(2);
    expect(await caseUsage()).toEqual(summarizeUsage(entries));
    expect(result?.run?.usage.totalUnits).toBe(1_000);
  });

  it("fans out branches with bounded concurrency and runs deterministic review", async () => {
    const provider = new ScriptedProvider(
      {
        a: () =>
          specialistOutput("a", {
            claims: [
              { label: "total", value: 100, components: [60, 30], date: null },
            ],
          }),
        b: () => specialistOutput("b", { severity: "high", evidence: [] }),
        review: () => ({
          summary: "Narrative is thin",
          items: [
            { text: "Explain the variance", severity: "low", findingId: null },
          ],
        }),
      },
      5,
    );
    const h = harness({
      provider,
      maxBranchConcurrency: 1,
      plan: planOf([
        { key: "a" },
        { key: "b" },
        { key: "review", role: "independent-reviewer", dependsOn: ["a", "b"] },
      ]),
    });
    const { run, result } = await startRunAsync(h);

    expect(result?.run?.status).toBe("completed");
    expect(provider.maxActive).toBe(1);
    expect(provider.calls.at(-1)).toBe("review");
    const reviewInput = provider.inputs.get("review")![0] as {
      findings: Array<{ taskId: string }>;
      deterministicFlags: Array<{ code: string }>;
    };
    expect(new Set(reviewInput.findings.map((item) => item.taskId))).toEqual(
      new Set([`${run.id}:a`, `${run.id}:b`]),
    );
    expect(
      reviewInput.deterministicFlags.map((flag) => flag.code).sort(),
    ).toEqual(["missing-evidence", "total-mismatch"]);
    const review = (await store.repositories.findings.listForCase(scope)).find(
      (finding) => finding.id === `${run.id}:review:finding:0`,
    )!;
    expect(review.severity).toBe("high");
    expect(review.openQuestions).toHaveLength(3);
    expect(review.openQuestions[0].id).toBe(`${run.id}:review:finding:0:q0`);
    const deliverable = await store.repositories.deliverables.findOwnedById(
      deliverableIdFor(run.id),
      scope,
    );
    expect(
      deliverable?.sections.find(
        (section) => section.producingRole === "independent-reviewer",
      ),
    ).toMatchObject({ routingTier: "high", model: "mock-wonder" });
  });

  it("runs independent branches in parallel when allowed", async () => {
    const provider = new ScriptedProvider(routes("a", "b"), 20);
    const h = harness({
      provider,
      maxBranchConcurrency: 2,
      reviewer: false,
      plan: planOf([{ key: "a" }, { key: "b" }]),
    });
    const { result } = await startRunAsync(h);
    expect(result?.run?.status).toBe("completed");
    expect(provider.maxActive).toBe(2);
  });

  it("blocks only dependents of a failed task and retries only failed work", async () => {
    let failA = true;
    const provider = new ScriptedProvider({
      ...routes("b", "c"),
      a: () => {
        if (failA) throw new Error("synthetic provider outage");
        return specialistOutput("a");
      },
    });
    const h = harness({
      provider,
      reviewer: false,
      plan: planOf([
        { key: "a" },
        { key: "b", dependsOn: ["a"] },
        { key: "c" },
      ]),
    });
    const { run, result } = await startRunAsync(h);

    expect(result?.run?.status).toBe("partially-completed");
    let tasks = await tasksOf(run.id);
    expect(tasks.a.status).toBe("failed");
    expect(tasks.a.lastError?.code).toBeTruthy();
    expect(tasks.b.status).toBe("skipped");
    expect(tasks.b.lastError?.code).toBe("blocked-by-dependency");
    expect(tasks.c.status).toBe("completed");
    expect(
      (await eventsOf(run.id)).some(
        (event) => event.payload.type === "task-failed",
      ),
    ).toBe(true);
    // A provider failure after dispatch leaves the charge unknown.
    expect(result?.run?.usage.costStatus).toBe("unknown");
    expect((await caseUsage()).costStatus).toBe("unknown");

    failA = false;
    const callsBefore = provider.calls.length;
    const retry = await h.orchestrator.retryFailedAsync({
      ownerId: OWNER,
      caseId: CASE_ID,
      priorRunId: run.id,
    });
    expect(retry.priorRunId).toBe(run.id);
    const retried = await h.worker.runOnceAsync();
    expect(retried?.run?.status).toBe("completed");
    expect(provider.calls.slice(callsBefore).sort()).toEqual(["a", "b"]);
    tasks = await tasksOf(retry.id);
    expect(tasks.c.status).toBe("completed");
    expect(tasks.a.attemptCount).toBe(1);

    const sections = (await store.repositories.deliverables.findOwnedById(
      deliverableIdFor(retry.id),
      scope,
    ))!.sections;
    expect(
      sections.map((section) => section.id.split(":").at(-1)).sort(),
    ).toEqual(["a", "b", "c"]);
    // Carried sections reuse the original commit rather than re-running it.
    expect(
      sections.find((section) => section.id.endsWith(":c"))?.findingIds,
    ).toEqual([`${run.id}:c:finding:0`]);

    const entries = await ledger();
    expect(new Set(entries.map((entry) => entry.runId))).toEqual(
      new Set([run.id, retry.id]),
    );
    expect(await caseUsage()).toEqual(summarizeUsage(entries));
  });

  it("refuses to retry runs without failed work or with an active run", async () => {
    const provider = new ScriptedProvider(routes("a"));
    const h = harness({
      provider,
      reviewer: false,
      plan: planOf([{ key: "a" }]),
    });
    const { run } = await startRunAsync(h);
    await expect(
      h.orchestrator.retryFailedAsync({
        ownerId: OWNER,
        caseId: CASE_ID,
        priorRunId: run.id,
      }),
    ).rejects.toBeInstanceOf(RunConflictError);
    await expect(
      h.orchestrator.retryFailedAsync({
        ownerId: "user-2",
        caseId: CASE_ID,
        priorRunId: run.id,
      }),
    ).rejects.toBeInstanceOf(RunNotFoundError);
  });

  it("plans multi-agent cases with the coordinator and counts planning usage", async () => {
    const provider = new ScriptedProvider({
      ...routes("a", "b"),
      coordinator: () => ({
        tasks: [
          {
            key: "a",
            assignedRole: "analyst",
            dependsOn: [],
            instructions: "Adapted a",
          },
          {
            key: "b",
            assignedRole: "analyst",
            dependsOn: ["a"],
            instructions: "Adapted b",
          },
          {
            key: "review",
            assignedRole: "independent-reviewer",
            dependsOn: ["a", "b"],
            instructions: "Review",
          },
        ],
      }),
    });
    const h = harness({
      provider,
      coordinator: true,
      plan: planOf([
        { key: "a" },
        { key: "b" },
        { key: "review", role: "independent-reviewer", dependsOn: ["a", "b"] },
      ]),
    });
    const { run, result } = await startRunAsync(h);

    expect(result?.run?.status).toBe("completed");
    expect(provider.calls).toEqual(["coordinator", "a", "b", "review"]);
    const tasks = await tasksOf(run.id);
    expect(tasks.b.dependencyIds).toEqual([`${run.id}:a`]);
    expect(
      (provider.inputs.get("b")![0] as { task: { instructions: string } }).task
        .instructions,
    ).toBe("Adapted b");
    const entries = await ledger();
    expect(entries.filter((entry) => entry.taskId === null)).toHaveLength(1);
    expect(result?.run?.usage).toEqual(summarizeUsage(entries));
    expect(await caseUsage()).toEqual(summarizeUsage(entries));
  });

  it("falls back to the reference plan when the coordinator returns a cycle", async () => {
    const provider = new ScriptedProvider({
      ...routes("a", "b"),
      coordinator: () => ({
        tasks: [
          {
            key: "a",
            assignedRole: "analyst",
            dependsOn: ["b"],
            instructions: "x",
          },
          {
            key: "b",
            assignedRole: "analyst",
            dependsOn: ["a"],
            instructions: "y",
          },
        ],
      }),
    });
    const h = harness({
      provider,
      coordinator: true,
      reviewer: false,
      plan: planOf([{ key: "a" }, { key: "b" }]),
    });
    const { run, result } = await startRunAsync(h);
    expect(result?.run?.status).toBe("completed");
    const tasks = await tasksOf(run.id);
    expect(tasks.a.dependencyIds).toEqual([]);
  });

  describe("worker restarts", () => {
    class Crash extends Error {}

    async function crashAndRecoverAsync(boundary: keyof OrchestratorHooks) {
      const checkpointer = new MemorySaver();
      const clock = new Clock();
      const provider = new ScriptedProvider(routes("a", "b"));
      const plan = planOf([{ key: "a" }, { key: "b", dependsOn: ["a"] }]);
      let crashed = false;
      const first = harness({
        provider,
        plan,
        clock,
        checkpointer,
        reviewer: false,
        hooks: {
          [boundary]: (task: { id: string }) => {
            if (!crashed && task.id.endsWith(":a")) {
              crashed = true;
              throw new Crash("worker died");
            }
          },
        },
      });
      const run = await first.orchestrator.createRunAsync({
        ownerId: OWNER,
        caseId: CASE_ID,
      });
      await expect(first.worker.runOnceAsync()).rejects.toBeInstanceOf(Crash);

      // The lease still belongs to the dead worker until it expires.
      const second = harness({
        provider,
        plan,
        clock,
        checkpointer,
        reviewer: false,
      });
      expect(await second.worker.runOnceAsync()).toBeNull();
      clock.advance(LEASE_TTL_SECONDS + 1);
      const recovered = await second.worker.runOnceAsync();
      await expectConsistentEvents();
      const findings = await store.repositories.findings.listForCase(scope);
      expect(new Set(findings.map((item) => item.id)).size).toBe(
        findings.length,
      );
      return { run, recovered, provider, tasks: await tasksOf(run.id) };
    }

    it("re-dispatches work that never reached the provider", async () => {
      const { recovered, provider, tasks } =
        await crashAndRecoverAsync("beforeAgentCall");
      expect(recovered?.run?.status).toBe("completed");
      expect(provider.count("a")).toBe(1);
      expect(tasks.a.attemptCount).toBe(1);
    });

    it("marks a dispatched call without a durable result as interrupted", async () => {
      const { recovered, provider, tasks } =
        await crashAndRecoverAsync("afterAgentCall");
      expect(provider.count("a")).toBe(1);
      expect(tasks.a.status).toBe("failed");
      expect(tasks.a.lastError?.code).toBe("attempt-interrupted");
      expect(tasks.a.usage.totalUnits).toBe(500);
      expect(tasks.b.status).toBe("skipped");
      expect(recovered?.run?.status).toBe("failed");
    });

    it("reconciles committed results without repeating paid work", async () => {
      const { recovered, provider, tasks, run } =
        await crashAndRecoverAsync("afterResultCommit");
      expect(recovered?.run?.status).toBe("completed");
      expect(provider.count("a")).toBe(1);
      expect(tasks.a.status).toBe("completed");
      const entries = await ledger();
      expect(entries).toHaveLength(2);
      expect(
        (await eventsOf(run.id)).filter(
          (event) => event.payload.type === "finding-added",
        ),
      ).toHaveLength(2);
    });

    it("resumes from the checkpoint after a committed task", async () => {
      const { recovered, provider } =
        await crashAndRecoverAsync("afterTaskCommit");
      expect(recovered?.run?.status).toBe("completed");
      expect(provider.calls).toEqual(["a", "b"]);
    });

    it("fails safely when the checkpoint graph version changed", async () => {
      const checkpointer = new MemorySaver();
      const clock = new Clock();
      const provider = new ScriptedProvider(routes("a", "b"));
      const plan = planOf([{ key: "a" }, { key: "b", dependsOn: ["a"] }]);
      const first = harness({
        provider,
        plan,
        clock,
        checkpointer,
        reviewer: false,
        hooks: {
          afterTaskCommit: (task) => {
            if (task.id.endsWith(":b")) throw new Crash("worker died");
          },
        },
      });
      const run = await first.orchestrator.createRunAsync({
        ownerId: OWNER,
        caseId: CASE_ID,
      });
      await expect(first.worker.runOnceAsync()).rejects.toBeInstanceOf(Crash);
      clock.advance(LEASE_TTL_SECONDS + 1);
      const second = harness({
        provider,
        plan,
        clock,
        checkpointer,
        reviewer: false,
        graphVersion: "task-dag/2",
      });
      const result = await second.worker.runOnceAsync();
      expect(result?.run?.status).toBe("failed");
      const failed = (await eventsOf(run.id)).find(
        (event) => event.payload.type === "run-failed",
      );
      expect(failed?.payload).toMatchObject({
        error: { code: "graph-version-mismatch" },
      });
      expect((await tasksOf(run.id)).a.status).toBe("completed");
      expect(provider.calls).toEqual(["a", "b"]);
    });
  });

  it("fences a stale worker after its lease is reclaimed", async () => {
    const clock = new Clock();
    const provider = new ScriptedProvider(routes("a"));
    let reclaimed: Awaited<
      ReturnType<typeof h.orchestrator.acquireAsync>
    > | null = null;
    const h = harness({
      provider,
      clock,
      reviewer: false,
      plan: planOf([{ key: "a" }]),
      hooks: {
        beforeAgentCall: async () => {
          if (reclaimed) return;
          clock.advance(LEASE_TTL_SECONDS + 1);
          const run = (
            await store.repositories.runs.listClaimable(
              clock.now().toISOString(),
            )
          )[0];
          reclaimed = await h.orchestrator.acquireAsync(run, "worker-b");
        },
      },
    });
    const { run, result } = await startRunAsync(h);

    expect(result?.outcome).toBe("aborted");
    expect(provider.calls).toEqual([]);
    expect(await store.repositories.findings.listForCase(scope)).toEqual([]);
    expect((await tasksOf(run.id)).a.status).toBe("running");

    const resumed = await h.orchestrator.executeClaimedRunAsync(
      run.id,
      OWNER,
      reclaimed!,
    );
    expect(resumed.run?.status).toBe("completed");
    expect(provider.calls).toEqual(["a"]);
    await expectConsistentEvents();
  });

  it("admits one active run per case and one worker per run", async () => {
    const provider = new ScriptedProvider(routes("a"), 5);
    const h = harness({
      provider,
      reviewer: false,
      plan: planOf([{ key: "a" }]),
    });
    const other = harness({
      provider,
      reviewer: false,
      plan: planOf([{ key: "a" }]),
    });
    await h.orchestrator.createRunAsync({ ownerId: OWNER, caseId: CASE_ID });
    await expect(
      h.orchestrator.createRunAsync({ ownerId: OWNER, caseId: CASE_ID }),
    ).rejects.toBeInstanceOf(RunConflictError);
    await expect(
      h.orchestrator.createRunAsync({ ownerId: "user-2", caseId: CASE_ID }),
    ).rejects.toBeInstanceOf(RunNotFoundError);

    const results = await Promise.all([
      h.worker.runOnceAsync(),
      other.worker.runOnceAsync(),
    ]);
    expect(results.filter((item) => item !== null)).toHaveLength(1);
    expect(provider.calls).toEqual(["a"]);
  });

  it("stops new work at the spend limit and preserves partial results", async () => {
    const provider = new ScriptedProvider(routes("a", "b", "c"));
    let reserves = 0;
    const h = harness({
      provider,
      reviewer: false,
      maxBranchConcurrency: 1,
      plan: planOf([
        { key: "a" },
        { key: "b", dependsOn: ["a"] },
        { key: "c", dependsOn: ["b"] },
      ]),
      admission: (port) =>
        Object.assign(Object.create(port) as typeof port, {
          reserve: async (request: Parameters<typeof port.reserve>[0]) => {
            reserves += 1;
            if (reserves > 1) {
              throw new StoreError(
                "User spend limit exceeded",
                "spend-limit-exceeded",
              );
            }
            return port.reserve(request);
          },
        }),
    });
    const { run, result } = await startRunAsync(h);

    expect(result?.run?.status).toBe("limit-reached");
    const tasks = await tasksOf(run.id);
    expect(tasks.a.status).toBe("completed");
    expect(tasks.b.status).toBe("limit-reached");
    expect(["limit-reached", "skipped"]).toContain(tasks.c.status);
    expect(provider.calls).toEqual(["a"]);
    expect(await store.repositories.findings.listForCase(scope)).toHaveLength(
      1,
    );
    const limitEvents = (await eventsOf(run.id)).filter(
      (event) => event.payload.type === "limit-reached",
    );
    expect(limitEvents).toHaveLength(1);
    const entries = await ledger();
    expect(
      entries.every((entry) => entry.reservationStatus !== "reserved"),
    ).toBe(true);
  });

  it("cancels an executing run and keeps completed work", async () => {
    const provider = new ScriptedProvider(routes("a", "b"));
    let runId = "";
    const h = harness({
      provider,
      reviewer: false,
      plan: planOf([{ key: "a" }, { key: "b", dependsOn: ["a"] }]),
      hooks: {
        beforeAgentCall: async (task) => {
          if (task.id.endsWith(":b")) {
            await h.orchestrator.cancelRunAsync({
              ownerId: OWNER,
              runId,
              reason: "stop",
            });
          }
        },
      },
    });
    const run = await h.orchestrator.createRunAsync({
      ownerId: OWNER,
      caseId: CASE_ID,
    });
    runId = run.id;
    const result = await h.worker.runOnceAsync();

    expect(result?.run?.status).toBe("cancelled");
    expect(result?.run?.cancellationRequested).toBe(true);
    const tasks = await tasksOf(run.id);
    expect(tasks.a.status).toBe("completed");
    expect(tasks.b.status).toBe("cancelled");
    expect(provider.calls).toEqual(["a"]);
    expect((await eventsOf(run.id)).at(-1)?.payload.type).toBe("run-cancelled");
    expect(await store.repositories.findings.listForCase(scope)).toHaveLength(
      1,
    );
  });

  it("cancels a queued run without a worker", async () => {
    const h = harness({
      provider: new ScriptedProvider(routes("a")),
      reviewer: false,
      plan: planOf([{ key: "a" }]),
    });
    const run = await h.orchestrator.createRunAsync({
      ownerId: OWNER,
      caseId: CASE_ID,
    });
    await expect(
      h.orchestrator.cancelRunAsync({ ownerId: "user-2", runId: run.id }),
    ).rejects.toBeInstanceOf(RunNotFoundError);
    const cancelled = await h.orchestrator.cancelRunAsync({
      ownerId: OWNER,
      runId: run.id,
    });
    expect(cancelled.status).toBe("cancelled");
    expect(await h.worker.runOnceAsync()).toBeNull();
  });

  describe("human input", () => {
    function inputHarness() {
      const provider = new ScriptedProvider({
        review: () => reviewOutput,
        a: (input) =>
          input.humanInput
            ? specialistOutput("a")
            : {
                ...specialistOutput("a"),
                findings: [],
                inputRequired: {
                  questions: [{ text: "Which fiscal year?", severity: "high" }],
                },
              },
      });
      const h = harness({
        provider,
        reviewer: false,
        plan: planOf([{ key: "a" }]),
      });
      return { provider, h };
    }

    it("suspends without a lease and resumes only for the owner", async () => {
      const { provider, h } = inputHarness();
      const { run, result } = await startRunAsync(h);

      expect(result?.outcome).toBe("waiting-for-input");
      expect(result?.run).toMatchObject({
        status: "waiting-for-input",
        inputRequired: true,
        leaseId: null,
      });
      const required = (await eventsOf(run.id)).find(
        (event) => event.payload.type === "input-required",
      );
      expect(required?.payload).toEqual({
        type: "input-required",
        questionIds: [`${run.id}:a:input:q0`],
      });
      await expect(
        h.orchestrator.createRunAsync({ ownerId: OWNER, caseId: CASE_ID }),
      ).rejects.toBeInstanceOf(RunConflictError);
      expect(await h.worker.runOnceAsync()).toBeNull();

      const request = {
        idempotencyKey: "resume-key-1",
        input: { fiscalYear: 2025 },
      };
      await expect(
        h.orchestrator.resumeRunAsync({
          ownerId: "user-2",
          runId: run.id,
          request,
        }),
      ).rejects.toBeInstanceOf(RunNotFoundError);
      await expect(
        h.orchestrator.resumeRunAsync({
          ownerId: OWNER,
          runId: run.id,
          request: { idempotencyKey: "x", input: {} },
        }),
      ).rejects.toThrow();

      const resumed = await h.orchestrator.resumeRunAsync({
        ownerId: OWNER,
        runId: run.id,
        request,
      });
      expect(resumed.run?.status).toBe("completed");
      expect(provider.count("a")).toBe(2);
      expect(provider.inputs.get("a")![1].humanInput).toEqual({
        fiscalYear: 2025,
      });

      const replay = await h.orchestrator.resumeRunAsync({
        ownerId: OWNER,
        runId: run.id,
        request,
      });
      expect(replay.run?.status).toBe("completed");
      expect(provider.count("a")).toBe(2);
      await expect(
        h.orchestrator.resumeRunAsync({
          ownerId: OWNER,
          runId: run.id,
          request: { ...request, idempotencyKey: "resume-key-2" },
        }),
      ).rejects.toBeInstanceOf(RunConflictError);
      await expectConsistentEvents();
    });

    it("cancels a run that is waiting for input", async () => {
      const { h } = inputHarness();
      const { run } = await startRunAsync(h);
      const cancelled = await h.orchestrator.cancelRunAsync({
        ownerId: OWNER,
        runId: run.id,
      });
      expect(cancelled.status).toBe("cancelled");
      expect(cancelled.leaseId).toBeNull();
      expect((await tasksOf(run.id)).a.status).toBe("cancelled");
      const next = await h.orchestrator.createRunAsync({
        ownerId: OWNER,
        caseId: CASE_ID,
      });
      expect(next.status).toBe("queued");
    });
  });
});
