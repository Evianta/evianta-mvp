import { randomUUID } from "node:crypto";
import type { RunRecord, RunRepository } from "@evianta/core";
import { silentLogger, type AgentLogger } from "./agent.js";
import { errorCode } from "./errors.js";
import type { ExecutionResult, Orchestrator } from "./orchestrator.js";

const SKIPPABLE_ADMISSION_CODES = new Set([
  "run-case-active",
  "run-concurrency-limit",
  "run-not-owned",
  "stale-run-admission",
  "invalid-run-admission",
  "case-not-owned",
  "run-admission-counter-conflict",
]);

export interface RunWorkerOptions {
  orchestrator: Orchestrator;
  runs: Pick<RunRepository, "listClaimable">;
  workerId?: string;
  pollIntervalMs?: number;
  batchSize?: number;
  now?: () => Date;
  logger?: AgentLogger;
}

/**
 * Claims queued or abandoned runs through fenced admission and executes
 * them. Durable MongoDB leases, not in-process promises, decide ownership:
 * a crashed worker's runs become claimable once their lease expires.
 */
export class RunWorker {
  readonly workerId: string;
  private readonly now: () => Date;
  private readonly logger: AgentLogger;
  private stopping = false;
  private loop: Promise<void> | null = null;
  private current: Promise<unknown> | null = null;
  private wake: (() => void) | null = null;
  private cursor: Pick<RunRecord, "createdAt" | "id"> | undefined;

  constructor(private readonly options: RunWorkerOptions) {
    this.workerId = options.workerId ?? `worker:${randomUUID()}`;
    this.now = options.now ?? (() => new Date());
    this.logger = options.logger ?? silentLogger;
  }

  /** Claims and executes at most one run. Returns null when idle. */
  async runOnceAsync(): Promise<ExecutionResult | null> {
    const candidates = await this.options.runs.listClaimable(
      this.now().toISOString(),
      this.options.batchSize ?? 10,
      this.cursor,
    );
    if (!candidates.length) this.cursor = undefined;
    for (const run of candidates) {
      if (this.stopping) return null;
      this.cursor = { createdAt: run.createdAt, id: run.id };
      if (run.terminalEvent?.pending) {
        await this.options.orchestrator.publishTerminalAsync(run);
        return { outcome: "finalized", run };
      }
      if (run.cancellationRequested) {
        const cancelled = await this.options.orchestrator.cancelRunAsync({
          ownerId: run.ownerId,
          runId: run.id,
        });
        return { outcome: "finalized", run: cancelled };
      }
      let lease;
      try {
        lease = await this.options.orchestrator.acquireAsync(
          run,
          `${this.workerId}:${randomUUID()}`,
        );
      } catch (error) {
        if (SKIPPABLE_ADMISSION_CODES.has(errorCode(error) ?? "")) continue;
        throw error;
      }
      const execution = this.options.orchestrator.executeClaimedRunAsync(
        run.id,
        run.ownerId,
        lease,
      );
      this.current = execution;
      try {
        this.cursor = undefined;
        return await execution;
      } finally {
        this.current = null;
      }
    }
    return null;
  }

  /** Polls until stopped; errors are logged and the loop continues. */
  start(): void {
    if (this.loop) return;
    this.stopping = false;
    this.loop = (async () => {
      while (!this.stopping) {
        let worked = false;
        try {
          worked = (await this.runOnceAsync()) !== null;
        } catch (error) {
          this.logger.error("Run worker iteration failed", {
            workerId: this.workerId,
            code: errorCode(error),
          });
        }
        if (!worked && !this.stopping) {
          await new Promise<void>((resolve) => {
            const timer = setTimeout(
              resolve,
              this.options.pollIntervalMs ?? 1_000,
            );
            this.wake = () => {
              clearTimeout(timer);
              resolve();
            };
          });
          this.wake = null;
        }
      }
    })();
  }

  /**
   * Stops claiming new work and waits for the in-flight run to reach a
   * durable boundary. Unfinished runs keep their lease until it expires and
   * are then recovered by another worker.
   */
  async stopAsync(): Promise<void> {
    this.stopping = true;
    this.wake?.();
    await this.current?.catch(() => undefined);
    await this.loop;
    this.loop = null;
  }
}
