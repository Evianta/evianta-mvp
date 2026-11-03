import {
  ApprovalSchema,
  AgentProfileSetSchema,
  CaseSchema,
  CreateCaseRequestSchema,
  CreateRunRequestSchema,
  DocumentMetadataDtoSchema,
  RunDtoSchema,
  RunEventSchema,
  UsageSummarySchema,
  isApprovalCurrent,
  syntheticWorkflowFixtures,
  liveWorkflows,
  type Approval,
  type AgentProfileRepository,
  type ApprovalRepository,
  type Case,
  type CaseRepository,
  type Deliverable,
  type DeliverableRepository,
  type DocumentMetadataDto,
  type DocumentMetadataRecord,
  type DocumentRepository,
  type DocumentStore,
  type EvidenceRepository,
  type ExtractionRepository,
  type FindingRepository,
  type RunEventRepository,
  type RunEvent,
  type RunRecord,
  type RunRepository,
  type TaskRepository,
} from "@evianta/core";
import { Orchestrator, ResumeRequestSchema } from "@evianta/agents";
import {
  buildDeliverableExport,
  deliverableExportFormats,
} from "@evianta/core/deliverable-export";
import {
  defaultIngestionLimits,
  detectFormat,
  IngestionError,
  type DocumentIngestion,
} from "@evianta/ingestion";
import type { UploadEnvironment } from "@evianta/env/server";
import { StoreError, type UsageAdminService } from "@evianta/store";
import Busboy from "busboy";
import { createHash, randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import type { Express, Request, RequestHandler, Response } from "express";
import { z } from "zod";
import type {
  AuthContext,
  AuthenticationService,
  AuthConfiguration,
} from "./auth.js";
import { bearerToken } from "./auth.js";
import { sendApiError } from "./errors.js";

type CaseRepositories = {
  agentProfiles: AgentProfileRepository;
  cases: CaseRepository;
  documents: DocumentRepository;
  extractions: ExtractionRepository;
  evidence: EvidenceRepository;
  findings: FindingRepository;
  tasks: TaskRepository;
  runs: RunRepository;
  deliverables: DeliverableRepository;
  approvals: ApprovalRepository;
  events: RunEventRepository;
};

interface AuthenticatedRequest extends Request {
  authContext?: AuthContext;
  caseRecord?: Case;
}

export interface CaseApiServices {
  repositories: CaseRepositories;
  storage: DocumentStore;
  orchestrator: Orchestrator;
  usageAdmin: UsageAdminService;
  uploads: UploadEnvironment;
  ingestion?: DocumentIngestion;
}

interface RouteContext {
  app: Express;
  authenticate: RequestHandler;
  service: AuthenticationService;
  configuration: AuthConfiguration & { sessionRecheckSeconds: number };
}

interface UploadedFile {
  name: string;
  mimeType: string;
  bytes: Buffer;
}

const CaseCreateInputSchema = CreateCaseRequestSchema.strict();
const CopyInputSchema = z
  .object({ title: z.string().min(1).max(200).optional() })
  .strict();
const RunInputSchema = z.object({}).strict();
const RetryInputSchema = z.object({ priorRunId: z.string().min(1) }).strict();
const CancelInputSchema = z
  .object({ reason: z.string().max(500).optional() })
  .strict();
const ReviewSectionInputSchema = z
  .object({
    expectedVersion: z.number().int().positive(),
    reviewerContent: z.string().trim().min(1).max(50_000).optional(),
    reviewStatus: z
      .enum(["pending", "accepted", "changes-requested"])
      .optional(),
    reviewComment: z.string().max(5_000).nullable().optional(),
  })
  .strict()
  .refine(
    (input) =>
      input.reviewerContent !== undefined ||
      input.reviewStatus !== undefined ||
      input.reviewComment !== undefined,
    "At least one review field is required",
  )
  .refine(
    (input) =>
      input.reviewStatus !== "changes-requested" ||
      Boolean(input.reviewComment?.trim()),
    "A comment is required when requesting changes",
  );
const ApproveInputSchema = z
  .object({
    deliverableId: z.string().min(1),
    deliverableVersion: z.number().int().positive(),
    note: z.string().max(1_000).default(""),
  })
  .strict();

const terminalStatuses = new Set([
  "completed",
  "partially-completed",
  "failed",
  "cancelled",
  "limit-reached",
  "waiting-for-input",
]);

function authContext(request: Request): AuthContext | undefined {
  return (request as AuthenticatedRequest).authContext;
}

function requestCase(request: Request): Case | undefined {
  return (request as AuthenticatedRequest).caseRecord;
}

function requireLiveWorkflow(
  record: Pick<Case, "useCase">,
  response: Response,
): boolean {
  if (liveWorkflows.includes(record.useCase)) return true;
  sendApiError(
    response,
    409,
    "conflict",
    "This workflow is coming next and is not available for live work.",
  );
  return false;
}

function routeParam(value: string | string[] | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function hasPlainTextSectionContent(section: {
  kind: string;
  content: unknown;
  reviewerContent: unknown;
}): boolean {
  if (section.kind !== "text") return false;
  if (
    typeof section.content === "string" ||
    typeof section.reviewerContent === "string"
  ) {
    return true;
  }
  if (typeof section.content !== "object" || section.content === null) {
    return false;
  }
  if (
    "summary" in section.content &&
    typeof section.content.summary === "string"
  ) {
    return true;
  }
  return (
    "report" in section.content &&
    typeof section.content.report === "object" &&
    section.content.report !== null &&
    "summary" in section.content.report &&
    typeof section.content.report.summary === "string"
  );
}

async function findSettledDeliverable(
  repositories: Pick<CaseRepositories, "deliverables" | "runs">,
  deliverableId: string,
  scope: { ownerId: string; caseId: string },
  response: Response,
): Promise<Deliverable | null> {
  const reference = await repositories.deliverables.findOwnedById(
    deliverableId,
    scope,
  );
  if (!reference) {
    sendApiError(response, 404, "not-found", "Resource not found");
    return null;
  }
  const run = await repositories.runs.findOwnedById(
    reference.runId,
    scope.ownerId,
  );
  if (
    !run ||
    run.caseId !== scope.caseId ||
    ["queued", "running", "waiting-for-input"].includes(run.status)
  ) {
    sendApiError(
      response,
      409,
      "conflict",
      "Wait for the analysis run to finish before reviewing this deliverable.",
    );
    return null;
  }
  const deliverable = await repositories.deliverables.findOwnedById(
    deliverableId,
    scope,
  );
  if (!deliverable) {
    sendApiError(response, 404, "not-found", "Resource not found");
    return null;
  }
  if (deliverable.runId !== reference.runId) {
    sendApiError(
      response,
      409,
      "conflict",
      "This deliverable changed. Reload it before reviewing.",
    );
    return null;
  }
  return deliverable;
}

function sendValidationError(
  response: Response,
  error: {
    issues: Array<{ path: PropertyKey[]; message: string }>;
  },
): void {
  sendApiError(
    response,
    400,
    "validation-failed",
    "Request input is invalid",
    error.issues.map((issue) => ({
      path: issue.path.map((part) =>
        typeof part === "number" ? part : String(part),
      ),
      message: issue.message,
    })),
  );
}

function parseInput<T>(
  schema: {
    safeParse(value: unknown):
      | { success: true; data: T }
      | {
          success: false;
          error: { issues: Array<{ path: PropertyKey[]; message: string }> };
        };
  },
  value: unknown,
  response: Response,
): T | undefined {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    sendValidationError(response, parsed.error);
    return undefined;
  }
  return parsed.data;
}

function requireCase(
  repositories: Pick<CaseRepositories, "cases">,
  mutation = false,
): RequestHandler {
  return async (request, response, next) => {
    const principal = authContext(request)?.principal;
    const caseId = routeParam(request.params.caseId);
    if (!principal) {
      sendApiError(response, 401, "unauthenticated", "Authentication required");
      return;
    }
    if (!caseId) {
      sendApiError(response, 404, "not-found", "Resource not found");
      return;
    }
    try {
      const record = await repositories.cases.findOwnedById(
        caseId,
        principal.userId,
      );
      if (!record) {
        const sample = mutation
          ? await repositories.cases.findPublicSampleById(caseId)
          : null;
        if (sample || (mutation && sampleById(caseId))) {
          response.status(409).json({
            reason: "sample-read-only",
            copyUrl: `/cases/${encodeURIComponent(caseId)}/copy`,
          });
          return;
        }
        sendApiError(response, 404, "not-found", "Resource not found");
        return;
      }
      (request as AuthenticatedRequest).caseRecord = record;
      next();
    } catch (error) {
      next(error);
    }
  };
}

function emptyUsage() {
  return UsageSummarySchema.parse({
    inputUnits: 0,
    outputUnits: 0,
    totalUnits: 0,
    costUsd: 0,
    costStatus: "estimated",
    reservedUsd: 0,
  });
}

function sampleFixtures() {
  return Object.values(syntheticWorkflowFixtures);
}

function sampleById(id: string) {
  return sampleFixtures().find((fixture) => fixture.case.id === id);
}

function sampleSource(
  fixture: ReturnType<typeof sampleFixtures>[number],
  documentName: string,
): Buffer {
  return Buffer.from(
    JSON.stringify(
      {
        synthetic: true,
        sampleCaseId: fixture.case.id,
        documentName,
        input: fixture.input,
      },
      null,
      2,
    ),
    "utf8",
  );
}

function safeFilename(value: string): string {
  const basename = value.replace(/\\/g, "/").split("/").pop() ?? "";
  const safe = Array.from(basename, (character) => {
    const code = character.charCodeAt(0);
    return code <= 0x1f || code === 0x7f || character === '"' ? "_" : character;
  })
    .join("")
    .trim()
    .slice(0, 255);
  return safe || "document";
}

function hash(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function* bytesOf(bytes: Uint8Array): AsyncIterable<Uint8Array> {
  yield bytes;
}

function parseMultipart(
  request: Request,
  limits: UploadEnvironment,
): Promise<UploadedFile[]> {
  return new Promise((resolve, reject) => {
    let totalFileBytes = 0;
    let totalRequestBytes = 0;
    let failed = false;
    const files: UploadedFile[] = [];
    const fail = (error: Error) => {
      if (failed) return;
      failed = true;
      reject(error);
    };

    let parser: ReturnType<typeof Busboy>;
    try {
      parser = Busboy({
        headers: request.headers,
        limits: {
          files: limits.uploadMaxFiles,
          fileSize: limits.uploadMaxBytes,
          fields: 0,
          parts: limits.uploadMaxFiles + 1,
          headerPairs: 200,
        },
      });
    } catch (error) {
      fail(
        Object.assign(
          error instanceof Error ? error : new Error("Invalid multipart body"),
          { status: 400 },
        ),
      );
      return;
    }

    request.on("data", (chunk: Buffer) => {
      totalRequestBytes += chunk.length;
      if (
        totalRequestBytes >
        limits.uploadMaxBytes + limits.uploadMaxFiles * 64 * 1024
      ) {
        fail(
          Object.assign(new Error("Upload request is too large"), {
            status: 413,
          }),
        );
      }
    });
    request.once("aborted", () =>
      fail(
        Object.assign(new Error("Upload request was aborted"), {
          status: 400,
        }),
      ),
    );
    parser.once("error", (error: Error) =>
      fail(Object.assign(error, { status: 400 })),
    );
    parser.on("field", () => {
      fail(
        Object.assign(new Error("Unexpected multipart field"), {
          status: 400,
        }),
      );
    });
    parser.once("fieldsLimit", () => {
      fail(
        Object.assign(new Error("Unexpected multipart field"), {
          status: 400,
        }),
      );
    });
    parser.on("filesLimit", () => {
      fail(Object.assign(new Error("Too many files"), { status: 413 }));
    });
    parser.on("partsLimit", () => {
      fail(
        Object.assign(new Error("Too many multipart parts"), { status: 413 }),
      );
    });
    parser.on("file", (field, stream, info) => {
      if (field !== "files") {
        fail(
          Object.assign(new Error("File field must be named files"), {
            status: 400,
          }),
        );
      }
      if (!info.filename) {
        fail(
          Object.assign(new Error("Uploaded file name is required"), {
            status: 400,
          }),
        );
      }
      const chunks: Buffer[] = [];
      let fileBytes = 0;
      stream.once("error", (error: Error) =>
        fail(Object.assign(error, { status: 400 })),
      );
      stream.on("limit", () => {
        fail(
          Object.assign(new Error("File exceeds the upload limit"), {
            status: 413,
          }),
        );
      });
      stream.on("data", (chunk: Buffer) => {
        fileBytes += chunk.length;
        totalFileBytes += chunk.length;
        if (
          totalFileBytes > limits.uploadMaxBytes ||
          fileBytes > limits.uploadMaxBytes
        ) {
          fail(
            Object.assign(new Error("Upload exceeds the configured limit"), {
              status: 413,
            }),
          );
          return;
        }
        chunks.push(Buffer.from(chunk));
      });
      stream.once("end", () => {
        if (!failed) {
          files.push({
            name: safeFilename(info.filename ?? ""),
            mimeType: info.mimeType.toLowerCase(),
            bytes: Buffer.concat(chunks),
          });
        }
      });
    });
    parser.once("finish", () => {
      if (failed) return;
      if (!files.length) {
        fail(
          Object.assign(new Error("At least one file is required"), {
            status: 400,
          }),
        );
        return;
      }
      resolve(files);
    });
    request.pipe(parser);
  });
}

function sseFrame(input: {
  id?: number;
  event: string;
  data: unknown;
}): string {
  const id = input.id === undefined ? "" : `id: ${input.id}\n`;
  return `${id}event: ${input.event}\ndata: ${JSON.stringify(input.data)}\n\n`;
}

function pipeSessionProtectedDownload(input: {
  response: Response;
  body: AsyncIterable<Uint8Array>;
  service: AuthenticationService;
  token: string;
  sessionExpiresAt: number;
  sessionRecheckSeconds: number;
}): void {
  const stream = Readable.from(input.body);
  let closed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const stop = () => {
    closed = true;
    if (timer) clearTimeout(timer);
    if (expiryTimer) clearTimeout(expiryTimer);
    stream.destroy();
  };
  const terminate = () => {
    stream.unpipe(input.response);
    stop();
    if (input.response.destroyed) return;
    if (input.response.writableLength > 0) input.response.destroy();
    else input.response.end();
  };
  const checkSession = async () => {
    if (closed) return;
    if (input.sessionExpiresAt <= Date.now()) {
      terminate();
      return;
    }
    try {
      await input.service.authenticate(input.token);
    } catch {
      terminate();
      return;
    }
    if (closed) return;
    timer = setTimeout(
      () => void checkSession(),
      Math.max(
        1,
        Math.min(
          input.sessionRecheckSeconds * 1_000,
          input.sessionExpiresAt - Date.now(),
        ),
      ),
    );
  };

  const expiryTimer = setTimeout(
    terminate,
    Math.max(1, input.sessionExpiresAt - Date.now()),
  );
  input.response.once("close", stop);
  input.response.once("finish", stop);
  stream.once("error", () => {
    stop();
    input.response.destroy();
  });
  timer = setTimeout(
    () => void checkSession(),
    Math.max(
      1,
      Math.min(
        input.sessionRecheckSeconds * 1_000,
        input.sessionExpiresAt - Date.now(),
      ),
    ),
  );
  stream.pipe(input.response);
}

function sendRun(response: Response, run: RunRecord): void {
  response.status(202).json({ run: RunDtoSchema.parse(run) });
}

function registerSampleRoutes(app: Express): void {
  app.get("/samples", (_request, response) => {
    response.status(200).json({
      samples: sampleFixtures().map((fixture) => ({
        case: fixture.case,
        documents: fixture.documents,
      })),
    });
  });

  app.get("/samples/:id", (request, response) => {
    const id = routeParam(request.params.id);
    const fixture = id ? sampleById(id) : undefined;
    if (!fixture) {
      sendApiError(response, 404, "not-found", "Resource not found");
      return;
    }
    response.status(200).json({
      case: fixture.case,
      documents: fixture.documents,
    });
  });

  app.get(
    "/samples/:id/documents/:documentId/download",
    (request, response) => {
      const id = routeParam(request.params.id);
      const documentId = routeParam(request.params.documentId);
      const fixture = id ? sampleById(id) : undefined;
      const document = fixture?.documents.find(
        (entry) => entry.id === documentId,
      );
      if (!fixture || !document) {
        sendApiError(response, 404, "not-found", "Resource not found");
        return;
      }
      const bytes = sampleSource(fixture, document.name);
      response.setHeader("Content-Type", "application/json; charset=utf-8");
      response.setHeader(
        "Content-Disposition",
        `attachment; filename*=UTF-8''${encodeURIComponent(`${document.name}.json`)}`,
      );
      response.status(200).send(bytes);
    },
  );
}

function registerStreamRoute(
  context: RouteContext,
  services: CaseApiServices,
): void {
  const { app, authenticate, service, configuration } = context;
  app.get(
    "/cases/:caseId/stream",
    authenticate,
    requireCase(services.repositories),
    async (request, response) => {
      const principal = authContext(request)?.principal;
      const token = bearerToken(request);
      const caseId = routeParam(request.params.caseId);
      const runId =
        typeof request.query.runId === "string" ? request.query.runId : null;
      const lastEventId = request.get("last-event-id");
      const queryCursor =
        typeof request.query.cursor === "string"
          ? request.query.cursor
          : typeof request.query.afterSequence === "string"
            ? request.query.afterSequence
            : null;
      const rawCursor = lastEventId ?? queryCursor ?? "0";
      if (
        !principal ||
        !token ||
        !caseId ||
        !runId ||
        !/^(?:0|[1-9]\d*)$/.test(rawCursor) ||
        (lastEventId !== undefined &&
          queryCursor !== null &&
          lastEventId !== queryCursor)
      ) {
        sendApiError(
          response,
          400,
          "validation-failed",
          "A valid runId and event cursor are required",
        );
        return;
      }
      const cursorValue = Number(rawCursor);
      if (!Number.isSafeInteger(cursorValue)) {
        sendApiError(
          response,
          400,
          "validation-failed",
          "Event cursor is invalid",
        );
        return;
      }
      const caseRecord = requestCase(request);
      const scope = { ownerId: principal.userId, caseId };
      const run = await services.repositories.runs.findOwnedById(
        runId,
        principal.userId,
      );
      const sessionExpiresAt = Date.parse(
        authContext(request)?.session.expiresAt ?? "",
      );
      if (!caseRecord || !run || run.caseId !== caseId) {
        sendApiError(response, 404, "not-found", "Resource not found");
        return;
      }
      if (
        !Number.isFinite(sessionExpiresAt) ||
        sessionExpiresAt <= Date.now()
      ) {
        sendApiError(
          response,
          401,
          "unauthenticated",
          "Authentication required",
        );
        return;
      }
      const initial = await services.repositories.events.listAfter(
        caseId,
        0,
        scope,
      );
      const latestSequence = initial.at(-1)?.sequence ?? 0;
      if (cursorValue > latestSequence) {
        sendApiError(
          response,
          400,
          "validation-failed",
          "Event cursor is in the future",
        );
        return;
      }

      response.status(200);
      response.setHeader("Content-Type", "text/event-stream; charset=utf-8");
      response.setHeader("Cache-Control", "no-store");
      response.setHeader("Connection", "keep-alive");
      response.setHeader("X-Accel-Buffering", "no");
      response.flushHeaders();
      let closed = false;
      let cursor = cursorValue;
      let lastHeartbeat = Date.now();
      let sessionCheckTimer: ReturnType<typeof setTimeout> | undefined;
      const blockedWrites = new Set<() => void>();
      const clearSessionTimers = () => {
        if (sessionCheckTimer) clearTimeout(sessionCheckTimer);
        if (expiryTimer) clearTimeout(expiryTimer);
      };
      const finish = () => {
        if (closed) return;
        closed = true;
        clearSessionTimers();
        for (const unblock of [...blockedWrites]) unblock();
      };
      const terminateForSession = () => {
        if (closed) return;
        const canSignal = response.writableLength === 0;
        finish();
        if (!response.destroyed && !response.writableEnded) {
          if (canSignal) {
            const writable = response.write(
              sseFrame({ event: "reauthenticate", data: {} }),
            );
            if (writable) response.end();
            else response.destroy();
          } else {
            response.destroy();
          }
        }
      };
      const checkSession = async () => {
        if (closed) return;
        if (sessionExpiresAt <= Date.now()) {
          terminateForSession();
          return;
        }
        try {
          await service.authenticate(token);
        } catch {
          terminateForSession();
          return;
        }
        if (closed) return;
        sessionCheckTimer = setTimeout(
          () => void checkSession(),
          configuration.sessionRecheckSeconds * 1_000,
        );
      };
      const expiryTimer = setTimeout(
        terminateForSession,
        Math.max(1, sessionExpiresAt - Date.now()),
      );
      response.once("close", finish);
      response.once("finish", finish);
      sessionCheckTimer = setTimeout(
        () => void checkSession(),
        configuration.sessionRecheckSeconds * 1_000,
      );
      const write = async (frame: string): Promise<void> => {
        if (closed) return;
        if (response.write(frame)) return;
        await new Promise<void>((resolve) => {
          let settled = false;
          const unblock = () => {
            if (settled) return;
            settled = true;
            response.off("drain", unblock);
            response.off("close", unblock);
            blockedWrites.delete(unblock);
            resolve();
          };
          blockedWrites.add(unblock);
          response.once("drain", unblock);
          response.once("close", unblock);
          if (closed) unblock();
        });
      };

      try {
        if (initial.length > 0 && initial[0]!.sequence > cursor + 1) {
          await write(
            sseFrame({
              event: "resync",
              data: {
                reason: "cursor-expired",
                firstAvailableSequence: initial[0]!.sequence,
              },
            }),
          );
          finish();
          response.end();
          return;
        }
        const writeEvents = async (events: RunEvent[]): Promise<boolean> => {
          if (
            cursor > 0 &&
            events.length > 0 &&
            events[0]!.sequence > cursor + 1
          ) {
            await write(
              sseFrame({
                event: "resync",
                data: {
                  reason: "cursor-expired",
                  firstAvailableSequence: events[0]!.sequence,
                },
              }),
            );
            return false;
          }
          for (const event of events) {
            const parsed = RunEventSchema.parse(event);
            cursor = parsed.sequence;
            if (parsed.runId === runId) {
              await write(
                sseFrame({
                  id: parsed.sequence,
                  event: parsed.payload.type,
                  data: parsed,
                }),
              );
            }
            if (closed) return true;
          }
          return true;
        };
        while (!closed) {
          const events = await services.repositories.events.listAfter(
            caseId,
            cursor,
            scope,
          );
          if (!(await writeEvents(events))) {
            break;
          }
          if (closed) break;
          const currentRun = await services.repositories.runs.findOwnedById(
            runId,
            principal.userId,
          );
          if (!currentRun) break;
          if (terminalStatuses.has(currentRun.status)) {
            if (currentRun.terminalEvent?.pending) {
              await new Promise((resolve) => setTimeout(resolve, 100));
              continue;
            }
            const finalEvents = await services.repositories.events.listAfter(
              caseId,
              cursor,
              scope,
            );
            if (!(await writeEvents(finalEvents))) break;
            break;
          }
          if (Date.now() - lastHeartbeat >= 15_000) {
            await write(": heartbeat\n\n");
            lastHeartbeat = Date.now();
          }
          await new Promise((resolve) =>
            setTimeout(
              resolve,
              Math.max(1, Math.min(1_000, sessionExpiresAt - Date.now())),
            ),
          );
        }
      } catch (error) {
        console.error("API event stream failed", {
          errorName: error instanceof Error ? error.name : "UnknownError",
        });
        if (!response.destroyed) response.destroy();
        return;
      }
      finish();
      if (!response.destroyed) response.end();
    },
  );
}

export function registerCaseApiRoutes(
  context: RouteContext,
  services: CaseApiServices,
): void {
  const { app, authenticate, service, configuration } = context;
  const repositories = services.repositories;
  registerSampleRoutes(app);

  app.get("/intake/configuration", authenticate, (_request, response) => {
    response.json({ workflows: liveWorkflows, ...services.uploads });
  });

  let directoryCache: { at: number; body: unknown } | null = null;
  app.get("/directory/agents", async (_request, response) => {
    if (!directoryCache || Date.now() - directoryCache.at > 60_000) {
      const profiles = AgentProfileSetSchema.parse(
        await repositories.agentProfiles.listEnabled(),
      );
      directoryCache = { at: Date.now(), body: { agents: profiles } };
    }
    response.status(200).json(directoryCache.body);
  });

  app.get("/agents", authenticate, async (_request, response) => {
    const profiles = AgentProfileSetSchema.parse(
      await repositories.agentProfiles.listEnabled(),
    );
    response.status(200).json({ agents: profiles });
  });

  app.get("/agents/:role", authenticate, async (request, response) => {
    const role = routeParam(request.params.role);
    const profile = role
      ? await repositories.agentProfiles.findByRole(role)
      : null;
    if (!profile || !profile.enabled) {
      sendApiError(response, 404, "not-found", "Resource not found");
      return;
    }
    response.status(200).json({ agent: profile });
  });

  app.post("/cases", authenticate, async (request, response) => {
    const input = parseInput(CaseCreateInputSchema, request.body, response);
    const principal = authContext(request)?.principal;
    if (!input || !principal) return;
    if (!requireLiveWorkflow(input, response)) return;
    if (input.sourceCaseId) {
      const source = sampleById(input.sourceCaseId);
      if (!source) {
        sendApiError(
          response,
          400,
          "validation-failed",
          "Choose a public sample as the case source",
        );
        return;
      }
    }
    const at = new Date().toISOString();
    const record = CaseSchema.parse({
      id: randomUUID(),
      ...input,
      ownerId: principal.userId,
      isSample: false,
      synthetic: false,
      sourceCaseId: input.sourceCaseId ?? null,
      status: "active",
      usage: emptyUsage(),
      createdAt: at,
      updatedAt: at,
    });
    await repositories.cases.insert(record);
    response.status(201).json({ case: record });
  });

  app.get("/cases", authenticate, async (request, response) => {
    const principal = authContext(request)?.principal;
    if (!principal) {
      sendApiError(response, 401, "unauthenticated", "Authentication required");
      return;
    }
    const cursor =
      typeof request.query.cursor === "string"
        ? request.query.cursor
        : undefined;
    if (request.query.cursor !== undefined && !cursor) {
      sendApiError(response, 400, "validation-failed", "Cursor is invalid");
      return;
    }
    const cases = await repositories.cases.listOwned(principal.userId, cursor);
    response.status(200).json({
      cases,
      nextCursor: cases.length === 50 ? (cases.at(-1)?.id ?? null) : null,
    });
  });

  app.get(
    "/cases/:caseId",
    authenticate,
    requireCase(repositories),
    async (request, response) => {
      const principal = authContext(request)?.principal;
      const record = requestCase(request);
      if (!principal || !record) return;
      const scope = { ownerId: principal.userId, caseId: record.id };
      const [documents, runs, findings, evidence] = await Promise.all([
        repositories.documents.listOwned(scope),
        repositories.runs.listForCase(record.id, principal.userId),
        repositories.findings.listForCase(scope),
        repositories.evidence.listForCase(scope),
      ]);
      const runChildren = await Promise.all(
        runs.map(async (run) => {
          const [tasks, deliverables] = await Promise.all([
            repositories.tasks.listForRun(run.id, scope),
            repositories.deliverables.listForRun(run.id, scope),
          ]);
          return { tasks, deliverables };
        }),
      );
      const deliverables = runChildren.flatMap((entry) => entry.deliverables);
      const approvals = (
        await Promise.all(
          deliverables.map((deliverable) =>
            repositories.approvals.findForDeliverable(deliverable.id, scope),
          ),
        )
      ).filter((approval): approval is Approval => approval !== null);
      response.status(200).json({
        case: record,
        state: record.status,
        usage: record.usage,
        documents: documents.map((document) =>
          DocumentMetadataDtoSchema.parse(document),
        ),
        runs: runs.map((run) => RunDtoSchema.parse(run)),
        tasks: runChildren.flatMap((entry) => entry.tasks),
        findings,
        evidence,
        deliverables,
        approvals,
      });
    },
  );

  app.get(
    "/cases/:caseId/runs/latest",
    authenticate,
    requireCase(repositories),
    async (request, response) => {
      const principal = authContext(request)?.principal;
      const record = requestCase(request);
      if (!principal || !record) return;
      const runs = await repositories.runs.listForCase(
        record.id,
        principal.userId,
      );
      const latest = runs.reduce<RunRecord | null>(
        (current, run) =>
          !current || run.createdAt > current.createdAt ? run : current,
        null,
      );
      response.status(200).json({
        run: latest ? RunDtoSchema.parse(latest) : null,
      });
    },
  );

  app.post(
    "/cases/:caseId/copy",
    authenticate,
    async (request, response, next) => {
      const principal = authContext(request)?.principal;
      const sampleId = routeParam(request.params.caseId);
      const fixture = sampleId ? sampleById(sampleId) : undefined;
      if (!principal || !fixture) {
        sendApiError(response, 404, "not-found", "Resource not found");
        return;
      }
      const input = parseInput(CopyInputSchema, request.body ?? {}, response);
      if (!input) return;
      const at = new Date().toISOString();
      const id = randomUUID();
      const copiedCase = CaseSchema.parse({
        ...fixture.case,
        id,
        title: input.title ?? fixture.case.title,
        ownerId: principal.userId,
        isSample: false,
        sourceCaseId: fixture.case.id,
        status: "active",
        usage: emptyUsage(),
        createdAt: at,
        updatedAt: at,
      });
      const scope = { ownerId: principal.userId, caseId: id };
      const uploaded: Array<{ key: string; document: DocumentMetadataRecord }> =
        [];
      let caseInserted = false;
      try {
        for (const source of fixture.documents) {
          const bytes = sampleSource(fixture, source.name);
          const name = `${safeFilename(source.name)}.json`;
          const mimeType = "application/json";
          detectFormat(bytes, mimeType, name, {
            ...defaultIngestionLimits,
            maxPages: services.uploads.documentMaxPages,
          });
          const objectKey = await services.storage.uploadAsync(id, mimeType, {
            body: bytesOf(bytes),
            contentLength: bytes.byteLength,
            contentHash: hash(bytes),
          });
          uploaded.push({
            key: objectKey,
            document: {
              id: randomUUID(),
              caseId: id,
              name,
              mimeType,
              sizeBytes: bytes.byteLength,
              state: "uploaded",
              uploadedAt: at,
              processedAt: null,
              objectKey,
              contentHash: hash(bytes),
            },
          });
        }
        await repositories.cases.insert(copiedCase);
        caseInserted = true;
        for (const item of uploaded) {
          await repositories.documents.insert(item.document, scope);
        }
      } catch (error) {
        if (caseInserted) {
          await repositories.cases
            .replaceOwned(
              {
                ...copiedCase,
                status: "deleted",
                updatedAt: new Date().toISOString(),
              },
              principal.userId,
            )
            .catch((cleanupError: unknown) => {
              console.error("Sample-copy case cleanup failed", {
                errorName:
                  cleanupError instanceof Error
                    ? cleanupError.name
                    : "UnknownError",
              });
            });
        }
        await Promise.all(
          uploaded.map(({ key }) =>
            services.storage.deleteAsync(key).catch((cleanupError: unknown) => {
              console.error("Sample-copy object cleanup failed", {
                errorName:
                  cleanupError instanceof Error
                    ? cleanupError.name
                    : "UnknownError",
              });
            }),
          ),
        );
        next(error);
        return;
      }
      if (services.ingestion) {
        for (const { document } of uploaded) {
          try {
            await services.ingestion.ingest({
              scope,
              documentId: document.id,
            });
          } catch (error) {
            console.error("Sample-copy document extraction failed", {
              documentId: document.id,
              errorName: error instanceof Error ? error.name : "UnknownError",
            });
            const current = await repositories.documents.findOwned(
              document.id,
              scope,
            );
            if (current) {
              await repositories.documents.replaceOwned(
                {
                  ...current,
                  state: "failed",
                  processedAt: new Date().toISOString(),
                },
                scope,
              );
            }
          }
        }
      }
      response.status(201).json({
        case: copiedCase,
        documents: await repositories.documents.listOwned(scope),
      });
    },
  );

  app.post(
    "/cases/:caseId/documents",
    authenticate,
    requireCase(repositories, true),
    async (request, response, next) => {
      const record = requestCase(request);
      const principal = authContext(request)?.principal;
      if (!record || !principal) return;
      if (!requireLiveWorkflow(record, response)) return;
      if (record.deletionRequestedAt || record.status !== "active") {
        sendApiError(
          response,
          409,
          "conflict",
          "Case is not accepting uploads",
        );
        return;
      }
      if (!services.ingestion) {
        sendApiError(
          response,
          503,
          "internal-error",
          "Document ingestion is unavailable",
        );
        return;
      }
      let files: UploadedFile[];
      try {
        files = await parseMultipart(request, services.uploads);
      } catch (error) {
        const status =
          typeof error === "object" &&
          error !== null &&
          "status" in error &&
          (error.status === 413 || error.status === 400)
            ? error.status
            : 400;
        sendApiError(
          response,
          status,
          status === 413 ? "limit-reached" : "validation-failed",
          status === 413
            ? "Upload exceeds configured limits"
            : "Invalid multipart upload",
        );
        return;
      }
      const scope = { ownerId: principal.userId, caseId: record.id };
      const stored: DocumentMetadataDto[] = [];
      for (const file of files) {
        if (!file.bytes.length) {
          sendApiError(
            response,
            400,
            "validation-failed",
            "Empty files are not allowed",
          );
          return;
        }
        try {
          detectFormat(file.bytes, file.mimeType, file.name, {
            ...defaultIngestionLimits,
            maxBytes: services.uploads.uploadMaxBytes,
            maxPages: services.uploads.documentMaxPages,
          });
        } catch (error) {
          if (error instanceof IngestionError) {
            sendApiError(
              response,
              400,
              "validation-failed",
              "File content does not match a supported document type",
            );
            return;
          }
          next(error);
          return;
        }
      }
      for (const file of files) {
        const contentHash = hash(file.bytes);
        let objectKey: string | undefined;
        let metadataInserted = false;
        const document: DocumentMetadataRecord = {
          id: randomUUID(),
          caseId: record.id,
          name: file.name,
          mimeType: file.mimeType,
          sizeBytes: file.bytes.byteLength,
          state: "uploaded",
          uploadedAt: new Date().toISOString(),
          processedAt: null,
          objectKey: "pending",
          contentHash,
        };
        try {
          objectKey = await services.storage.uploadAsync(
            record.id,
            file.mimeType,
            {
              body: bytesOf(file.bytes),
              contentLength: file.bytes.byteLength,
              contentHash,
            },
          );
          const storedDocument = { ...document, objectKey };
          await repositories.documents.insert(storedDocument, scope);
          metadataInserted = true;
          await services.ingestion.ingest({
            scope,
            documentId: document.id,
          });
          const updated = await repositories.documents.findOwned(
            document.id,
            scope,
          );
          if (updated) stored.push(DocumentMetadataDtoSchema.parse(updated));
        } catch (error) {
          if (objectKey && !metadataInserted) {
            await services.storage
              .deleteAsync(objectKey)
              .catch((cleanupError) => {
                console.error("Upload object cleanup failed", {
                  errorName:
                    cleanupError instanceof Error
                      ? cleanupError.name
                      : "UnknownError",
                });
              });
          }
          if (metadataInserted) {
            console.error("Uploaded document processing failed", {
              documentId: document.id,
              errorName: error instanceof Error ? error.name : "UnknownError",
            });
            const current = await repositories.documents.findOwned(
              document.id,
              scope,
            );
            if (current) {
              const processedAt = new Date().toISOString();
              await repositories.documents.replaceOwned(
                {
                  ...current,
                  state: "failed",
                  processedAt,
                },
                scope,
              );
              stored.push(
                DocumentMetadataDtoSchema.parse({
                  ...current,
                  state: "failed",
                  processedAt,
                }),
              );
            }
          } else {
            next(error);
            return;
          }
        }
      }
      response.status(201).json({ documents: stored });
    },
  );

  app.get(
    "/cases/:caseId/documents/:documentId/download",
    authenticate,
    requireCase(repositories),
    async (request, response) => {
      const principal = authContext(request)?.principal;
      const record = requestCase(request);
      const documentId = routeParam(request.params.documentId);
      if (!principal || !record || !documentId) return;
      const token = bearerToken(request);
      const sessionExpiresAt = Date.parse(
        authContext(request)?.session.expiresAt ?? "",
      );
      if (
        !token ||
        !Number.isFinite(sessionExpiresAt) ||
        sessionExpiresAt <= Date.now()
      ) {
        sendApiError(
          response,
          401,
          "unauthenticated",
          "Authentication required",
        );
        return;
      }
      const scope = { ownerId: principal.userId, caseId: record.id };
      const document = await repositories.documents.findOwned(
        documentId,
        scope,
      );
      if (!document) {
        sendApiError(response, 404, "not-found", "Resource not found");
        return;
      }
      const object = await services.storage.readStreamAsync(document.objectKey);
      if (!object) {
        sendApiError(response, 404, "not-found", "Resource not found");
        return;
      }
      if (
        object.contentLength !== document.sizeBytes ||
        object.contentHash !== document.contentHash
      ) {
        sendApiError(
          response,
          500,
          "internal-error",
          "Stored document metadata is inconsistent",
        );
        return;
      }
      response.setHeader("Content-Type", document.mimeType);
      response.setHeader(
        "Content-Disposition",
        `attachment; filename*=UTF-8''${encodeURIComponent(safeFilename(document.name))}`,
      );
      pipeSessionProtectedDownload({
        response,
        body: object.body,
        service,
        token,
        sessionExpiresAt,
        sessionRecheckSeconds: configuration.sessionRecheckSeconds,
      });
    },
  );

  app.delete(
    "/cases/:caseId",
    authenticate,
    requireCase(repositories, true),
    async (request, response) => {
      const principal = authContext(request)?.principal;
      const record = requestCase(request);
      if (!principal || !record) return;
      const at = new Date().toISOString();
      if (
        !(await repositories.cases.requestDeletion(
          record.id,
          principal.userId,
          at,
        ))
      ) {
        sendApiError(response, 404, "not-found", "Resource not found");
        return;
      }
      const runs = await repositories.runs.listForCase(
        record.id,
        principal.userId,
      );
      for (const run of runs) {
        if (["queued", "running", "waiting-for-input"].includes(run.status)) {
          await services.orchestrator.cancelRunAsync({
            ownerId: principal.userId,
            runId: run.id,
            reason: "case-deletion-requested",
          });
        }
      }
      response.status(202).json({
        caseId: record.id,
        status: "deletion-pending",
        requestedAt: at,
      });
    },
  );

  app.post(
    "/cases/:caseId/run",
    authenticate,
    requireCase(repositories, true),
    async (request, response) => {
      const principal = authContext(request)?.principal;
      const record = requestCase(request);
      const input = parseInput(RunInputSchema, request.body ?? {}, response);
      if (!principal || !record || !input) return;
      if (!requireLiveWorkflow(record, response)) return;
      if (record.deletionRequestedAt || record.status !== "active") {
        sendApiError(
          response,
          409,
          "conflict",
          "Case is not accepting new runs",
        );
        return;
      }
      const run = await services.orchestrator.createRunAsync({
        ownerId: principal.userId,
        caseId: record.id,
      });
      sendRun(response, run);
    },
  );

  app.post("/runs", authenticate, async (request, response) => {
    const principal = authContext(request)?.principal;
    const input = parseInput(CreateRunRequestSchema, request.body, response);
    if (!principal || !input) return;
    const record = await repositories.cases.findOwnedById(
      input.caseId,
      principal.userId,
    );
    if (!record) {
      sendApiError(response, 404, "not-found", "Resource not found");
      return;
    }
    if (record.deletionRequestedAt || record.status !== "active") {
      sendApiError(response, 409, "conflict", "Case is not accepting new runs");
      return;
    }
    if (!requireLiveWorkflow(record, response)) return;
    const run = input.priorRunId
      ? await services.orchestrator.retryFailedAsync({
          ownerId: principal.userId,
          caseId: record.id,
          priorRunId: input.priorRunId,
        })
      : await services.orchestrator.createRunAsync({
          ownerId: principal.userId,
          caseId: record.id,
        });
    sendRun(response, run);
  });

  app.post("/runs/:runId/retry", authenticate, async (request, response) => {
    const principal = authContext(request)?.principal;
    const runId = routeParam(request.params.runId);
    if (!principal || !runId) return;
    const prior = await repositories.runs.findOwnedById(
      runId,
      principal.userId,
    );
    if (!prior) {
      sendApiError(response, 404, "not-found", "Resource not found");
      return;
    }
    const record = await repositories.cases.findOwnedById(
      prior.caseId,
      principal.userId,
    );
    if (!record || record.status !== "active" || record.deletionRequestedAt) {
      sendApiError(response, 404, "not-found", "Resource not found");
      return;
    }
    if (!requireLiveWorkflow(record, response)) return;
    const run = await services.orchestrator.retryFailedAsync({
      ownerId: principal.userId,
      caseId: record.id,
      priorRunId: prior.id,
    });
    sendRun(response, run);
  });

  app.post("/runs/:runId/cancel", authenticate, async (request, response) => {
    const principal = authContext(request)?.principal;
    const runId = routeParam(request.params.runId);
    if (!principal || !runId) return;
    const existing = await repositories.runs.findOwnedById(
      runId,
      principal.userId,
    );
    if (!existing) {
      sendApiError(response, 404, "not-found", "Resource not found");
      return;
    }
    const run = await services.orchestrator.cancelRunAsync({
      ownerId: principal.userId,
      runId,
    });
    response.status(200).json({ run: RunDtoSchema.parse(run) });
  });

  app.post(
    "/cases/:caseId/retry",
    authenticate,
    requireCase(repositories, true),
    async (request, response) => {
      const principal = authContext(request)?.principal;
      const record = requestCase(request);
      const input = parseInput(RetryInputSchema, request.body, response);
      if (!principal || !record || !input) return;
      if (!requireLiveWorkflow(record, response)) return;
      if (record.deletionRequestedAt || record.status !== "active") {
        sendApiError(
          response,
          409,
          "conflict",
          "Case is not accepting new runs",
        );
        return;
      }
      const run = await services.orchestrator.retryFailedAsync({
        ownerId: principal.userId,
        caseId: record.id,
        priorRunId: input.priorRunId,
      });
      sendRun(response, run);
    },
  );

  app.post(
    "/cases/:caseId/runs/:runId/cancel",
    authenticate,
    requireCase(repositories, true),
    async (request, response) => {
      const principal = authContext(request)?.principal;
      const record = requestCase(request);
      if (!principal || !record) return;
      const input = parseInput(CancelInputSchema, request.body ?? {}, response);
      if (!input) return;
      const runId = routeParam(request.params.runId);
      if (
        !runId ||
        !(await repositories.runs
          .findOwnedById(runId, principal.userId)
          .then((run) => run?.caseId === record.id))
      ) {
        sendApiError(response, 404, "not-found", "Resource not found");
        return;
      }
      const run = await services.orchestrator.cancelRunAsync({
        ownerId: principal.userId,
        runId,
        ...(input.reason ? { reason: input.reason } : {}),
      });
      response.status(200).json({ run: RunDtoSchema.parse(run) });
    },
  );

  app.post(
    "/cases/:caseId/runs/:runId/resume",
    authenticate,
    requireCase(repositories, true),
    async (request, response) => {
      const principal = authContext(request)?.principal;
      const record = requestCase(request);
      if (!principal || !record) return;
      const input = parseInput(ResumeRequestSchema, request.body, response);
      if (!input) return;
      if (!requireLiveWorkflow(record, response)) return;
      if (record.deletionRequestedAt || record.status !== "active") {
        sendApiError(
          response,
          409,
          "conflict",
          "Case is not accepting resumed runs",
        );
        return;
      }
      const runId = routeParam(request.params.runId);
      const ownedRun =
        runId &&
        (await repositories.runs.findOwnedById(runId, principal.userId));
      if (!runId || !ownedRun || ownedRun.caseId !== record.id) {
        sendApiError(response, 404, "not-found", "Resource not found");
        return;
      }
      const result = await services.orchestrator.resumeRunAsync({
        ownerId: principal.userId,
        runId,
        request: input,
      });
      response.status(200).json({
        outcome: result.outcome,
        run: result.run ? RunDtoSchema.parse(result.run) : null,
      });
    },
  );

  registerStreamRoute(context, services);

  app.get(
    "/cases/:caseId/deliverables/:deliverableId/export",
    authenticate,
    requireCase(repositories),
    async (request, response) => {
      const principal = authContext(request)?.principal;
      const record = requestCase(request);
      const id = routeParam(request.params.deliverableId);
      const input = z
        .object({
          format: z.enum(["pdf", "xlsx", "json"]),
          version: z.coerce.number().int().positive(),
        })
        .safeParse(request.query);
      if (!principal || !record || !id) return;
      if (!input.success) {
        sendApiError(
          response,
          400,
          "validation-failed",
          "Specify a file format and saved document version.",
        );
        return;
      }
      const scope = { ownerId: principal.userId, caseId: record.id };
      const deliverable = await findSettledDeliverable(
        repositories,
        id,
        scope,
        response,
      );
      if (!deliverable) return;
      if (deliverable.version !== input.data.version) {
        sendApiError(
          response,
          409,
          "conflict",
          "This document changed. Reload it before downloading.",
        );
        return;
      }
      if (
        !deliverable.workProduct ||
        !deliverableExportFormats(deliverable, record).includes(
          input.data.format,
        )
      ) {
        sendApiError(
          response,
          400,
          "validation-failed",
          "This document does not support the requested generated-file export.",
        );
        return;
      }
      const cached = deliverable.generatedFiles?.find(
        (file) =>
          file.version === deliverable.version &&
          file.format === input.data.format,
      );
      let bytes: Uint8Array;
      let filename: string;
      let mimeType: string;
      if (cached) {
        const stored = await services.storage.readBufferAsync(
          cached.objectKey,
          services.uploads.uploadMaxBytes,
        );
        if (!stored)
          throw new Error("The saved generated file is missing from storage.");
        bytes = stored;
        filename = cached.filename;
        mimeType = cached.mimeType;
      } else {
        const file = await buildDeliverableExport(
          deliverable,
          input.data.format,
          record,
        );
        bytes = file.content;
        filename = file.filename;
        mimeType = file.mimeType;
        if (bytes.byteLength > services.uploads.uploadMaxBytes) {
          sendApiError(
            response,
            413,
            "limit-reached",
            "The generated file exceeds the configured storage limit.",
          );
          return;
        }
        const objectKey = await services.storage.uploadAsync(
          record.id,
          mimeType,
          {
            body: bytesOf(Buffer.from(bytes)),
            contentLength: bytes.byteLength,
            contentHash: hash(Buffer.from(bytes)),
          },
        );
        let saved = false;
        let reused = false;
        try {
          for (let attempt = 0; attempt < 3 && !saved; attempt += 1) {
            const candidate = await repositories.deliverables.findOwnedById(
              id,
              scope,
            );
            if (!candidate || candidate.version !== deliverable.version) break;
            const concurrent = candidate.generatedFiles?.find(
              (entry) =>
                entry.format === input.data.format &&
                entry.version === candidate.version,
            );
            if (concurrent) {
              const stored = await services.storage.readBufferAsync(
                concurrent.objectKey,
                services.uploads.uploadMaxBytes,
              );
              if (!stored)
                throw new Error(
                  "The saved generated file is missing from storage.",
                );
              bytes = stored;
              filename = concurrent.filename;
              mimeType = concurrent.mimeType;
              reused = true;
              break;
            }
            saved = await repositories.deliverables.replaceOwned(
              {
                ...candidate,
                updatedAt: new Date(
                  Math.max(Date.now(), Date.parse(candidate.updatedAt) + 1),
                ).toISOString(),
                generatedFiles: [
                  ...(candidate.generatedFiles ?? []),
                  {
                    format: input.data.format,
                    version: candidate.version,
                    objectKey,
                    filename,
                    mimeType,
                    sizeBytes: bytes.byteLength,
                  },
                ],
              },
              scope,
              {
                expectedVersion: candidate.version,
                expectedUpdatedAt: candidate.updatedAt,
                requireSettledRun: true,
              },
            );
          }
        } finally {
          if (!saved) await services.storage.deleteAsync(objectKey);
        }
        if (!saved && !reused) {
          sendApiError(
            response,
            409,
            "conflict",
            "This document changed while preparing the download. Reload and retry.",
          );
          return;
        }
      }
      const current = await repositories.deliverables.findOwnedById(id, scope);
      if (!current || current.version !== input.data.version) {
        sendApiError(
          response,
          409,
          "conflict",
          "This document changed while downloading. Reload and retry.",
        );
        return;
      }
      response.setHeader("Cache-Control", "no-store");
      response.setHeader("Content-Type", mimeType);
      response.setHeader(
        "Content-Disposition",
        `attachment; filename="${filename}"`,
      );
      response.send(Buffer.from(bytes));
    },
  );

  app.get(
    "/cases/:caseId/deliverables/:deliverableId",
    authenticate,
    requireCase(repositories),
    async (request, response) => {
      const principal = authContext(request)?.principal;
      const record = requestCase(request);
      const deliverableId = routeParam(request.params.deliverableId);
      if (!principal || !record || !deliverableId) return;
      const deliverable = await repositories.deliverables.findOwnedById(
        deliverableId,
        { ownerId: principal.userId, caseId: record.id },
      );
      if (!deliverable) {
        sendApiError(response, 404, "not-found", "Resource not found");
        return;
      }
      response.status(200).json({ deliverable });
    },
  );

  app.patch(
    "/cases/:caseId/deliverables/:deliverableId/sections/:sectionId",
    authenticate,
    requireCase(repositories, true),
    async (request, response) => {
      const principal = authContext(request)?.principal;
      const record = requestCase(request);
      const deliverableId = routeParam(request.params.deliverableId);
      const sectionId = routeParam(request.params.sectionId);
      const input = parseInput(
        ReviewSectionInputSchema,
        request.body,
        response,
      );
      if (!principal || !record || !deliverableId || !sectionId || !input)
        return;
      const scope = { ownerId: principal.userId, caseId: record.id };
      const deliverable = await findSettledDeliverable(
        repositories,
        deliverableId,
        scope,
        response,
      );
      if (!deliverable) return;
      const section = deliverable.sections.find(
        (item) => item.id === sectionId,
      );
      if (!section) {
        sendApiError(response, 404, "not-found", "Resource not found");
        return;
      }
      if (deliverable.version !== input.expectedVersion) {
        sendApiError(
          response,
          409,
          "conflict",
          "This deliverable changed. Reload it before saving your review.",
        );
        return;
      }
      if (
        input.reviewerContent !== undefined &&
        !hasPlainTextSectionContent(section)
      ) {
        sendApiError(
          response,
          400,
          "validation-failed",
          "Only plain-text sections can be edited inline.",
        );
        return;
      }
      const contentChanged =
        input.reviewerContent !== undefined &&
        input.reviewerContent !== section.reviewerContent;
      if (
        deliverable.workProduct &&
        input.reviewerContent !== undefined &&
        !input.reviewerContent.trim()
      ) {
        sendApiError(
          response,
          400,
          "validation-failed",
          "The drafted document body cannot be blank.",
        );
        return;
      }
      const reviewStatus =
        input.reviewStatus ??
        (contentChanged ? "pending" : section.reviewStatus);
      const reviewComment =
        input.reviewComment === undefined
          ? section.reviewComment
          : input.reviewComment;
      if (reviewStatus === "changes-requested" && !reviewComment?.trim()) {
        sendApiError(
          response,
          400,
          "validation-failed",
          "A comment is required when requesting changes.",
        );
        return;
      }
      const reviewedAt = new Date().toISOString();
      const updated = {
        ...deliverable,
        generatedFiles: [],
        version: deliverable.version + 1,
        updatedAt: reviewedAt,
        sections: deliverable.sections.map((item) =>
          item.id !== sectionId
            ? item
            : {
                ...item,
                ...(input.reviewerContent === undefined
                  ? {}
                  : { reviewerContent: input.reviewerContent }),
                reviewStatus,
                reviewComment,
                reviewerId: principal.userId,
                reviewedAt,
              },
        ),
      };
      const saved = await repositories.deliverables.replaceOwned(
        updated,
        scope,
        {
          expectedVersion: input.expectedVersion,
          expectedUpdatedAt: deliverable.updatedAt,
          requireSettledRun: true,
        },
      );
      if (!saved) {
        sendApiError(
          response,
          409,
          "conflict",
          "This deliverable changed. Reload it before saving your review.",
        );
        return;
      }
      await Promise.all(
        (deliverable.generatedFiles ?? []).map((file) =>
          services.storage.deleteAsync(file.objectKey),
        ),
      );
      response.status(200).json({ deliverable: updated });
    },
  );

  app.post(
    "/cases/:caseId/approve",
    authenticate,
    requireCase(repositories, true),
    async (request, response) => {
      const principal = authContext(request)?.principal;
      const record = requestCase(request);
      const input = parseInput(ApproveInputSchema, request.body, response);
      if (!principal || !record || !input) return;
      const scope = { ownerId: principal.userId, caseId: record.id };
      const deliverable = await findSettledDeliverable(
        repositories,
        input.deliverableId,
        scope,
        response,
      );
      if (!deliverable) return;
      if (deliverable.version !== input.deliverableVersion) {
        sendApiError(
          response,
          409,
          "conflict",
          "This deliverable changed. Reload it before approving.",
        );
        return;
      }
      const existing = await repositories.approvals.findForDeliverable(
        deliverable.id,
        scope,
      );
      if (existing && isApprovalCurrent(existing, deliverable)) {
        response.status(200).json({ approval: existing });
        return;
      }
      if (
        deliverable.sections.some(
          (section) => section.reviewStatus === "changes-requested",
        )
      ) {
        sendApiError(
          response,
          409,
          "conflict",
          "Resolve sections with requested changes before approving.",
        );
        return;
      }
      if (existing) {
        sendApiError(
          response,
          409,
          "conflict",
          "This deliverable changed. Reload it before approving.",
        );
        return;
      }
      const findings = await repositories.findings.listForCase(scope);
      const approval = ApprovalSchema.parse({
        id: randomUUID(),
        caseId: record.id,
        deliverableId: deliverable.id,
        deliverableVersion: deliverable.version,
        actorId: principal.userId,
        approvedAt: new Date().toISOString(),
        unresolvedQuestionIds: findings.flatMap((finding) =>
          finding.openQuestions
            .filter((question) => question.status === "open")
            .map((question) => question.id),
        ),
        note: input.note,
      });
      try {
        await repositories.approvals.insert(approval, scope, {
          requireSettledRun: true,
        });
      } catch (error) {
        if (error instanceof StoreError && error.code === "stale-approval") {
          sendApiError(
            response,
            409,
            "conflict",
            "This deliverable changed before approval could be recorded.",
          );
          return;
        }
        if (error instanceof StoreError && error.code === "duplicate-key") {
          const current = await repositories.approvals.findForDeliverable(
            deliverable.id,
            scope,
          );
          if (current && isApprovalCurrent(current, deliverable)) {
            response.status(200).json({ approval: current });
            return;
          }
        }
        throw error;
      }
      response.status(201).json({ approval });
    },
  );

  for (const path of ["/admin/usage/cases", "/admin/usage/summary"]) {
    app.get(path, authenticate, async (request, response) => {
      const principal = authContext(request)?.principal;
      if (!principal) {
        sendApiError(
          response,
          401,
          "unauthenticated",
          "Authentication required",
        );
        return;
      }
      const rawLimit = request.query.limit;
      const limit =
        typeof rawLimit === "string" && /^\d+$/.test(rawLimit)
          ? Number(rawLimit)
          : 500;
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) {
        sendApiError(
          response,
          400,
          "validation-failed",
          "Usage limit is invalid",
        );
        return;
      }
      const ownerId =
        typeof request.query.ownerId === "string"
          ? request.query.ownerId
          : undefined;
      const caseId =
        typeof request.query.caseId === "string"
          ? request.query.caseId
          : undefined;
      const report = await services.usageAdmin.query(principal, {
        ...(ownerId ? { ownerId } : {}),
        ...(caseId ? { caseId } : {}),
        limit,
      });
      response.status(200).json(
        path.endsWith("/cases")
          ? report
          : {
              totals: report.totals,
              byUseCase: report.byUseCase,
              truncated: report.truncated,
            },
      );
    });
  }
}
