import { randomUUID } from "node:crypto";
import {
  Command,
  interrupt,
  isGraphBubbleUp,
  type BaseCheckpointSaver,
} from "@langchain/langgraph";
import { inputTokenAllowance, type AiClient } from "@evianta/ai";
import type {
  ApprovalRepository,
  Case,
  CaseRepository,
  Deliverable,
  DeliverableRepository,
  DeliverableSection,
  DocumentRepository,
  Evidence,
  EvidenceRepository,
  ExtractionRepository,
  Finding,
  FindingRepository,
  OwnerScope,
  RunAdmissionLease,
  RunAdmissionPort,
  RunEventPayload,
  RunEventRepository,
  RunRecord,
  RunRepository,
  RunStatus,
  SanitizedError,
  Task,
  TaskRepository,
  TaskStatus,
  UsageLedgerRepository,
} from "@evianta/core";
import {
  DataAnalysisDashboardSchema,
  DataAnalysisReportSchema,
  EvidenceSchema,
  FindingSchema,
} from "@evianta/core";
import { z } from "zod";
import {
  silentLogger,
  type AgentContext,
  type AgentLogger,
  type AgentResult,
  type DocumentAccess,
} from "./agent.js";
import { Mutex, Semaphore } from "./concurrency.js";
import {
  NumericClaimSchema,
  type DocumentSliceSchema,
  type FindingDraft,
  type PriorFinding,
  type ReviewOutput,
  type SpecialistInput,
  type SpecialistOutput,
} from "./contracts.js";
import { createDocumentAccess } from "./documents.js";
import {
  OrchestrationError,
  RunCancelledError,
  RunConflictError,
  RunNotFoundError,
  WorkerAbortedError,
  errorCode,
} from "./errors.js";
import {
  TASK_GRAPH_VERSION,
  compileTaskGraph,
  type CompiledTaskGraph,
  type TaskGraphStateValue,
  type TaskGraphUpdate,
  type TaskOutcome,
  type TaskOutcomeFinding,
  type TaskOutcomeStatus,
} from "./graph.js";
import {
  planCaseAsync,
  taskIdFor,
  taskKeyOf,
  toTaskRecords,
  type PlanRegistry,
} from "./planning.js";
import {
  REVIEWER_ROLE,
  type CoordinatorAgent,
  type ReviewAgent,
  type SpecialistAgent,
} from "./roles.js";
import { emptyUsageSummary, summarizeUsage } from "./usage.js";
import { runDeterministicChecks } from "./verification.js";

export interface OrchestratorRepositories {
  cases: CaseRepository;
  runs: RunRepository;
  tasks: TaskRepository;
  findings: FindingRepository;
  evidence: EvidenceRepository;
  deliverables: DeliverableRepository;
  approvals: ApprovalRepository;
  events: RunEventRepository;
  usageLedger: UsageLedgerRepository;
  runAdmission: RunAdmissionPort;
  documents: DocumentRepository;
  extractions: ExtractionRepository;
}

/** Test seams for simulating worker death at durable boundaries. */
export interface OrchestratorHooks {
  beforeAgentCall?(task: Task): void | Promise<void>;
  afterAgentCall?(task: Task): void | Promise<void>;
  afterResultCommit?(task: Task): void | Promise<void>;
  afterTaskCommit?(task: Task): void | Promise<void>;
}

export interface OrchestratorOptions {
  repositories: OrchestratorRepositories;
  refreshTabularExtraction?: (
    documentId: string,
    scope: OwnerScope,
  ) => Promise<void>;
  ai: AiClient;
  plans: PlanRegistry;
  specialists: readonly SpecialistAgent[];
  reviewer?: ReviewAgent;
  coordinator?: CoordinatorAgent;
  checkpointer: BaseCheckpointSaver;
  graphVersion?: string;
  maxBranchConcurrency?: number;
  leaseTtlSeconds?: number;
  heartbeatIntervalMs?: number;
  userRunLimit?: number;
  globalRunLimit?: number;
  taskTimeoutMs?: number;
  maxDocumentChars?: number;
  now?: () => Date;
  createId?: () => string;
  logger?: AgentLogger;
  hooks?: OrchestratorHooks;
}

export interface ExecutionResult {
  outcome: "finalized" | "waiting-for-input" | "aborted";
  run: RunRecord | null;
}

export const ResumeRequestSchema = z.object({
  idempotencyKey: z.string().min(8).max(200),
  input: z.record(z.string(), z.unknown()),
});
export type ResumeRequest = z.infer<typeof ResumeRequestSchema>;

interface InterruptPayload {
  taskId: string;
  questionIds: string[];
}

const SectionContentSchema = z.object({
  taskId: z.string(),
  summary: z.string(),
  findings: z.array(
    z.object({
      id: z.string(),
      title: z.string(),
      description: z.string(),
      severity: z.string(),
      evidenceIds: z.array(z.string()),
      claims: z.array(NumericClaimSchema),
    }),
  ),
  report: DataAnalysisReportSchema.optional(),
  dashboard: DataAnalysisDashboardSchema.optional(),
});

const ACTIVE_RUN_STATUSES: readonly RunStatus[] = [
  "queued",
  "running",
  "waiting-for-input",
];
const TERMINAL_TASK_STATUSES: readonly TaskStatus[] = [
  "completed",
  "failed",
  "skipped",
  "cancelled",
  "limit-reached",
];

interface Execution {
  run: RunRecord;
  scope: OwnerScope;
  caseRecord: Case;
  lease: RunAdmissionLease;
  controller: AbortController;
  lost: boolean;
  limitReached: boolean;
  events: EventSink;
  documents: DocumentAccess;
  deliverableId: string;
}

class EventSink {
  private next: number | null = null;
  private readonly lock = new Mutex();

  constructor(
    private readonly repository: RunEventRepository,
    private readonly scope: OwnerScope,
    private readonly runId: string,
    private readonly fencingToken: number | null,
    private readonly now: () => Date,
  ) {}

  /** Appends once per logical event ID; replays are ignored. */
  emit(id: string, payload: RunEventPayload): Promise<void> {
    return this.lock.run(async () => {
      for (let attempt = 0; attempt < 5; attempt += 1) {
        this.next ??= await this.loadNextAsync();
        try {
          await this.repository.append(
            {
              id,
              caseId: this.scope.caseId,
              runId: this.runId,
              sequence: this.next,
              occurredAt: this.now().toISOString(),
              payload,
            },
            this.scope,
            this.fencingToken === null
              ? undefined
              : { fencingToken: this.fencingToken },
          );
          this.next += 1;
          return;
        } catch (error) {
          const code = errorCode(error);
          if (code === "duplicate-record") return;
          if (code === "event-sequence-conflict") {
            this.next = null;
            continue;
          }
          if (code === "stale-fencing-token") throw new WorkerAbortedError();
          throw error;
        }
      }
      throw new OrchestrationError(
        "Could not allocate a case event sequence",
        "event-sequence-conflict",
      );
    });
  }

  private async loadNextAsync(): Promise<number> {
    const events = await this.repository.listAfter(
      this.scope.caseId,
      0,
      this.scope,
    );
    return events.reduce((max, event) => Math.max(max, event.sequence), 0) + 1;
  }
}

function sanitizeError(
  error: unknown,
  fallback = "task-failed",
): SanitizedError {
  const code = errorCode(error) ?? fallback;
  const message =
    error instanceof Error && errorCode(error) && error.message
      ? error.message
      : "The operation failed unexpectedly";
  return { code: code.slice(0, 100), message: message.slice(0, 500) };
}

export function deliverableIdFor(runId: string): string {
  return `${runId}:deliverable`;
}

export function sectionIdFor(runId: string, key: string): string {
  return `${deliverableIdFor(runId)}:section:${key}`;
}

export function threadIdFor(
  caseId: string,
  runId: string,
  planVersion: number,
): string {
  return `case:${caseId}:run:${runId}:plan:${planVersion}`;
}

/**
 * Runs persisted task plans through LangGraph. Domain records remain the
 * source of truth: every node first reconciles committed task state so
 * replays never repeat paid work that already produced a result.
 */
