import { createAi, MockProvider } from "@evianta/ai";
import {
  MSME_PAYMENT_RECONCILIATION_ROLE,
  createCoordinatorAgent,
  createMsmePaymentPlan,
  createMsmePaymentSpecialists,
  createReviewAgent,
  planCaseAsync,
} from "@evianta/agents";
import { syntheticWorkflowFixtures } from "@evianta/core";
import { describe, expect, it } from "vitest";
import { respondToMockRequest } from "../src/mock-responses.js";

function runtimeAi() {
  return createAi({
    provider: new MockProvider({ respond: respondToMockRequest }),
    accounting: {
      mode: "test",
      admit: async () => undefined,
      record: async () => undefined,
      cancel: async () => undefined,
    },
    models: {
      provider: "mock",
      sparkModel: "mock-spark",
      wonderModel: "mock-wonder",
    },
  });
}

const caseRecord = syntheticWorkflowFixtures.msmePayment.case;

function context() {
  return {
    ownerId: "owner",
    case: caseRecord,
    runId: "run",
    taskId: "task",
    documents: {
      listAsync: async () => [],
      tablesAsync: async () => [],
      sliceAsync: async () => null,
    },
    logger: {
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
    },
    signal: new AbortController().signal,
    usage: {
      userId: "owner",
      caseId: caseRecord.id,
      runId: "run",
      leaseId: "lease",
      fencingToken: 1,
    },
    ai: runtimeAi(),
  };
}

describe("offline mock provider responses", () => {
  it("plans the MSME workflow with the reference task graph", async () => {
    const reference = createMsmePaymentPlan();
    const plan = await planCaseAsync({
      reference,
      caseRecord,
      documents: [],
      availableRoles: new Set(reference.tasks.map((task) => task.role)),
      coordinator: createCoordinatorAgent(),
      context: context(),
    });

    expect(plan.adapted).toBe(true);
    expect(plan.tasks.map((task) => task.key)).toEqual(
      reference.tasks.map((task) => task.key),
    );
  });

  it("answers every MSME specialist and the reviewer with valid output", async () => {
    const input = {
      case: {
        title: caseRecord.title,
        description: caseRecord.description,
        useCase: "msme-payment" as const,
      },
      task: {
        id: "task",
        key: "step",
        role: "role",
        instructions: "Do the step",
      },
      priorFindings: [],
      documents: [],
      humanInput: null,
    };
    for (const specialist of createMsmePaymentSpecialists()) {
      const result = await specialist.run(input, context());
      expect(result.output.findings.length).toBeGreaterThanOrEqual(0);
    }
    expect(
      createMsmePaymentSpecialists().some(
        (specialist) => specialist.role === MSME_PAYMENT_RECONCILIATION_ROLE,
      ),
    ).toBe(true);

    const review = await createReviewAgent().run(
      {
        case: input.case,
        instructions: "Review",
        findings: [],
        deterministicFlags: [],
      },
      context(),
    );
    expect(review.output.items).toEqual([]);
  });
});
