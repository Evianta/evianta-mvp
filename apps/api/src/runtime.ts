import {
  MockProvider,
  MuseProvider,
  createAdmittedUsageAccounting,
  createAi,
  type UsageAccounting,
} from "@evianta/ai";
import {
  PlanRegistry,
  RunWorker,
  Orchestrator,
  BUSINESS_DATA_ANALYST_ROLE,
  createBusinessDataAnalystAgent,
  createGenericAnalystAgent,
  createMongoCheckpointerAsync,
  createCoordinatorAgent,
  createReviewAgent,
  createTaxNoticePlan,
  createTaxNoticeSpecialists,
  taxNoticeProfiles,
  seedAgentDirectoryAsync,
  createTrivialReferencePlan,
} from "@evianta/agents";
import {
  getAiEnvironment,
  getDocumentStoreConfig,
  getUploadEnvironment,
  getUsageEnvironment,
} from "@evianta/env/server";
import { createDocumentIngestion } from "@evianta/ingestion";
import {
  connectMongoStore,
  createDocumentStore,
  StoreError,
} from "@evianta/store";
import type { CaseApiServices } from "./routes.js";

export interface ApiRuntime {
  services: CaseApiServices;
  repositories: Awaited<ReturnType<typeof connectMongoStore>>["repositories"];
  worker: RunWorker;
  close(): Promise<void>;
}

export function createApiMockProvider(): MockProvider {
  return new MockProvider({
    responses: [
      JSON.stringify({
        summary: "Analysis completed using the supplied case record.",
        findings: [],
        inputRequired: null,
        interpretation:
          "No significant trend was identified in the supplied records.",
        insights: [],
        tasks: createTaxNoticePlan().tasks.map((task) => ({
          key: task.key,
          assignedRole: task.role,
          dependsOn: task.dependsOn,
          instructions: task.instructions,
        })),
        items: [],
      }),
    ],
  });
}

export async function createApiRuntime(): Promise<ApiRuntime> {
  const uploads = getUploadEnvironment();
  const documentStoreConfig = getDocumentStoreConfig();
  const aiEnvironment = getAiEnvironment();
  const usage = getUsageEnvironment();
  const store = await connectMongoStore().catch((error: unknown) => {
    if (
      error instanceof StoreError &&
      error.code === "mongodb-transactions-required"
    ) {
      console.error("Database configuration invalid", {
        code: error.code,
        message: error.message,
      });
    }
    throw error;
  });
  try {
    const storage = createDocumentStore(documentStoreConfig);
    const checkpointer = await createMongoCheckpointerAsync({
      client: store.client,
      dbName: store.databaseName,
    });
    await seedAgentDirectoryAsync(store.repositories.agentProfiles);
    await seedAgentDirectoryAsync(
      store.repositories.agentProfiles,
      taxNoticeProfiles.map((profile) => ({ profile })),
    );

    const accounting: UsageAccounting =
      usage.mode === "enforced"
        ? createAdmittedUsageAccounting({
            admission: store.repositories.usageAdmission,
            runAdmission: store.repositories.runAdmission,
            prices: store.repositories.usagePrices,
            limits: {
              userSpendLimitUsd: usage.userSpendLimitUsd,
              globalSpendLimitUsd: usage.globalSpendLimitUsd,
              spendPeriodSeconds: usage.spendPeriodSeconds,
            },
            runLeaseTtlSeconds: 120,
          })
        : {
            mode: "test",
            admit: async () => undefined,
            record: async () => undefined,
            cancel: async () => undefined,
          };
    const provider =
      aiEnvironment.provider === "muse"
        ? new MuseProvider({
            apiKey: aiEnvironment.modelApiKey ?? "",
            baseUrl: aiEnvironment.museBaseUrl,
          })
        : createApiMockProvider();
    const ai = createAi({
      provider,
      accounting,
      models: {
        provider: aiEnvironment.provider,
        sparkModel: aiEnvironment.museSparkModel ?? "mock-spark",
        wonderModel: aiEnvironment.museWonderModel ?? "mock-wonder",
        maxInputTokens: usage.modelMaxInputTokens,
        maxOutputTokens: usage.modelMaxOutputTokens,
      },
    });
    const dataAnalysisPlan = createTrivialReferencePlan("data-analysis");
    dataAnalysisPlan.title = "Sales data analysis";
    dataAnalysisPlan.format = "dashboard";
    dataAnalysisPlan.tasks = [
      {
        key: "sales-analysis",
        role: BUSINESS_DATA_ANALYST_ROLE,
        title: "Sales analysis",
        dependsOn: [],
        required: true,
        instructions:
          "Compute sales metrics and data-quality checks deterministically, then interpret the results.",
      },
    ];
    const plans = new PlanRegistry()
      .register(dataAnalysisPlan)
      .register(createTaxNoticePlan())
      .register(createTrivialReferencePlan("msme-payment"));
    const ingestion = createDocumentIngestion({
      documents: store.repositories.documents,
      extractions: store.repositories.extractions,
      storage,
      ocr: null,
      options: {
        limits: {
          maxBytes: uploads.uploadMaxBytes,
          maxPages: uploads.documentMaxPages,
        },
      },
    });
    const orchestrator = new Orchestrator({
      repositories: store.repositories,
      refreshTabularExtraction: async (documentId, scope) => {
        const result = await ingestion.ingest({ scope, documentId });
        if (result.status !== "ready")
          throw new Error("The tabular source could not be refreshed.");
      },
      ai,
      plans,
      specialists: [
        createBusinessDataAnalystAgent(),
        createGenericAnalystAgent(),
        ...createTaxNoticeSpecialists(),
      ],
      coordinator: createCoordinatorAgent(),
      reviewer: createReviewAgent(),
      checkpointer,
      userRunLimit: usage.userMaxConcurrentRuns,
      globalRunLimit: usage.globalMaxConcurrentRuns,
      leaseTtlSeconds: 120,
    });
    const services: CaseApiServices = {
      repositories: store.repositories,
      storage,
      orchestrator,
      usageAdmin: store.repositories.usageAdmin,
      uploads,
      ingestion,
    };
    const worker = new RunWorker({
      orchestrator,
      runs: store.repositories.runs,
    });

    return {
      services,
      repositories: store.repositories,
      worker,
      close: () => store.close(),
    };
  } catch (error) {
    await store.close();
    throw error;
  }
}