export class Orchestrator {
  private readonly repos: OrchestratorRepositories;
  private readonly specialists: Map<string, SpecialistAgent>;
  private readonly graphVersion: string;
  private readonly semaphore: Semaphore;
  private readonly leaseTtlSeconds: number;
  private readonly heartbeatIntervalMs: number;
  private readonly userRunLimit: number;
  private readonly globalRunLimit: number;
  private readonly taskTimeoutMs: number;
  private readonly now: () => Date;
  private readonly createId: () => string;
  private readonly logger: AgentLogger;
  private readonly hooks: OrchestratorHooks;
  private readonly active = new Map<string, Execution>();

  constructor(private readonly options: OrchestratorOptions) {
    this.repos = options.repositories;
    this.specialists = new Map(
      options.specialists.map((agent) => [agent.role, agent]),
    );
    this.graphVersion = options.graphVersion ?? TASK_GRAPH_VERSION;
    this.semaphore = new Semaphore(options.maxBranchConcurrency ?? 4);
    this.leaseTtlSeconds = options.leaseTtlSeconds ?? 120;
    this.heartbeatIntervalMs =
      options.heartbeatIntervalMs ??
      Math.max(1_000, Math.floor((this.leaseTtlSeconds * 1_000) / 3));
    this.userRunLimit = options.userRunLimit ?? 2;
    this.globalRunLimit = options.globalRunLimit ?? 20;
    this.taskTimeoutMs = options.taskTimeoutMs ?? 10 * 60_000;
    this.now = options.now ?? (() => new Date());
    this.createId = options.createId ?? randomUUID;
    this.logger = options.logger ?? silentLogger;
    this.hooks = options.hooks ?? {};
  }

  get availableRoles(): ReadonlySet<string> {
    const roles = new Set(this.specialists.keys());
    if (this.options.reviewer) roles.add(REVIEWER_ROLE);
    return roles;
  }

  private timestamp(): string {
    return this.now().toISOString();
  }

  private async ownedCaseAsync(ownerId: string, caseId: string): Promise<Case> {
    const record = await this.repos.cases.findOwnedById(caseId, ownerId);
    if (!record || record.status !== "active") throw new RunNotFoundError();
    return record;
  }

  private async insertRunAsync(
    run: RunRecord,
    tasks?: Task[],
  ): Promise<RunRecord> {
    try {
      await this.repos.runs.insert(run, tasks);
    } catch (error) {
      if (errorCode(error) === "duplicate-record") {
        throw new RunConflictError(
          "An active run already exists for this case",
        );
      }
      throw error;
    }
    return run;
  }

  /** Queues a new run; a worker claims it through run admission. */
  async createRunAsync(input: {
    ownerId: string;
    caseId: string;
  }): Promise<RunRecord> {
    const caseRecord = await this.ownedCaseAsync(input.ownerId, input.caseId);
    const plan = this.options.plans.get(caseRecord.useCase);
    const id = this.createId();
    const at = this.timestamp();
    return this.insertRunAsync({
      id,
      caseId: caseRecord.id,
      ownerId: input.ownerId,
      threadId: threadIdFor(caseRecord.id, id, plan.version),
      planVersion: plan.version,
      status: "queued",
      priorRunId: null,
      leaseId: null,
      fencingToken: 0,
      leaseExpiresAt: null,
      cancellationRequested: false,
      inputRequired: false,
      usage: emptyUsageSummary(),
      createdAt: at,
      updatedAt: at,
    });
  }

  /**
   * Creates a run linked to a terminal prior run. Completed tasks are carried
   * as immutable inputs; failed and blocked tasks run again. Limit-reached
   * and cancelled tasks are carried as-is rather than silently re-run.
   */
  async retryFailedAsync(input: {
    ownerId: string;
    caseId: string;
    priorRunId: string;
  }): Promise<RunRecord> {
    const caseRecord = await this.ownedCaseAsync(input.ownerId, input.caseId);
    const prior = await this.repos.runs.findOwnedById(
      input.priorRunId,
      input.ownerId,
    );
    if (!prior || prior.caseId !== caseRecord.id) throw new RunNotFoundError();
    if (ACTIVE_RUN_STATUSES.includes(prior.status)) {
      throw new RunConflictError("Only a finished run can be retried");
    }
    const scope = { ownerId: input.ownerId, caseId: caseRecord.id };
    const priorTasks = await this.repos.tasks.listForRun(prior.id, scope);
    if (
      !priorTasks.some(
        (task) => task.status === "failed" || task.status === "skipped",
      )
    ) {
      throw new RunConflictError("The run has no failed or blocked tasks");
    }
    const id = this.createId();
    const at = this.timestamp();
    const retryBase = { ...prior };
    delete retryBase.terminalEvent;
    const records: Task[] = priorTasks.map((task) => {
      const rerun = task.status === "failed" || task.status === "skipped";
      return {
        ...task,
        id: taskIdFor(id, taskKeyOf(task)),
        runId: id,
        dependencyIds: task.dependencyIds.map((dependency) =>
          taskIdFor(id, dependency.slice(prior.id.length + 1)),
        ),
        status: rerun ? "pending" : task.status,
        attemptCount: rerun ? 0 : task.attemptCount,
        lastError: rerun ? null : task.lastError,
        usage: emptyUsageSummary(),
        resumeKeys: [],
        usageEntryCount: 0,
      };
    });
    const run = await this.insertRunAsync(
      {
        ...retryBase,
        id,
        threadId: threadIdFor(caseRecord.id, id, prior.planVersion),
        status: "queued",
        priorRunId: prior.id,
        leaseId: null,
        fencingToken: 0,
        leaseExpiresAt: null,
        cancellationRequested: false,
        inputRequired: false,
        usage: emptyUsageSummary(),
        createdAt: at,
        updatedAt: at,
      },
      records,
    );
    await this.repos.approvals.invalidateForDeliverable(
      deliverableIdFor(prior.id),
      scope,
    );
    return run;
  }

  /** Acquires a fenced run lease for a worker. */
  async acquireAsync(
    run: Pick<RunRecord, "id" | "caseId" | "ownerId">,
    leaseId: string,
  ): Promise<RunAdmissionLease> {
    const at = this.now();
    return this.repos.runAdmission.acquire({
      ownerId: run.ownerId,
      caseId: run.caseId,
      runId: run.id,
      leaseId,
      at: at.toISOString(),
      expiresAt: new Date(
        at.getTime() + this.leaseTtlSeconds * 1_000,
      ).toISOString(),
      userLimit: this.userRunLimit,
      globalLimit: this.globalRunLimit,
    });
  }

  /** Records cancellation, aborts in-process work and finalizes idle runs. */
  async cancelRunAsync(input: {
    ownerId: string;
    runId: string;
    reason?: string;
  }): Promise<RunRecord> {
    let run = await this.repos.runs.findOwnedById(input.runId, input.ownerId);
    if (!run) throw new RunNotFoundError();
    if (!ACTIVE_RUN_STATUSES.includes(run.status)) return run;
    const scope = { ownerId: run.ownerId, caseId: run.caseId };
    run = await this.requestCancellationAsync(run.id, input.ownerId);
    if (!ACTIVE_RUN_STATUSES.includes(run.status)) return run;
    const local = this.active.get(run.id);
    if (local) {
      local.controller.abort(new RunCancelledError());
      return run;
    }
    const expired =
      run.leaseExpiresAt !== null &&
      Date.parse(run.leaseExpiresAt) <= this.now().getTime();
    if (run.leaseId === null || expired) {
      const lease =
        run.leaseId === null
          ? null
          : {
              leaseId: run.leaseId,
              fencingToken: run.fencingToken,
              expiresAt: run.leaseExpiresAt!,
            };
      await this.finalizeAsync(
        { run, scope, lease },
        { status: "cancelled", reason: input.reason ?? null },
      );
      return (await this.repos.runs.findOwnedById(run.id, input.ownerId))!;
    }
    // Another worker holds the lease; it observes the flag on renewal.
    return run;
  }

