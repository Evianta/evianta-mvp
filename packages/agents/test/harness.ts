import {
  MockProvider,
  createAdmittedUsageAccounting,
  createAi,
  pricingSettingsKey,
  type Citation,
  type UsageAccounting,
  type ModelProvider,
  type StructuredGenerationRequest,
} from "@evianta/ai";
import {
  CaseSchema,
  syntheticWorkflowFixtures,
  type AgentProfile,
  type Case,
  type UsageAdmissionPort,
  type UsagePrice,
  type UsageUnits,
} from "@evianta/core";
import { createInMemoryStore } from "@evianta/store";
import { MemorySaver, type BaseCheckpointSaver } from "@langchain/langgraph";
import {
  Orchestrator,
  PlanRegistry,
  RunWorker,
  createCoordinatorAgent,
  createReviewAgent,
  createSpecialistAgent,
  genericAnalystProfile,
  type OrchestratorHooks,
  type SpecialistAgent,
  type OrchestratorRepositories,
  type ReferencePlan,
  type SpecialistOutput,
} from "../src/index.js";

export const OWNER = "user-1";
export const CASE_ID = "case-1";
export const DOCUMENT_ID = "document-1";
export const START = Date.parse("2026-06-01T12:00:00.000Z");
export const LEASE_TTL_SECONDS = 30;

export type Store = ReturnType<typeof createInMemoryStore>;
export type Repositories = Store["repositories"];

export const UNITS: UsageUnits = {
  input: 400,
  output: 100,
  total: 500,
  reasoning: null,
  cacheRead: 0,
  cacheWrite: 0,
  search: 0,
};

export class Clock {
  constructor(public ms = START) {}
  now = (): Date => new Date(this.ms);
  advance(seconds: number): void {
    this.ms += seconds * 1_000;
  }
}

type RouteHandler = (input: Record<string, unknown>) => unknown;

/**
 * Routes structured calls to scripted outputs by agent, then answers through
 * the package mock provider so the real AI client path is exercised.
 */
export class ScriptedProvider implements ModelProvider {
  readonly providerName = "mock" as const;
  readonly calls: string[] = [];
  readonly inputs = new Map<string, Record<string, unknown>[]>();
  active = 0;
  maxActive = 0;

  constructor(
    public routes: Record<string, RouteHandler>,
    private readonly delayMs = 0,
    private readonly citationsByRoute: Record<string, Citation[]> = {},
  ) {}

  async generateStructured(request: StructuredGenerationRequest) {
    const input = request.input as Record<string, unknown>;
    const route = request.system.startsWith("You plan")
      ? "coordinator"
      : request.system.startsWith("You independently")
        ? "review"
        : request.system.startsWith("You are a careful business data analyst.")
          ? "business-data-analyst"
          : request.system.startsWith("You are a tax research assistant")
            ? "tax-search"
            : (input.task as { key: string }).key;
    this.calls.push(route);
    this.inputs.set(route, [...(this.inputs.get(route) ?? []), input]);
    this.active += 1;
    this.maxActive = Math.max(this.maxActive, this.active);
    try {
      if (this.delayMs) {
        await new Promise((resolve) => setTimeout(resolve, this.delayMs));
      }
      const handler = this.routes[route];
      if (!handler) throw new Error(`No scripted route for ${route}`);
      const output = handler(input);
      const result = await new MockProvider({
        responses: [JSON.stringify(output)],
        units: UNITS,
      }).generateStructured(request);
      return {
        ...result,
        citations: this.citationsByRoute[route] ?? result.citations,
      };
    } finally {
      this.active -= 1;
    }
  }

  async *streamText(): AsyncIterable<string> {
    yield "";
  }

  count(route: string): number {
    return this.calls.filter((call) => call === route).length;
  }
}

export function specialistOutput(
  key: string,
  overrides: Partial<SpecialistOutput["findings"][number]> = {},
): SpecialistOutput {
  return {
    summary: `${key} summary`,
    findings: [
      {
        title: `${key} finding`,
        description: `${key} description`,
        severity: "medium",
        confidence: 0.8,
        evidence: [
          {
            kind: "document",
            sourceRef: `${DOCUMENT_ID}#page=1`,
            confidence: "high",
            documentId: DOCUMENT_ID,
            page: 1,
            textQuote: "Revenue 100",
            url: null,
            title: null,
            claim: null,
          },
        ],
        assumptions: [],
        openQuestions: [],
        claims: [
          {
            label: `${key} revenue`,
            value: 100,
            components: [60, 40],
            date: null,
          },
        ],
        ...overrides,
      },
    ],
    inputRequired: null,
  };
}

export const reviewOutput = { summary: "Reviewed", items: [] };

export function profileFor(role: string): AgentProfile {
  return {
    ...genericAnalystProfile,
    id: `agent-${role}`,
    role,
    displayName: role,
  };
}

export function planOf(
  tasks: Array<{ key: string; role?: string; dependsOn?: string[] }>,
  useCase: ReferencePlan["useCase"] = "data-analysis",
): ReferencePlan {
  return {
    useCase,
    version: 1,
    title: "Case report",
    format: "report",
    tasks: tasks.map((task) => ({
      key: task.key,
      role: task.role ?? "analyst",
      title: `Section ${task.key}`,
      dependsOn: task.dependsOn ?? [],
      required: true,
      instructions: `Do ${task.key}`,
    })),
  };
}

