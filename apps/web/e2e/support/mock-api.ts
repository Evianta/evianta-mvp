import {
  syntheticWorkflowFixtures,
  type RunDto,
  type RunEvent,
  type UseCase,
} from "@evianta/core";
import type { Page, Route } from "@playwright/test";

type Payload = RunEvent["payload"];

export interface Segment {
  events: Payload[];
  final: RunDto["status"];
}

export interface MockOptions {
  role?: "user" | "admin";
  maxFiles?: number;
  segments?: Segment[];
  failCreate?: boolean;
  findings?: {
    id: string;
    title: string;
    severity: "high" | "medium" | "low";
  }[];
  failUploadOnce?: string;
  seedCase?: boolean;
  seedStatus?: RunDto["status"];
  questions?: { id: string; text: string }[];
  historicalQuestions?: { id: string; text: string }[];
  failResumeOnce?: boolean;
  deliverableContent?: unknown;
}

export interface MockState {
  created: Record<string, unknown>[];
  uploads: string[];
  uploadAttempts: string[];
  runs: number;
  resumes: Record<string, unknown>[];
  streamCalls: number;
  status: RunDto["status"] | null;
  authTokens: string[];
}

const base = syntheticWorkflowFixtures.dataAnalysis.case;
const timestamp = "2026-11-02T10:00:00.000Z";
const usage = {
  inputUnits: 1200,
  outputUnits: 340,
  totalUnits: 1540,
  costUsd: 0.0123,
  costStatus: "estimated" as const,
  reservedUsd: 0,
};

export const defaultSegments: Segment[] = [
  {
    final: "completed",
    events: [
      { type: "run-started", planVersion: 1 },
      { type: "task-started", taskId: "t1", role: "business-data-analyst" },
      { type: "finding-added", findingId: "finding-1" },
      {
        type: "task-completed",
        taskId: "t1",
        role: "business-data-analyst",
        usage,
      },
      { type: "task-started", taskId: "t2", role: "independent-reviewer" },
      {
        type: "task-completed",
        taskId: "t2",
        role: "independent-reviewer",
        usage,
      },
      { type: "run-completed", deliverableIds: ["deliverable-1"] },
    ],
  },
];

export const waitingSegments: Segment[] = [
  {
    final: "waiting-for-input",
    events: [
      { type: "run-started", planVersion: 1 },
      { type: "task-started", taskId: "t1", role: "tax-notice-analyst" },
      { type: "input-required", questionIds: ["t1:input:1:q0"] },
    ],
  },
  {
    final: "completed",
    events: [
      {
        type: "task-completed",
        taskId: "t1",
        role: "tax-notice-analyst",
        usage,
      },
      { type: "run-completed", deliverableIds: ["deliverable-1"] },
    ],
  },
];

export const agents = [
  ["coordinator", "Evianta", "lead"],
  ["business-data-analyst", "Business Data Analyst", "specialist"],
  ["tax-notice-analyst", "Tax Notice Analyst", "specialist"],
  ["independent-reviewer", "Independent Reviewer", "reviewer"],
].map(([role, displayName, kind]) => ({
  id: `agent-${role}`,
  role,
  displayName,
  specialty: kind === "lead" ? "Lead agent and work planning" : "Specialty",
  summary: `${displayName} summary.`,
  capabilities: ["Does careful work"],
  tools: [],
  procedures: ["Cites sources"],
  outputFormats: ["findings"],
  limitations: ["Needs review"],
  modelTier: "mid",
  enabled: true,
  kind,
  workflows: ["data-analysis", "tax-notice", "msme-payment"],
}));

function json(route: Route, body: unknown, status = 200) {
  return route.fulfill({ status, json: body });
}

