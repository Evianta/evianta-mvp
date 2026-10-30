import {
  AgentProfileSetSchema,
  CaseSchema,
  DocumentMetadataDtoSchema,
  RunDtoSchema,
  RunEventSchema,
  UsageSummarySchema,
  UseCaseSchema,
  syntheticWorkflowFixtures,
  type AgentProfileRepository,
  type Case,
  type CaseRepository,
  type DeliverableRepository,
  type DocumentMetadataDto,
  type DocumentMetadataRecord,
  type DocumentRepository,
  type DocumentStore,
  type EvidenceRepository,
  type ExtractionRepository,
  type FindingRepository,
  type RunEventRepository,
  type RunRecord,
  type RunRepository,
  type TaskRepository,
} from "@evianta/core";
import { Orchestrator, ResumeRequestSchema } from "@evianta/agents";
import {
  defaultIngestionLimits,
  detectFormat,
  IngestionError,
  type DocumentIngestion,
} from "@evianta/ingestion";
import type { UploadEnvironment } from "@evianta/env/server";
import type { UsageAdminService } from "@evianta/store";
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

const CaseCreateInputSchema = z
  .object({
    title: z.string().min(1).max(200),
    description: z.string().max(5000).default(""),
    useCase: UseCaseSchema,
  })
  .strict();
const CopyInputSchema = z
  .object({ title: z.string().min(1).max(200).optional() })
  .strict();
const RunInputSchema = z.object({}).strict();
const RetryInputSchema = z.object({ priorRunId: z.string().min(1) }).strict();
const CancelInputSchema = z
  .object({ reason: z.string().max(500).optional() })
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

function routeParam(value: string | string[] | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
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
    const parser = Busboy({
      headers: request.headers,
      limits: {
        files: limits.uploadMaxFiles,
        fileSize: limits.uploadMaxBytes,
        fields: 0,
        parts: limits.uploadMaxFiles,
        headerPairs: 200,
      },
    });

    const fail = (error: Error) => {
      if (failed) return;
      failed = true;
      reject(error);
    };

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
      fail(new Error("Upload request was aborted")),
    );
    parser.once("error", fail);
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
    stream.destroy();
  };
  const terminate = () => {
    stream.unpipe(input.response);
    stop();
    if (!input.response.destroyed) input.response.end();
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

  input.response.once("close", stop);
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
        typeof request.query.cursor === "string" ? request.query.cursor : null;
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
      let nextSessionCheck =
        Date.now() + configuration.sessionRecheckSeconds * 1_000;
      response.once("close", () => {
        closed = true;
      });
      const write = async (frame: string): Promise<void> => {
        if (closed) return;
        if (response.write(frame)) return;
        await new Promise<void>((resolve) => {
          response.once("drain", resolve);
          response.once("close", resolve);
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
          response.end();
          return;
        }
        while (!closed) {
          const now = Date.now();
          if (sessionExpiresAt <= now) {
            await write(sseFrame({ event: "reauthenticate", data: {} }));
            break;
          }
          if (now >= nextSessionCheck) {
            try {
              await service.authenticate(token);
            } catch {
              await write(sseFrame({ event: "reauthenticate", data: {} }));
              break;
            }
            nextSessionCheck =
              now + configuration.sessionRecheckSeconds * 1_000;
          }
          const events = await services.repositories.events.listAfter(
            caseId,
            cursor,
            scope,
          );
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
            break;
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
          }
          const currentRun = await services.repositories.runs.findOwnedById(
            runId,
            principal.userId,
          );
          if (!currentRun || terminalStatuses.has(currentRun.status)) break;
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
    const at = new Date().toISOString();
    const record = CaseSchema.parse({
      id: randomUUID(),
      ...input,
      ownerId: principal.userId,
      isSample: false,
      synthetic: false,
      sourceCaseId: null,
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
        deliverables: runChildren.flatMap((entry) => entry.deliverables),
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
        next(error);
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
      const pending = CaseSchema.parse({
        ...record,
        status: "archived",
        deletionRequestedAt: at,
        updatedAt: at,
      });
      if (!(await repositories.cases.replaceOwned(pending, principal.userId))) {
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

  app.post(
    "/cases/:caseId/retry",
    authenticate,
    requireCase(repositories, true),
    async (request, response) => {
      const principal = authContext(request)?.principal;
      const record = requestCase(request);
      const input = parseInput(RetryInputSchema, request.body, response);
      if (!principal || !record || !input) return;
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