export function makeCase(id = CASE_ID, overrides: Partial<Case> = {}): Case {
  return CaseSchema.parse({
    ...syntheticWorkflowFixtures.dataAnalysis.case,
    id,
    title: id,
    useCase: "data-analysis",
    ownerId: OWNER,
    isSample: false,
    synthetic: true,
    sourceCaseId: null,
    status: "active",
    usage: {
      inputUnits: 0,
      outputUnits: 0,
      totalUnits: 0,
      costUsd: 0,
      costStatus: "estimated",
      reservedUsd: 0,
    },
    ...overrides,
  });
}

function priceFor(model: string): UsagePrice {
  const settings = { maxOutputTokens: 1000 };
  return {
    id: `price-${model}`,
    provider: "mock",
    model,
    settingsKey: pricingSettingsKey(settings),
    settings,
    currency: "USD",
    inputUsdPerMillion: 1,
    outputUsdPerMillion: 2,
    cacheReadUsdPerMillion: 0.5,
    cacheWriteUsdPerMillion: 1,
    searchUsdPerRequest: 0.01,
    version: 1,
    source: "operator",
    effectiveAt: "2026-01-01T00:00:00.000Z",
  };
}

export async function seedAsync(
  repositories: Pick<
    Repositories,
    "cases" | "documents" | "extractions" | "usagePrices"
  >,
  caseId = CASE_ID,
): Promise<void> {
  const at = new Date(START).toISOString();
  await repositories.cases.insert(makeCase(caseId));
  const scope = { ownerId: OWNER, caseId };
  await repositories.documents.insert(
    {
      id: DOCUMENT_ID,
      caseId,
      name: "ledger.pdf",
      mimeType: "application/pdf",
      sizeBytes: 100,
      state: "ready",
      uploadedAt: at,
      processedAt: at,
      objectKey: "object-key",
      contentHash: "content-hash",
    },
    scope,
  );
  await repositories.extractions.saveForDocument(
    {
      documentId: DOCUMENT_ID,
      kind: "text",
      method: "pdf-text",
      confidence: 1,
      pages: [
        {
          index: 0,
          text: "Revenue 100 (60 + 40)",
          width: null,
          height: null,
          method: "pdf-text",
          confidence: 1,
          spans: [],
        },
      ],
      tables: [],
      warnings: [],
      cacheIdentity: {
        contentHash: "content-hash",
        extractorVersion: "1",
        modelVersion: null,
      },
    },
    scope,
  );
  for (const model of ["mock-spark", "mock-wonder"]) {
    try {
      await repositories.usagePrices.insert(priceFor(model));
    } catch {
      // Prices are global and may already be seeded.
    }
  }
}

export interface HarnessOptions {
  repositories: Repositories;
  checkpointer?: BaseCheckpointSaver;
  clock?: Clock;
  provider: ModelProvider;
  plan: ReferencePlan;
  specialists?: readonly SpecialistAgent[];
  roles?: string[];
  reviewer?: boolean;
  coordinator?: boolean;
  hooks?: OrchestratorHooks;
  graphVersion?: string;
  maxBranchConcurrency?: number;
  admission?: (port: UsageAdmissionPort) => UsageAdmissionPort;
  accounting?: UsageAccounting;
}

export function createHarness(options: HarnessOptions) {
  const clock = options.clock ?? new Clock();
  const checkpointer = options.checkpointer ?? new MemorySaver();
  const repositories = options.repositories;
  const admission = options.admission
    ? options.admission(repositories.usageAdmission)
    : repositories.usageAdmission;
  const ai = createAi({
    provider: options.provider,
    accounting:
      options.accounting ??
      createAdmittedUsageAccounting({
        admission,
        runAdmission: repositories.runAdmission,
        prices: repositories.usagePrices,
        limits: {
          userSpendLimitUsd: 10,
          globalSpendLimitUsd: 100,
          spendPeriodSeconds: 86_400,
        },
        now: clock.now,
        runLeaseTtlSeconds: LEASE_TTL_SECONDS,
      }),
    models: {
      provider: "mock",
      sparkModel: "mock-spark",
      wonderModel: "mock-wonder",
      maxInputTokens: 32_000,
      maxOutputTokens: 1000,
    },
  });
  const plans = new PlanRegistry().register(options.plan);
  const roles = options.roles ?? [
    ...new Set(
      options.plan.tasks
        .map((task) => task.role)
        .filter((role) => role !== "independent-reviewer"),
    ),
  ];
  const orchestrator = new Orchestrator({
    repositories: repositories as OrchestratorRepositories,
    ai,
    plans,
    specialists:
      options.specialists ??
      roles.map((role) =>
        createSpecialistAgent(profileFor(role), `Specialist ${role}`),
      ),
    reviewer: options.reviewer === false ? undefined : createReviewAgent(),
    coordinator: options.coordinator ? createCoordinatorAgent() : undefined,
    checkpointer,
    graphVersion: options.graphVersion,
    maxBranchConcurrency: options.maxBranchConcurrency,
    leaseTtlSeconds: LEASE_TTL_SECONDS,
    now: clock.now,
    hooks: options.hooks,
  });
  const worker = new RunWorker({
    orchestrator,
    runs: repositories.runs,
    now: clock.now,
  });
  return { orchestrator, worker, clock, checkpointer, plans };
}

export function newMemoryStore(): Store {
  return createInMemoryStore();
}