  private async requestCancellationAsync(
    runId: string,
    ownerId: string,
  ): Promise<RunRecord> {
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const run = await this.repos.runs.findOwnedById(runId, ownerId);
      if (!run) throw new RunNotFoundError();
      if (!ACTIVE_RUN_STATUSES.includes(run.status)) return run;
      if (run.cancellationRequested) return run;
      const updated: RunRecord = {
        ...run,
        cancellationRequested: true,
        updatedAt: this.timestamp(),
      };
      if (await this.repos.runs.updateOwned(updated, ownerId)) return updated;
    }
    throw new RunConflictError("The run changed while cancelling");
  }

  /**
   * Resumes a run suspended for human input. Requires ownership, validated
   * input and an idempotency key; repeating a key is a no-op.
   */
  async resumeRunAsync(input: {
    ownerId: string;
    runId: string;
    request: unknown;
    leaseId?: string;
  }): Promise<ExecutionResult> {
    const request = ResumeRequestSchema.parse(input.request);
    const run = await this.repos.runs.findOwnedById(input.runId, input.ownerId);
    if (!run) throw new RunNotFoundError();
    const state = await this.graphStateAsync(run);
    const tasks = await this.repos.tasks.listForRun(run.id, {
      ownerId: run.ownerId,
      caseId: run.caseId,
    });
    if (
      state?.resumeKeys?.includes(request.idempotencyKey) ||
      tasks.some((task) => task.resumeKeys?.includes(request.idempotencyKey))
    ) {
      return {
        outcome:
          run.status === "waiting-for-input"
            ? "waiting-for-input"
            : "finalized",
        run,
      };
    }
    if (run.status !== "waiting-for-input") {
      throw new RunConflictError("The run is not waiting for input");
    }
    const at = this.now();
    const lease = await this.repos.runAdmission.resume({
      ownerId: run.ownerId,
      caseId: run.caseId,
      runId: run.id,
      leaseId: input.leaseId ?? `resume:${this.createId()}`,
      fencingToken: run.fencingToken,
      at: at.toISOString(),
      expiresAt: new Date(
        at.getTime() + this.leaseTtlSeconds * 1_000,
      ).toISOString(),
      userLimit: this.userRunLimit,
      globalLimit: this.globalRunLimit,
    });
    return this.executeClaimedRunAsync(run.id, run.ownerId, lease, request);
  }

  private async graphStateAsync(
    run: RunRecord,
  ): Promise<Partial<TaskGraphStateValue> | null> {
    const tuple = await this.options.checkpointer.getTuple({
      configurable: { thread_id: run.threadId },
    });
    if (!tuple) return null;
    return tuple.checkpoint.channel_values as Partial<TaskGraphStateValue>;
  }

  /** Executes a run whose lease the caller already holds. */
  async executeClaimedRunAsync(
    runId: string,
    ownerId: string,
    lease: RunAdmissionLease,
    resume?: ResumeRequest,
  ): Promise<ExecutionResult> {
    const run = await this.repos.runs.findOwnedById(runId, ownerId);
    if (
      !run ||
      run.leaseId !== lease.leaseId ||
      run.fencingToken !== lease.fencingToken
    ) {
      return { outcome: "aborted", run };
    }
    const scope = { ownerId, caseId: run.caseId };
    const caseRecord = await this.repos.cases.findOwnedById(
      run.caseId,
      ownerId,
    );
    if (!caseRecord) return { outcome: "aborted", run };
    const execution: Execution = {
      run,
      scope,
      caseRecord,
      lease,
      controller: new AbortController(),
      lost: false,
      limitReached: false,
      events: new EventSink(
        this.repos.events,
        scope,
        run.id,
        lease.fencingToken,
        this.now,
      ),
      documents: createDocumentAccess(this.repos, scope, {
        maxChars: this.options.maxDocumentChars,
        refreshTabularExtraction: this.options.refreshTabularExtraction,
      }),
      deliverableId: deliverableIdFor(run.id),
    };
    this.active.set(run.id, execution);
    const heartbeat = setInterval(() => {
      void this.heartbeatAsync(execution);
    }, this.heartbeatIntervalMs);
    try {
      if (run.cancellationRequested) {
        return await this.finishAsync(execution, { status: "cancelled" });
      }
      return await this.runGraphAsync(execution, resume);
    } catch (error) {
      if (error instanceof WorkerAbortedError || execution.lost) {
        this.logger.warn("Run worker aborted", { runId: run.id });
        return { outcome: "aborted", run: null };
      }
      throw error;
    } finally {
      clearInterval(heartbeat);
      this.active.delete(run.id);
    }
  }

  private async heartbeatAsync(execution: Execution): Promise<void> {
    if (execution.controller.signal.aborted) return;
    const at = this.now();
    try {
      const renewed = await this.repos.runAdmission.renew({
        ownerId: execution.scope.ownerId,
        caseId: execution.scope.caseId,
        runId: execution.run.id,
        leaseId: execution.lease.leaseId,
        fencingToken: execution.lease.fencingToken,
        at: at.toISOString(),
        expiresAt: new Date(
          at.getTime() + this.leaseTtlSeconds * 1_000,
        ).toISOString(),
      });
      if (renewed) return;
      const run = await this.repos.runs.findOwnedById(
        execution.run.id,
        execution.scope.ownerId,
      );
      if (
        run?.cancellationRequested &&
        run.fencingToken === execution.lease.fencingToken
      ) {
        execution.controller.abort(new RunCancelledError());
        return;
      }
      execution.lost = true;
      execution.controller.abort(new WorkerAbortedError());
    } catch (error) {
      this.logger.warn("Run lease renewal failed", {
        runId: execution.run.id,
        code: errorCode(error),
      });
    }
  }

  private usageBoundary(execution: Execution) {
    return {
      userId: execution.scope.ownerId,
      caseId: execution.scope.caseId,
      runId: execution.run.id,
      leaseId: execution.lease.leaseId,
      fencingToken: execution.lease.fencingToken,
    };
  }

  private contextFor(
    execution: Execution,
    taskId: string | null,
    humanInput?: unknown,
  ): AgentContext {
    return {
      ownerId: execution.scope.ownerId,
      case: execution.caseRecord,
      runId: execution.run.id,
      taskId,
      documents: execution.documents,
      logger: this.logger,
      signal: AbortSignal.any([
        execution.controller.signal,
        AbortSignal.timeout(this.taskTimeoutMs),
      ]),
      usage: this.usageBoundary(execution),
      ai: this.options.ai,
      humanInput,
    };
  }

  private async planAsync(
    execution: Execution,
  ): Promise<{ tasks: Task[]; instructions: Record<string, string> }> {
    const { run, scope, caseRecord } = execution;
    const existing = await this.repos.tasks.listForRun(run.id, scope);
    if (existing.length)
      return {
        tasks: existing,
        instructions: Object.fromEntries(
          existing
            .filter((task) => task.instructions !== undefined)
            .map((task) => [task.id, task.instructions!]),
        ),
      };
    const reference = this.options.plans.get(caseRecord.useCase);
    if (reference.version !== run.planVersion) {
      throw new OrchestrationError(
        "The registered reference plan does not match the queued run version",
        "plan-version-mismatch",
      );
    }
    const planningUsage = (
      await this.repos.usageLedger.listForRun(
        scope.ownerId,
        scope.caseId,
        run.id,
      )
    ).filter((entry) => entry.taskId === null);
    if (planningUsage.some((entry) => entry.reservationStatus !== "released")) {
      await this.repos.usageLedger.markInterrupted(
        scope.ownerId,
        scope.caseId,
        run.id,
        null,
        this.timestamp(),
      );
      throw new OrchestrationError(
        "Planning was dispatched without a durable plan; an explicit retry is required",
        "planning-interrupted",
      );
    }
    const documents = await execution.documents.listAsync();
    const plan = await planCaseAsync({
      reference,
      caseRecord,
      documents: documents.map(({ id, name, mimeType }) => ({
        id,
        name,
        mimeType,
      })),
      availableRoles: this.availableRoles,
      coordinator: this.options.coordinator,
      context: this.contextFor(execution, null),
    });
    const records = toTaskRecords(
      run.caseId,
      run.id,
      run.planVersion,
      plan.tasks,
    );
    await this.repos.tasks.insertPlan(records, scope, {
      fencingToken: execution.lease.fencingToken,
    });
    return {
      tasks: await this.repos.tasks.listForRun(run.id, scope),
      instructions: Object.fromEntries(
        plan.tasks.map((task) => [
          taskIdFor(run.id, task.key),
          task.instructions,
        ]),
      ),
    };
  }

  private async runGraphAsync(
    execution: Execution,
    resume?: ResumeRequest,
  ): Promise<ExecutionResult> {
    const { run } = execution;
    let planned: Awaited<ReturnType<Orchestrator["planAsync"]>>;
    try {
      planned = await this.planAsync(execution);
    } catch (error) {
      return this.handleRunErrorAsync(execution, error, "planning-failed");
    }
    execution.limitReached = planned.tasks.some(
      (task) => task.status === "limit-reached",
    );
    await execution.events.emit(`${run.id}:run-started`, {
      type: "run-started",
      planVersion: run.planVersion,
    });
    let graph: CompiledTaskGraph;
    try {
      graph = compileTaskGraph(
        planned.tasks,
        (task, state) => this.runTaskNodeAsync(execution, task, state),
        this.options.checkpointer,
      );
    } catch (error) {
      return this.handleRunErrorAsync(execution, error, "plan-invalid");
    }
    const config = {
      configurable: { thread_id: run.threadId },
      recursionLimit: planned.tasks.length + 10,
    };
    const snapshot = await graph.getState(config);
    const values = snapshot.values;
    const interruptedTaskIds = new Set(
      snapshot.tasks.flatMap((task) =>
        task.interrupts.map((item) => (item.value as InterruptPayload).taskId),
      ),
    );
    const accepted = planned.tasks.find(
      (task) =>
        interruptedTaskIds.has(task.id) &&
        task.status !== "waiting-for-input" &&
        task.resumeInput !== undefined &&
        task.resumeKeys?.length,
    );
    const pending = accepted
      ? await this.options.checkpointer.getTuple(config)
      : undefined;
    const resumePersisted = pending?.pendingWrites?.some(
      ([taskId, channel, value]) =>
        snapshot.tasks.some(
          (task) =>
            task.id === taskId &&
            task.interrupts.some(
              (item) =>
                (item.value as InterruptPayload).taskId === accepted?.id,
            ),
        ) &&
        channel === "__resume__" &&
        (Array.isArray(value) ? value : [value]).some((item) => {
          const parsed = ResumeRequestSchema.safeParse(item);
          return (
            parsed.success &&
            parsed.data.idempotencyKey === accepted?.resumeKeys?.at(-1)
          );
        }),
    );
    const recoveredResume: ResumeRequest | undefined =
      accepted && !resumePersisted
        ? {
            idempotencyKey: accepted.resumeKeys!.at(-1)!,
            input: accepted.resumeInput!,
          }
        : undefined;
    if (
      values.graphVersion !== undefined &&
      (values.graphVersion !== this.graphVersion ||
        values.planVersion !== run.planVersion)
    ) {
      return this.finishAsync(execution, {
        status: "failed",
        error: {
          code: "graph-version-mismatch",
          message: `Checkpoint graph ${values.graphVersion} (plan ${values.planVersion}) does not match ${this.graphVersion} (plan ${run.planVersion})`,
        },
      });
    }
    try {
      if (values.graphVersion === undefined) {
        await graph.invoke(
          {
            graphVersion: this.graphVersion,
            planVersion: run.planVersion,
            instructions: planned.instructions,
          },
          config,
        );
      } else if (resume ?? recoveredResume) {
        const answer = resume ?? recoveredResume;
        const target = snapshot.tasks
          .flatMap((task) => task.interrupts)
          .find((item) => {
            const task = planned.tasks.find(
              (task) => task.id === (item.value as InterruptPayload).taskId,
            );
            return (
              task?.status === "waiting-for-input" || task?.id === accepted?.id
            );
          });
        await graph.invoke(
          new Command({
            resume: target?.id ? { [target.id]: answer } : answer,
          }),
          config,
        );
      } else if (resumePersisted || snapshot.next.length) {
        await graph.invoke(null, config);
      }
    } catch (error) {
      if (error instanceof WorkerAbortedError || execution.lost) throw error;
      if (errorCode(error) === "stale-fencing-token") {
        throw new WorkerAbortedError();
      }
      if (error instanceof OrchestrationError || errorCode(error)) {
        return this.handleRunErrorAsync(execution, error, "run-failed");
      }
      throw error;
    }
    const after = await graph.getState(config);
    const interrupts = after.tasks.flatMap((task) =>
      task.interrupts.map((item) => item.value as InterruptPayload),
    );
    if (interrupts.length) {
      return this.suspendAsync(execution, interrupts);
    }
    return this.finishAsync(execution, {});
  }

  private async handleRunErrorAsync(
    execution: Execution,
    error: unknown,
    fallback: string,
  ): Promise<ExecutionResult> {
    if (error instanceof WorkerAbortedError || execution.lost) throw error;
    if (await this.isCancelledAsync(execution)) {
      return this.finishAsync(execution, { status: "cancelled" });
    }
    if (errorCode(error) === "spend-limit-exceeded") {
      await this.markLimitReachedAsync(execution);
      return this.finishAsync(execution, { status: "limit-reached" });
    }
    return this.finishAsync(execution, {
      status: "failed",
      error: sanitizeError(error, fallback),
    });
  }

  private async suspendAsync(
    execution: Execution,
    interrupts: InterruptPayload[],
  ): Promise<ExecutionResult> {
    const { run, scope, lease } = execution;
    await this.refreshCaseUsageAsync(execution);
    await execution.events.emit(
      `${run.id}:input-required:${lease.fencingToken}`,
      {
        type: "input-required",
        questionIds: interrupts.flatMap((item) => item.questionIds),
      },
    );
    const token = await this.repos.runAdmission.waitForInput({
      ownerId: scope.ownerId,
      caseId: scope.caseId,
      runId: run.id,
      leaseId: lease.leaseId,
      fencingToken: lease.fencingToken,
      at: this.timestamp(),
    });
    if (token === null) {
      if (await this.isCancelledAsync(execution)) {
        return this.finishAsync(execution, { status: "cancelled" });
      }
      throw new WorkerAbortedError();
    }
    return {
      outcome: "waiting-for-input",
      run: await this.repos.runs.findOwnedById(run.id, scope.ownerId),
    };
  }

  private async isCancelledAsync(execution: Execution): Promise<boolean> {
    if (
      execution.controller.signal.aborted &&
      execution.controller.signal.reason instanceof RunCancelledError
    ) {
      return true;
    }
    const run = await this.repos.runs.findOwnedById(
      execution.run.id,
      execution.scope.ownerId,
    );
    if (!run || run.fencingToken !== execution.lease.fencingToken) {
      execution.lost = true;
      throw new WorkerAbortedError();
    }
    return run.cancellationRequested;
  }

  private async finishAsync(
    execution: Execution,
    override: { status?: RunStatus; error?: SanitizedError },
  ): Promise<ExecutionResult> {
    await this.finalizeAsync(
      {
        run: execution.run,
        scope: execution.scope,
        lease: execution.lease,
        events: execution.events,
      },
      { ...override, reason: null },
    );
    return {
      outcome: "finalized",
      run: await this.repos.runs.findOwnedById(
        execution.run.id,
        execution.scope.ownerId,
      ),
    };
  }

  private async markLimitReachedAsync(
    execution: Pick<Execution, "run" | "events">,
  ): Promise<void> {
    await execution.events.emit(`${execution.run.id}:limit-reached`, {
      type: "limit-reached",
      limit: "spend",
    });
  }

  /**
   * Settles a run: closes unfinished tasks, records usage, emits the terminal
   * event, releases the lease and only then writes the terminal status.
   */
  private async finalizeAsync(
    target: {
      run: RunRecord;
      scope: OwnerScope;
      lease: RunAdmissionLease | null;
      events?: EventSink;
    },
    override: {
      status?: RunStatus;
      error?: SanitizedError;
      reason: string | null;
    },
  ): Promise<void> {
    const { run, scope, lease } = target;
    const fencing = { fencingToken: lease?.fencingToken ?? run.fencingToken };
    const tasks = await this.repos.tasks.listForRun(run.id, scope);
    const closing: TaskStatus =
      override.status === "cancelled"
        ? "cancelled"
        : override.status === "limit-reached"
          ? "limit-reached"
          : "skipped";
    for (const task of tasks) {
      if (TERMINAL_TASK_STATUSES.includes(task.status)) continue;
      const updated: Task = {
        ...task,
        status: closing,
        lastError:
          closing === "skipped"
            ? (override.error ?? {
                code: "run-ended",
                message: "The run ended before this task ran",
              })
            : task.lastError,
      };
      if (!(await this.repos.tasks.replaceOwned(updated, scope, fencing))) {
        throw new WorkerAbortedError();
      }
      task.status = closing;
    }
    const proposedStatus = override.status ?? this.statusFor(tasks);
    const runUsage = summarizeUsage(
      await this.repos.usageLedger.listForRun(
        scope.ownerId,
        scope.caseId,
        run.id,
      ),
    );
    await this.refreshCaseUsageAsync({ run, scope });
    const deliverable = await this.repos.deliverables.findOwnedById(
      deliverableIdFor(run.id),
      scope,
    );
    if (deliverable) {
      const completed = tasks.filter((task) => task.status === "completed");
      const summary = `${completed.length} of ${tasks.length} tasks completed; sections await professional review.`;
      if (deliverable.summary !== summary && tasks[0]) {
        if (
          !(await this.repos.tasks.commitResult(
            tasks[0],
            {
              evidence: [],
              findings: [],
              deliverable: {
                ...deliverable,
                summary,
                updatedAt: this.timestamp(),
              },
            },
            scope,
            { fencingToken: lease?.fencingToken ?? run.fencingToken },
          ))
        )
          throw new WorkerAbortedError();
      }
    }
    const released = await this.repos.runAdmission.release({
      ownerId: scope.ownerId,
      caseId: scope.caseId,
      runId: run.id,
      leaseId: lease?.leaseId ?? null,
      fencingToken: lease?.fencingToken ?? run.fencingToken,
      at: this.timestamp(),
      terminal: {
        status: proposedStatus,
        usage: runUsage,
        reason: override.reason,
        error: override.error,
      },
    });
    const settled = await this.repos.runs.findOwnedById(run.id, scope.ownerId);
    if (!released || !settled) throw new WorkerAbortedError();
    await this.publishTerminalAsync(settled);
  }

  async publishTerminalAsync(run: RunRecord): Promise<void> {
    if (!run.terminalEvent?.pending || ACTIVE_RUN_STATUSES.includes(run.status))
      return;
    const scope = { ownerId: run.ownerId, caseId: run.caseId };
    const status = run.status;
    const deliverable = await this.repos.deliverables.findOwnedById(
      deliverableIdFor(run.id),
      scope,
    );
    const events = new EventSink(
      this.repos.events,
      scope,
      run.id,
      run.fencingToken,
      this.now,
    );
    const terminalId = `${run.id}:terminal`;
    if (status === "completed" || status === "partially-completed") {
      await events.emit(terminalId, {
        type: "run-completed",
        deliverableIds: deliverable ? [deliverable.id] : [],
      });
    } else if (status === "cancelled") {
      await events.emit(terminalId, {
        type: "run-cancelled",
        reason: run.terminalEvent.reason,
      });
    } else if (status === "limit-reached") {
      await this.markLimitReachedAsync({ run, events });
    } else {
      await events.emit(terminalId, {
        type: "run-failed",
        error: run.terminalEvent.error ?? {
          code: "run-failed",
          message: "No task completed successfully",
        },
      });
    }
    if (
      !(await this.repos.runs.updateOwned(
        {
          ...run,
          terminalEvent: { ...run.terminalEvent, pending: false },
        },
        run.ownerId,
      ))
    )
      throw new WorkerAbortedError();
  }

  private statusFor(tasks: readonly Task[]): RunStatus {
    if (tasks.some((task) => task.status === "cancelled")) return "cancelled";
    if (tasks.some((task) => task.status === "limit-reached")) {
      return "limit-reached";
    }
    const completed = tasks.filter((task) => task.status === "completed");
    if (tasks.length > 0 && completed.length === tasks.length) {
      return "completed";
    }
    return completed.length ? "partially-completed" : "failed";
  }

  private async refreshCaseUsageAsync(target: {
    run: RunRecord;
    scope: OwnerScope;
  }): Promise<void> {
    const { run, scope } = target;
    if (
      !(await this.repos.cases.refreshUsage(scope, {
        runId: run.id,
        fencingToken: run.fencingToken,
        at: this.timestamp(),
      }))
    )
      throw new WorkerAbortedError();
  }

  private async loadTaskAsync(execution: Execution, taskId: string) {
    const tasks = await this.repos.tasks.listForRun(
      execution.run.id,
      execution.scope,
    );
    const task = tasks.find((item) => item.id === taskId);
    if (!task) throw new OrchestrationError("Task is missing", "task-missing");
    return { task, tasks };
  }

  private async persistTaskAsync(execution: Execution, task: Task) {
    const saved = await this.repos.tasks.replaceOwned(task, execution.scope, {
      fencingToken: execution.lease.fencingToken,
    });
    if (!saved) {
      execution.lost = true;
      throw new WorkerAbortedError();
    }
  }

  private async taskUsageAsync(execution: Execution, taskId: string) {
    const entries = await this.repos.usageLedger.listForRun(
      execution.scope.ownerId,
      execution.scope.caseId,
      execution.run.id,
    );
    return entries.filter((entry) => entry.taskId === taskId);
  }

  private outcomeFor(
    task: Task,
    status: TaskOutcomeStatus,
    agentTier: TaskOutcome["modelTier"] = "cheap",
  ): TaskOutcome {
    return {
      taskId: task.id,
      role: task.role,
      status,
      sourceTaskId: task.id,
      summary: "",
      findings: [],
      evidenceIds: [],
      provider: null,
      model: null,
      modelTier: agentTier,
    };
  }

  private async findSectionAsync(
    execution: Execution,
    runId: string,
    key: string,
  ): Promise<DeliverableSection | null> {
    const deliverable = await this.repos.deliverables.findOwnedById(
      deliverableIdFor(runId),
      execution.scope,
    );
    return (
      deliverable?.sections.find(
        (section) => section.id === sectionIdFor(runId, key),
      ) ?? null
    );
  }

  /** Rebuilds a committed task outcome from its deliverable section. */
  private async materializeAsync(
    execution: Execution,
    task: Task,
  ): Promise<TaskOutcome | null> {
    const key = taskKeyOf(task);
    let runId: string | null = execution.run.id;
    for (let depth = 0; runId && depth < 50; depth += 1) {
      const section = await this.findSectionAsync(execution, runId, key);
      if (section) {
        if (runId !== execution.run.id) {
          await this.upsertSectionAsync(
            execution,
            {
              ...section,
              id: sectionIdFor(execution.run.id, key),
            },
            task,
          );
        }
        const content = SectionContentSchema.parse(section.content);
        return {
          taskId: task.id,
          role: section.producingRole,
          status: "completed",
          sourceTaskId: content.taskId,
          summary: content.summary,
          findings: content.findings,
          evidenceIds: section.evidenceIds,
          provider: section.provider,
          model: section.model,
          modelTier: section.routingTier,
        };
      }
      const run: RunRecord | null = await this.repos.runs.findOwnedById(
        runId,
        execution.scope.ownerId,
      );
      runId = run?.priorRunId ?? null;
    }
    return null;
  }

  private async upsertSectionAsync(
    execution: Execution,
    section: DeliverableSection,
    task: Task,
    records: { evidence: Evidence[]; findings: Finding[] } = {
      evidence: [],
      findings: [],
    },
  ): Promise<void> {
    const at = this.timestamp();
    const plan = this.options.plans.get(execution.caseRecord.useCase);
    const deliverable: Deliverable = {
      id: execution.deliverableId,
      caseId: execution.scope.caseId,
      runId: execution.run.id,
      version: 1,
      format: plan.format,
      title: plan.title,
      summary: "",
      sections: [section],
      createdAt: at,
      updatedAt: at,
    };
    if (
      !(await this.repos.tasks.commitResult(
        task,
        { ...records, deliverable },
        execution.scope,
        {
          fencingToken: execution.lease.fencingToken,
        },
      ))
    ) {
      execution.lost = true;
      throw new WorkerAbortedError();
    }
  }

  private ancestorsOf(task: Task, tasks: readonly Task[]): Task[] {
    const byId = new Map(tasks.map((item) => [item.id, item]));
    const seen = new Set<string>();
    const stack = [...task.dependencyIds];
    while (stack.length) {
      const id = stack.pop()!;
      if (seen.has(id)) continue;
      seen.add(id);
      stack.push(...(byId.get(id)?.dependencyIds ?? []));
    }
    return tasks.filter((item) => seen.has(item.id));
  }

  private async priorFindings(
    execution: Execution,
    sources: readonly Task[],
    state: TaskGraphStateValue,
  ): Promise<PriorFinding[]> {
    const [evidence, findings] = await Promise.all([
      this.repos.evidence.listForCase(execution.scope),
      this.repos.findings.listForCase(execution.scope),
    ]);
    const evidenceById = new Map(evidence.map((item) => [item.id, item]));
    const findingsById = new Map(findings.map((item) => [item.id, item]));
    return sources.flatMap((source) => {
      const outcome = state.results[source.id];
      if (outcome?.status !== "completed") return [];
      return outcome.findings.map((finding) => {
        const persisted = findingsById.get(finding.id);
        if (!persisted) {
          throw new Error(`Completed finding ${finding.id} is missing`);
        }
        return {
          taskId: source.id,
          role: outcome.role,
          findingId: finding.id,
          title: finding.title,
          description: finding.description,
          severity: finding.severity,
          confidence: persisted.confidence,
          assumptions: persisted.assumptions,
          openQuestions: persisted.openQuestions,
          evidenceIds: finding.evidenceIds,
          sourceEvidence: finding.evidenceIds.flatMap((id) => {
            const item = evidenceById.get(id);
            if (!item) return [];
            return [
              item.kind === "document"
                ? {
                    kind: item.kind,
                    sourceRef: item.sourceRef,
                    confidence: item.confidence,
                    documentId: item.documentId,
                    location: item.location,
                  }
                : {
                    kind: item.kind,
                    sourceRef: item.sourceRef,
                    confidence: item.confidence,
                    documentId: null,
                    citation: {
                      url: item.citation.url,
                      title: item.citation.title,
                      claim: item.citation.claim,
                      span: item.citation.span,
                    },
                  },
            ];
          }),
          claims: finding.claims,
        };
      });
    });
  }

  private async documentSlicesAsync(
    execution: Execution,
    agent: SpecialistAgent,
    input: SpecialistInput,
  ): Promise<z.infer<typeof DocumentSliceSchema>[]> {
    const documents = await execution.documents.listAsync();
    const candidates = await Promise.all(
      documents
        .slice(0, 10)
        .map((document) => execution.documents.sliceAsync(document.id)),
    );
    const slices: z.infer<typeof DocumentSliceSchema>[] = [];
    const schema = z.toJSONSchema(agent.outputSchema);
    // Reserve room for the AI client's output-correction prompt.
    const limit = this.options.ai.inputTokenLimit(agent.modelTier) - 256;
    const allowance = (documents: typeof slices) =>
      inputTokenAllowance({
        system: agent.systemPrompt,
        input: { ...input, documents },
        schema,
      });
    const available = candidates.filter((slice) => slice !== null);
    for (const [index, original] of available.entries()) {
      const base = allowance(slices);
      const share = Math.floor((limit - base) / (available.length - index));
      const ceiling = Math.min(limit, base + share);
      const trim = (maxChars: number) => {
        let remaining = maxChars;
        const text = (value: string) => {
          const result = value.slice(0, Math.max(0, remaining));
          remaining -= result.length;
          return result;
        };
        const pages = original.pages.map((page) => ({
          ...page,
          text: text(page.text),
        }));
        const tables = original.tables?.map((table) => ({
          ...table,
          text: text(table.text),
        }));
        const total =
          original.pages.reduce((sum, page) => sum + page.text.length, 0) +
          (original.tables ?? []).reduce(
            (sum, table) => sum + table.text.length,
            0,
          );
        return {
          ...original,
          pages,
          tables,
          truncated: original.truncated || total > maxChars,
        };
      };
      if (allowance([...slices, trim(0)]) > ceiling) {
        if (slices.length) slices[slices.length - 1].truncated = true;
        continue;
      }
      let low = 0;
      let high =
        original.pages.reduce((sum, page) => sum + page.text.length, 0) +
        (original.tables ?? []).reduce(
          (sum, table) => sum + table.text.length,
          0,
        );
      while (low < high) {
        const mid = Math.ceil((low + high) / 2);
        if (allowance([...slices, trim(mid)]) <= ceiling) low = mid;
        else high = mid - 1;
      }
      slices.push(trim(low));
    }
    return slices;
  }

  /** One graph node: reconcile durable state, then attempt the task once. */
  private async runTaskNodeAsync(
    execution: Execution,
    planned: Task,
    state: TaskGraphStateValue,
  ): Promise<TaskGraphUpdate> {
    const { task, tasks } = await this.loadTaskAsync(execution, planned.id);
    const result = (outcome: TaskOutcome, resumeKeys: string[] = []) => ({
      results: { [task.id]: outcome },
      resumeKeys,
    });
    if (task.status === "completed") {
      const outcome = await this.materializeAsync(execution, task);
      if (outcome) {
        await this.emitTaskCompletedAsync(
          execution,
          task,
          outcome.findings.map((finding) => finding.id),
        );
        return result(outcome);
      }
      return result(
        await this.failTaskAsync(execution, task, {
          code: "result-missing",
          message: "The committed task result could not be found",
        }),
      );
    }
    if (TERMINAL_TASK_STATUSES.includes(task.status)) {
      if (task.status === "failed" && task.lastError) {
        await this.emitTaskFailedAsync(execution, task, task.lastError);
      }
      return result(this.outcomeFor(task, task.status as TaskOutcomeStatus));
    }
    if (task.status === "running") {
      const section = await this.findSectionAsync(
        execution,
        execution.run.id,
        taskKeyOf(task),
      );
      if (section) {
        await this.completeTaskAsync(execution, task, section.findingIds);
        return result((await this.materializeAsync(execution, task))!);
      }
      const charges = await this.taskUsageAsync(execution, task.id);
      if (charges.length > (task.usageEntryCount ?? task.attemptCount - 1)) {
        await this.repos.usageLedger.markInterrupted(
          execution.scope.ownerId,
          execution.scope.caseId,
          execution.run.id,
          task.id,
          this.timestamp(),
        );
        // The attempt may have been billed without a durable result.
        return result(
          await this.failTaskAsync(execution, task, {
            code: "attempt-interrupted",
            message:
              "The worker stopped during a model call; usage is unknown and the task needs an explicit retry",
          }),
        );
      }
    }
    const blocked = task.dependencyIds.filter(
      (id) => state.results[id]?.status !== "completed",
    );
    if (blocked.length) {
      const updated: Task = {
        ...task,
        status: "skipped",
        lastError: {
          code: "blocked-by-dependency",
          message: `Blocked by ${blocked.length} unfinished dependencies`,
        },
      };
      await this.persistTaskAsync(execution, updated);
      return result(this.outcomeFor(updated, "skipped"));
    }
    let humanInput = task.resumeInput;
    let resumeKeys: string[] = [];
    if (
      task.status === "waiting-for-input" ||
      (task.status === "running" && task.resumeInput !== undefined)
    ) {
      const rounds = await this.inputQuestionRoundsAsync(execution, task);
      for (const questions of rounds) {
        const answer = interrupt<InterruptPayload, ResumeRequest>({
          taskId: task.id,
          questionIds: questions,
        });
        if (task.resumeKeys?.includes(answer.idempotencyKey)) continue;
        humanInput = { ...humanInput, ...answer.input };
        resumeKeys = [answer.idempotencyKey];
      }
    }
    if (await this.isCancelledAsync(execution)) {
      return result(await this.closeTaskAsync(execution, task, "cancelled"));
    }
    if (execution.limitReached) {
      return result(
        await this.closeTaskAsync(execution, task, "limit-reached"),
      );
    }
    const outcome = await this.semaphore.run(async () => {
      if (await this.isCancelledAsync(execution))
        return this.closeTaskAsync(execution, task, "cancelled");
      if (execution.limitReached)
        return this.closeTaskAsync(execution, task, "limit-reached");
      return this.attemptTaskAsync(
        execution,
        task,
        tasks,
        state,
        humanInput,
        resumeKeys,
      );
    });
    return result(outcome, resumeKeys);
  }

  private async inputQuestionRoundsAsync(
    execution: Execution,
    task: Task,
  ): Promise<string[][]> {
    const findings = await this.repos.findings.listForCase(execution.scope);
    return findings
      .filter((item) => item.id.startsWith(`${task.id}:input:`))
      .sort(
        (a, b) =>
          Number(a.id.split(":").at(-1)) - Number(b.id.split(":").at(-1)),
      )
      .map((finding) => finding.openQuestions.map((question) => question.id));
  }

  private async closeTaskAsync(
    execution: Execution,
    task: Task,
    status: "cancelled" | "limit-reached",
  ): Promise<TaskOutcome> {
    const updated: Task = { ...task, status };
    await this.persistTaskAsync(execution, updated);
    return this.outcomeFor(updated, status);
  }

  private async failTaskAsync(
    execution: Execution,
    task: Task,
    error: SanitizedError,
  ): Promise<TaskOutcome> {
    const usage = summarizeUsage(await this.taskUsageAsync(execution, task.id));
    const updated: Task = {
      ...task,
      status: "failed",
      lastError: error,
      usage,
    };
    await this.persistTaskAsync(execution, updated);
    await this.emitTaskFailedAsync(execution, updated, error);
    await this.refreshCaseUsageAsync(execution);
    return this.outcomeFor(updated, "failed");
  }

  private async emitTaskFailedAsync(
    execution: Execution,
    task: Task,
    error: SanitizedError,
  ): Promise<void> {
    await execution.events.emit(`${task.id}:failed:${task.attemptCount}`, {
      type: "task-failed",
      taskId: task.id,
      role: task.role,
      error,
    });
  }

  private async completeTaskAsync(
    execution: Execution,
    task: Task,
    findingIds: readonly string[],
  ) {
    const usage = summarizeUsage(await this.taskUsageAsync(execution, task.id));
    await this.persistTaskAsync(execution, {
      ...task,
      status: "completed",
      lastError: null,
      usage,
    });
    await this.hooks.afterTaskCommit?.(task);
    await this.emitTaskCompletedAsync(
      execution,
      { ...task, usage },
      findingIds,
    );
    await this.refreshCaseUsageAsync(execution);
  }

  private async emitTaskCompletedAsync(
    execution: Execution,
    task: Task,
    findingIds: readonly string[],
  ): Promise<void> {
    for (const findingId of findingIds) {
      await execution.events.emit(`${findingId}:added`, {
        type: "finding-added",
        findingId,
      });
    }
    await execution.events.emit(`${task.id}:completed`, {
      type: "task-completed",
      taskId: task.id,
      role: task.role,
      usage: task.usage,
    });
    const runUsage = summarizeUsage(
      await this.repos.usageLedger.listForRun(
        execution.scope.ownerId,
        execution.scope.caseId,
        execution.run.id,
      ),
    );
    await execution.events.emit(`${task.id}:cost:${task.attemptCount}`, {
      type: "cost-updated",
      usage: runUsage,
    });
  }

  private async attemptTaskAsync(
    execution: Execution,
    current: Task,
    tasks: readonly Task[],
    state: TaskGraphStateValue,
    humanInput: unknown,
    resumeKeys: string[] = [],
  ): Promise<TaskOutcome> {
    const task: Task = {
      ...current,
      status: "running",
      attemptCount:
        current.status === "running"
          ? Math.max(current.attemptCount, 1)
          : current.attemptCount + 1,
      usageEntryCount:
        current.status === "running"
          ? current.usageEntryCount
          : (await this.taskUsageAsync(execution, current.id)).length,
      lastError: null,
      resumeKeys: [...(current.resumeKeys ?? []), ...resumeKeys],
      ...(humanInput === undefined
        ? {}
        : { resumeInput: ResumeRequestSchema.shape.input.parse(humanInput) }),
    };
    await this.persistTaskAsync(execution, task);
    await execution.events.emit(`${task.id}:started:${task.attemptCount}`, {
      type: "task-started",
      taskId: task.id,
      role: task.role,
    });
    const key = taskKeyOf(task);
    const isReview = task.role === REVIEWER_ROLE && this.options.reviewer;
    const specialist = this.specialists.get(task.role);
    if (!isReview && !specialist) {
      return this.failTaskAsync(execution, task, {
        code: "unknown-role",
        message: `No agent is registered for role ${task.role}`,
      });
    }
    await this.hooks.beforeAgentCall?.(task);
    let agentResult: AgentResult<SpecialistOutput | ReviewOutput>;
    let flags: ReturnType<typeof runDeterministicChecks>["flags"] = [];
    let documentIds = new Set<string>();
    try {
      const context = this.contextFor(execution, task.id, humanInput);
      if (isReview) {
        const ancestors = this.ancestorsOf(task, tasks);
        const findings = await this.priorFindings(execution, ancestors, state);
        flags = runDeterministicChecks(
          findings.map((finding) => ({
            id: finding.findingId,
            taskId: finding.taskId,
            title: finding.title,
            severity: finding.severity,
            evidenceIds: finding.evidenceIds,
            claims: finding.claims,
          })),
        ).flags;
        agentResult = await this.options.reviewer!.run(
          {
            case: this.caseInput(execution),
            instructions: this.instructionsFor(execution, task, state),
            findings,
            deterministicFlags: flags,
          },
          context,
        );
      } else {
        const sources =
          execution.caseRecord.useCase === "tax-notice"
            ? this.ancestorsOf(task, tasks)
            : tasks.filter((item) => task.dependencyIds.includes(item.id));
        const input: SpecialistInput = {
          case: this.caseInput(execution),
          task: {
            id: task.id,
            key,
            role: task.role,
            instructions: this.instructionsFor(execution, task, state),
          },
          priorFindings: await this.priorFindings(execution, sources, state),
          documents: [],
          humanInput: humanInput ?? null,
        };
        const documents = await this.documentSlicesAsync(
          execution,
          specialist!,
          input,
        );
        documentIds = new Set(documents.map((document) => document.documentId));
        agentResult = await specialist!.run({ ...input, documents }, context);
      }
    } catch (error) {
      return this.handleTaskErrorAsync(execution, task, error);
    }
    await this.hooks.afterAgentCall?.(task);
    const output = agentResult.output;
    if (!isReview && (output as SpecialistOutput).inputRequired) {
      return this.requestInputAsync(
        execution,
        task,
        (output as SpecialistOutput).inputRequired!.questions,
      );
    }
    const committed = isReview
      ? this.reviewRecords(execution, task, output as ReviewOutput, flags)
      : this.specialistRecords(
          execution,
          task,
          (output as SpecialistOutput).findings,
          documentIds,
        );
    const summary = (output as { summary: string }).summary;
    const evidenceIds = committed.evidence.map((evidence) => evidence.id);
    await this.upsertSectionAsync(
      execution,
      {
        id: sectionIdFor(execution.run.id, key),
        title:
          this.options.plans
            .get(execution.caseRecord.useCase)
            .tasks.find((item) => item.key === key)?.title ?? key,
        kind: "text",
        content: {
          taskId: task.id,
          summary,
          findings: committed.outcomes,
          ...(!isReview && (output as SpecialistOutput).report
            ? { report: (output as SpecialistOutput).report }
            : {}),
          ...(!isReview && (output as SpecialistOutput).dashboard
            ? { dashboard: (output as SpecialistOutput).dashboard }
            : {}),
        },
        reviewerContent: null,
        reviewerId: null,
        reviewedAt: null,
        producingRole: task.role,
        routingTier: agentResult.modelTier,
        provider: agentResult.provider,
        model: agentResult.model,
        findingIds: committed.findings.map((finding) => finding.id),
        evidenceIds,
        reviewStatus: "pending",
        reviewComment: null,
      },
      task,
      committed,
    );
    await this.hooks.afterResultCommit?.(task);
    await this.completeTaskAsync(
      execution,
      task,
      committed.findings.map((finding) => finding.id),
    );
    return {
      taskId: task.id,
      role: task.role,
      status: "completed",
      sourceTaskId: task.id,
      summary,
      findings: committed.outcomes,
      evidenceIds,
      provider: agentResult.provider,
      model: agentResult.model,
      modelTier: agentResult.modelTier,
    };
  }

  private caseInput(execution: Execution) {
    return {
      title: execution.caseRecord.title,
      description: execution.caseRecord.description,
      useCase: execution.caseRecord.useCase,
    };
  }

  private instructionsFor(
    execution: Execution,
    task: Task,
    state: TaskGraphStateValue,
  ): string {
    return (
      task.instructions ??
      state.instructions[task.id] ??
      this.options.plans.instructionsFor(
        execution.caseRecord.useCase,
        taskKeyOf(task),
      ) ??
      "Analyse the case documents and report cited findings."
    );
  }

  private async requestInputAsync(
    execution: Execution,
    task: Task,
    questions: Array<{ text: string; severity: "high" | "medium" | "low" }>,
  ): Promise<TaskOutcome> {
    const findingId = `${task.id}:input:${task.attemptCount}`;
    const finding: Finding = FindingSchema.parse({
      id: findingId,
      caseId: execution.scope.caseId,
      title: "Input required",
      description: `The ${task.role} task needs more information to continue.`,
      severity: "info",
      confidence: 1,
      evidenceIds: [],
      assumptions: [],
      openQuestions: questions.map((question, index) => ({
        id: `${findingId}:q${index}`,
        text: question.text,
        severity: question.severity,
        status: "open",
        resolutionNote: null,
        actorId: null,
        updatedAt: null,
      })),
      createdAt: this.timestamp(),
    });
    const waiting: Task = {
      ...task,
      status: "waiting-for-input",
      usage: summarizeUsage(await this.taskUsageAsync(execution, task.id)),
    };
    if (
      !(await this.repos.tasks.commitResult(
        waiting,
        { evidence: [], findings: [finding] },
        execution.scope,
        {
          fencingToken: execution.lease.fencingToken,
        },
      ))
    )
      throw new WorkerAbortedError();
    // Throws a graph interrupt; the node restarts from its durable state.
    interrupt<InterruptPayload, ResumeRequest>({
      taskId: task.id,
      questionIds: finding.openQuestions.map((question) => question.id),
    });
    throw new OrchestrationError(
      "Interrupt did not suspend",
      "interrupt-failed",
    );
  }

  private async handleTaskErrorAsync(
    execution: Execution,
    task: Task,
    error: unknown,
  ): Promise<TaskOutcome> {
    if (isGraphBubbleUp(error) || error instanceof WorkerAbortedError) {
      throw error;
    }
    if (execution.lost) throw new WorkerAbortedError();
    if (await this.isCancelledAsync(execution)) {
      const usage = summarizeUsage(
        await this.taskUsageAsync(execution, task.id),
      );
      const updated: Task = { ...task, status: "cancelled", usage };
      await this.persistTaskAsync(execution, updated);
      await this.refreshCaseUsageAsync(execution);
      return this.outcomeFor(updated, "cancelled");
    }
    if (errorCode(error) === "spend-limit-exceeded") {
      execution.limitReached = true;
      const usage = summarizeUsage(
        await this.taskUsageAsync(execution, task.id),
      );
      const updated: Task = {
        ...task,
        status: "limit-reached",
        lastError: {
          code: "spend-limit-exceeded",
          message: "The usage limit was reached before this task could run",
        },
        usage,
      };
      await this.persistTaskAsync(execution, updated);
      await this.markLimitReachedAsync(execution);
      await this.refreshCaseUsageAsync(execution);
      return this.outcomeFor(updated, "limit-reached");
    }
    this.logger.warn("Task failed", {
      taskId: task.id,
      code: errorCode(error),
    });
    return this.failTaskAsync(execution, task, sanitizeError(error));
  }

  private specialistRecords(
    execution: Execution,
    task: Task,
    drafts: readonly FindingDraft[],
    documentIds: ReadonlySet<string>,
  ): {
    evidence: Evidence[];
    findings: Finding[];
    outcomes: TaskOutcomeFinding[];
  } {
    const evidence: Evidence[] = [];
    const findings: Finding[] = [];
    const outcomes: TaskOutcomeFinding[] = [];
    const at = this.timestamp();
    drafts.forEach((draft, index) => {
      const findingId = `${task.id}:finding:${index}`;
      const evidenceIds: string[] = [];
      draft.evidence.forEach((item, itemIndex) => {
        const id = `${task.id}:evidence:${index}:${itemIndex}`;
        const candidate =
          item.kind === "document"
            ? item.documentId && documentIds.has(item.documentId)
              ? {
                  kind: "document",
                  id,
                  caseId: execution.scope.caseId,
                  sourceRef: item.sourceRef,
                  confidence: item.confidence,
                  documentId: item.documentId,
                  location: item.location ?? {
                    ...(item.page ? { page: item.page } : {}),
                    ...(item.textQuote ? { textQuote: item.textQuote } : {}),
                  },
                }
              : null
            : {
                kind: "research",
                id,
                caseId: execution.scope.caseId,
                sourceRef: item.sourceRef,
                confidence: item.confidence,
                citation: {
                  url: item.url,
                  title: item.title,
                  retrievedAt: at,
                  claim: item.claim,
                  span: item.textQuote,
                },
              };
        const parsed = EvidenceSchema.safeParse(candidate);
        // Unverifiable citations are dropped; deterministic review flags them.
        if (parsed.success) {
          evidence.push(parsed.data);
          evidenceIds.push(id);
        }
      });
      findings.push(
        FindingSchema.parse({
          id: findingId,
          caseId: execution.scope.caseId,
          title: draft.title,
          description: draft.description,
          severity: draft.severity,
          confidence: draft.confidence,
          evidenceIds,
          assumptions: draft.assumptions,
          openQuestions: draft.openQuestions.map((question, questionIndex) => ({
            id: `${findingId}:q${questionIndex}`,
            text: question.text,
            severity: question.severity,
            status: "open",
            resolutionNote: null,
            actorId: null,
            updatedAt: null,
          })),
          createdAt: at,
        }),
      );
      outcomes.push({
        id: findingId,
        title: draft.title,
        description: draft.description,
        severity: draft.severity,
        evidenceIds,
        claims: draft.claims,
      });
    });
    return { evidence, findings, outcomes };
  }

  private reviewRecords(
    execution: Execution,
    task: Task,
    output: ReviewOutput,
    flags: ReturnType<typeof runDeterministicChecks>["flags"],
  ): {
    evidence: Evidence[];
    findings: Finding[];
    outcomes: TaskOutcomeFinding[];
  } {
    const findingId = `${task.id}:finding:0`;
    const items = [
      ...flags.map((flag) => ({
        text: `[${flag.code}] ${flag.text}`,
        severity: flag.severity,
      })),
      ...output.items.map((item) => ({
        text: item.findingId
          ? `${item.text} (finding ${item.findingId})`
          : item.text,
        severity: item.severity,
      })),
    ];
    const severity = items.some((item) => item.severity === "high")
      ? "high"
      : items.some((item) => item.severity === "medium")
        ? "medium"
        : items.length
          ? "low"
          : "info";
    const finding = FindingSchema.parse({
      id: findingId,
      caseId: execution.scope.caseId,
      title: "Independent review",
      description: output.summary || "Independent review completed.",
      severity,
      confidence: 1,
      evidenceIds: [],
      assumptions: [],
      openQuestions: items.map((item, index) => ({
        id: `${findingId}:q${index}`,
        text: item.text,
        severity: item.severity,
        status: "open",
        resolutionNote: null,
        actorId: null,
        updatedAt: null,
      })),
      createdAt: this.timestamp(),
    });
    return {
      evidence: [],
      findings: [finding],
      outcomes: [
        {
          id: findingId,
          title: finding.title,
          description: finding.description,
          severity,
          evidenceIds: [],
          claims: [],
        },
      ],
    };
  }
}