export async function mockApi(page: Page, options: MockOptions = {}) {
  const state: MockState = {
    created: [],
    uploads: [],
    uploadAttempts: [],
    runs: 0,
    resumes: [],
    streamCalls: 0,
    status: null,
    authTokens: [],
  };
  const segments = (options.segments ?? defaultSegments).map((segment) => ({
    ...segment,
    events: segment.events.map((event) =>
      event.type === "input-required" && options.questions
        ? {
            ...event,
            questionIds: options.questions.map((question) => question.id),
          }
        : event,
    ),
  }));
  const findings = options.findings ?? [
    { id: "finding-1", title: "Revenue grew 12 percent", severity: "medium" },
  ];
  let record: Record<string, unknown> | null = null;
  const documents: Record<string, unknown>[] = [];

  const caseId = "case-1";
  if (options.seedCase) {
    record = {
      ...base,
      id: caseId,
      ownerId: "user-1",
      isSample: false,
      synthetic: false,
      sourceCaseId: null,
      status: "active",
      useCase: "data-analysis",
      title: "Analyze my sales",
      description: "Analyze my sales spreadsheet and highlight trends",
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    documents.push({
      id: "doc-1",
      caseId,
      name: "sales.csv",
      mimeType: "text/csv",
      sizeBytes: 30,
      state: "ready",
      uploadedAt: timestamp,
      processedAt: timestamp,
    });
    state.status = options.seedStatus ?? "completed";
  }
  const run = (status: RunDto["status"]) => ({
    id: "run-1",
    caseId,
    status,
    planVersion: 1,
    priorRunId: null,
    cancellationRequested: false,
    inputRequired: status === "waiting-for-input",
    usage,
    createdAt: timestamp,
    updatedAt: timestamp,
  });
  const finding = (item: (typeof findings)[number]) => ({
    id: item.id,
    caseId,
    title: item.title,
    description: `${item.title}. This is the detailed explanation of the finding.`,
    severity: item.severity,
    confidence: 0.86,
    evidenceIds: [],
    assumptions: ["Rows are complete for the quarter"],
    openQuestions: [],
    createdAt: timestamp,
  });
  const workspace = () => {
    const done = state.status === "completed";
    const inputFinding =
      state.status === "waiting-for-input"
        ? [
            {
              ...finding({
                id: "t1:input:1",
                title: "Input required",
                severity: "low",
              }),
              severity: "info",
              openQuestions: (
                options.questions ?? [
                  {
                    id: "t1:input:1:q0",
                    text: "Which bank account were the payments received in?",
                  },
                ]
              ).map((question) => ({
                ...question,
                severity: "medium",
                status: "open",
                resolutionNote: null,
                actorId: null,
                updatedAt: null,
              })),
            },
          ]
        : [];
    const historicalInputFindings = (options.historicalQuestions ?? []).map(
      (question, index) => ({
        ...finding({
          id: `historical-${index}:input:1`,
          title: "Previous input required",
          severity: "low" as const,
        }),
        severity: "info" as const,
        openQuestions: [
          {
            ...question,
            severity: "medium" as const,
            status: "open" as const,
            resolutionNote: null,
            actorId: null,
            updatedAt: null,
          },
        ],
      }),
    );
    return {
      case: record,
      documents,
      findings:
        done || state.status
          ? [
              ...findings.map(finding),
              ...inputFinding,
              ...historicalInputFindings,
            ]
          : [],
      evidence: [],
      deliverables: done
        ? [
            {
              id: "deliverable-1",
              caseId,
              runId: "run-1",
              version: 1,
              format: "report",
              title: "Quarterly sales report",
              summary:
                "Revenue grew 12 percent quarter over quarter. One data quality issue needs your attention.",
              sections: [
                {
                  id: "section-1",
                  title: "Summary",
                  kind: "text",
                  content: options.deliverableContent ?? "Summary",
                  reviewerContent: null,
                  reviewerId: null,
                  reviewedAt: null,
                  producingRole: "business-data-analyst",
                  routingTier: "mid",
                  provider: null,
                  model: null,
                  findingIds: findings.map((item) => item.id),
                  evidenceIds: [],
                  reviewStatus: "pending",
                  reviewComment: null,
                },
              ],
              createdAt: timestamp,
              updatedAt: timestamp,
            },
          ]
        : [],
      approvals: [],
    };
  };

  await page.route("**/auth/token", async (route) => {
    const body = route.request().postDataJSON() as { accessKey: string };
    state.authTokens.push(body.accessKey);
    await json(route, {
      accessToken: "chat-session-token",
      expiresAt: new Date(Date.now() + 8 * 3600_000).toISOString(),
    });
  });
  await page.route("**/auth/me", (route) =>
    json(route, {
      user: {
        id: "user-1",
        email: "juror@example.test",
        displayName: "Juror",
        role: options.role ?? "user",
      },
      session: { expiresAt: new Date(Date.now() + 8 * 3600_000).toISOString() },
    }),
  );
  await page.route("**/auth/logout", (route) => route.fulfill({ status: 204 }));
  await page.route("**/directory/agents", (route) => json(route, { agents }));
  await page.route("**/intake/configuration", (route) =>
    json(route, {
      workflows: ["data-analysis", "tax-notice", "msme-payment"],
      uploadMaxBytes: 5 * 1024 * 1024,
      uploadMaxFiles: options.maxFiles ?? 5,
      documentMaxPages: 50,
    }),
  );
  await page.route("**/cases", (route) => {
    if (route.request().resourceType() !== "fetch") return route.continue();
    if (route.request().method() === "GET") {
      return json(route, { cases: record ? [record] : [], nextCursor: null });
    }
    if (options.failCreate) return route.abort("failed");
    const input = route.request().postDataJSON() as Record<string, unknown>;
    state.created.push(input);
    record = {
      ...base,
      id: caseId,
      ownerId: "user-1",
      isSample: false,
      synthetic: false,
      sourceCaseId: null,
      status: "active",
      ...input,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    return json(route, { case: record }, 201);
  });
  await page.route(/\/cases\/case-1$/, (route) => {
    if (route.request().resourceType() !== "fetch") return route.continue();
    return json(route, workspace());
  });
  await page.route("**/cases/case-1/documents", (route) => {
    const name = /filename="([^"]+)"/.exec(
      route.request().postData() ?? "",
    )?.[1];
    state.uploadAttempts.push(name ?? "");
    if (
      options.failUploadOnce &&
      name === options.failUploadOnce &&
      state.uploadAttempts.filter((entry) => entry === name).length === 1
    ) {
      return json(
        route,
        { error: { message: "Temporary upload failure." } },
        400,
      );
    }
    const document = {
      id: `doc-${documents.length + 1}`,
      caseId,
      name: name ?? `file-${documents.length + 1}`,
      mimeType: "text/csv",
      sizeBytes: 30,
      state: "ready",
      uploadedAt: timestamp,
      processedAt: timestamp,
    };
    documents.push(document);
    state.uploads.push(document.name);
    return json(route, { documents: [document] }, 201);
  });
  await page.route("**/runs", (route) => {
    if (route.request().resourceType() !== "fetch") return route.continue();
    state.runs += 1;
    state.status = "queued";
    return json(route, { run: run("queued") });
  });
  await page.route("**/cases/case-1/runs/latest", (route) =>
    json(route, { run: state.status ? run(state.status) : null }),
  );
  await page.route("**/cases/case-1/runs/run-1/resume", (route) => {
    state.resumes.push(
      route.request().postDataJSON() as Record<string, unknown>,
    );
    if (options.failResumeOnce && state.resumes.length === 1) {
      return route.abort("failed");
    }
    state.status = "running";
    return json(route, { outcome: "finalized", run: run("running") });
  });
  await page.route(/\/cases\/case-1\/stream/, (route) => {
    const url = new URL(route.request().url());
    const after = Number(url.searchParams.get("afterSequence") ?? "0");
    const index = Math.min(state.streamCalls, segments.length - 1);
    state.streamCalls += 1;
    let sequence = 0;
    const frames: string[] = [];
    segments.forEach((segment, segmentIndex) => {
      for (const payload of segment.events) {
        sequence += 1;
        if (segmentIndex === index && sequence > after) {
          const event = {
            id: `event-${sequence}`,
            caseId,
            runId: "run-1",
            sequence,
            occurredAt: timestamp,
            payload,
          };
          frames.push(`id: ${event.id}\ndata: ${JSON.stringify(event)}\n\n`);
        }
      }
    });
    state.status = segments[index]?.final ?? "completed";
    return route.fulfill({
      status: 200,
      contentType: "text/event-stream",
      body: frames.join(""),
    });
  });
  return state;
}

export const csv = {
  name: "sales.csv",
  mimeType: "text/csv",
  buffer: Buffer.from("month,revenue\nJan,100\nFeb,200\nMar,250"),
};

export type { UseCase };
