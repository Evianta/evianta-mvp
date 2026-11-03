import {
  AgentProfileSetSchema,
  ApprovalSchema,
  CaseResponseSchema,
  CaseSchema,
  CreateCaseRequestSchema,
  DeliverableSchema,
  DocumentMetadataDtoSchema,
  EvidenceSchema,
  FindingSchema,
  IntakeConfigurationSchema,
  type IntakeConfiguration,
  type ExtractionMethod,
  ListCasesResponseSchema,
  LatestRunResponseSchema,
  RunDtoSchema,
  RunResponseSchema,
  UseCaseSchema,
  type Case,
  type AgentProfile,
  type CaseResponse,
  type CreateCaseRequest,
  type Approval,
  type Deliverable,
  type DeliverableSection,
  type DocumentResponse,
  type ListCasesResponse,
  type LatestRunResponse,
  type RunResponse,
  type RunDto,
} from "@evianta/core";
import { z } from "zod";
import { ApiError } from "./errors";
import { streamRunEvents } from "../events/sse";
import type { RunEvent } from "@evianta/core";

const TokenResponseSchema = z.object({
  accessToken: z.string().min(1),
  expiresAt: z.string().datetime({ offset: true }),
});

const UploadedDocumentsResponseSchema = z.object({
  documents: z.array(DocumentMetadataDtoSchema).min(1),
});

const CaseWorkspaceResponseSchema = z.object({
  case: CaseSchema,
  documents: z.array(DocumentMetadataDtoSchema),
  findings: z.array(FindingSchema),
  evidence: z.array(EvidenceSchema),
  deliverables: z.array(DeliverableSchema),
  approvals: z.array(ApprovalSchema).default([]),
});

const DeliverableResponseSchema = z.object({ deliverable: DeliverableSchema });
const ApprovalResponseSchema = z.object({ approval: ApprovalSchema });

const UsageTotalsSchema = z.object({
  attempts: z.number().int().nonnegative(),
  knownChargesUsd: z.number().finite().nonnegative(),
  unknownExposureUsd: z.number().finite().nonnegative(),
  reservedUsd: z.number().finite().nonnegative(),
});

const AdminUsageResponseSchema = z.object({
  entries: z.array(
    z.object({
      id: z.string().min(1),
      ownerId: z.string().min(1),
      caseId: z.string().min(1),
      runId: z.string().min(1),
      useCase: UseCaseSchema,
      provider: z.string().min(1),
      model: z.string().min(1),
      outcome: z.enum([
        "admitted",
        "success",
        "failed",
        "unknown",
        "cancelled",
      ]),
      costUsd: z.number().finite().nonnegative().nullable(),
      costStatus: z.enum(["estimated", "unknown"]),
      reservedUsd: z.number().finite().nonnegative(),
      reservationStatus: z.enum(["reserved", "settled", "released"]),
      createdAt: z.string().datetime({ offset: true }),
    }),
  ),
  totals: UsageTotalsSchema,
  byUseCase: z.record(UseCaseSchema, UsageTotalsSchema),
  truncated: z.boolean(),
});

const ProfileResponseSchema = z.object({
  user: z.object({
    id: z.string().min(1),
    email: z.string().nullable().optional(),
    displayName: z.string().nullable().optional(),
    role: z.enum(["user", "admin"]),
  }),
  session: z.object({ expiresAt: z.string().datetime({ offset: true }) }),
});

export type AdminUsageResponse = z.infer<typeof AdminUsageResponseSchema>;
export type UserProfile = z.infer<typeof ProfileResponseSchema>["user"];
export type AuthToken = z.infer<typeof TokenResponseSchema>;
export type CaseWorkspace = z.infer<typeof CaseWorkspaceResponseSchema>;
export type ReviewSectionUpdate = {
  expectedVersion: number;
  reviewerContent?: string;
  reviewStatus?: DeliverableSection["reviewStatus"];
  reviewComment?: string | null;
};

type ResponseSchema<T> = {
  safeParse(
    value: unknown,
  ): { success: true; data: T } | { success: false; error: unknown };
};

export interface WebApiClient {
  getIntakeConfiguration(): Promise<IntakeConfiguration>;
  listCases(): Promise<Case[]>;
  getCase(caseId: string): Promise<Case>;
  getCaseWorkspace(caseId: string): Promise<CaseWorkspace>;
  downloadDocument(caseId: string, documentId: string): Promise<Blob>;
  downloadDeliverable?(
    deliverable: Deliverable,
    format: "pdf" | "xlsx" | "json",
  ): Promise<Blob>;
  updateDeliverableSection(
    caseId: string,
    deliverableId: string,
    sectionId: string,
    update: ReviewSectionUpdate,
  ): Promise<Deliverable>;
  approveDeliverable(
    caseId: string,
    deliverableId: string,
    deliverableVersion: number,
    note?: string,
  ): Promise<Approval>;
  getLatestRun(caseId: string): Promise<RunDto | null>;
  createCase(request: CreateCaseRequest): Promise<Case>;
  uploadDocument(
    caseId: string,
    file: File,
    extractionMethod: ExtractionMethod,
  ): Promise<DocumentResponse["document"]>;
  startRun(caseId: string, input?: Record<string, unknown>): Promise<RunDto>;
  retryRun(runId: string): Promise<RunDto>;
  cancelRun(runId: string): Promise<RunDto>;
  resumeRun(
    caseId: string,
    runId: string,
    input: Record<string, unknown>,
    idempotencyKey: string,
  ): Promise<RunDto | null>;
  getAdminUsage(): Promise<AdminUsageResponse>;
  getProfile(): Promise<UserProfile>;
  listAgentDirectory(): Promise<AgentProfile[]>;
  streamRunEvents(
    runId: string,
    options: {
      afterSequence?: number;
      signal: AbortSignal;
      caseId: string;
      onEvent: (event: RunEvent) => void;
      onResync?: (lastSequence: number, nextSequence: number) => void;
      replayOnly?: boolean;
    },
  ): Promise<void>;
  clearPrivateState(): void;
}

export interface WebApiClientOptions {
  getToken: () => string | null;
  onUnauthorized: () => void;
  baseUrl?: string;
  fetcher?: typeof fetch;
}

export class FetchWebApiClient implements WebApiClient {
  private readonly activeStreams = new Set<AbortController>();
  private readonly baseUrl: string;
  private readonly fetcher: typeof fetch;

  constructor(private readonly options: WebApiClientOptions) {
    this.baseUrl = (options.baseUrl ?? "").replace(/\/$/, "");
    this.fetcher = options.fetcher ?? globalThis.fetch.bind(globalThis);
  }

  async getIntakeConfiguration(): Promise<IntakeConfiguration> {
    return this.request("/intake/configuration", IntakeConfigurationSchema);
  }

  async listCases(): Promise<Case[]> {
    const collected: Case[] = [];
    let cursor: string | null = null;
    for (;;) {
      const params = new URLSearchParams();
      if (cursor) params.set("cursor", cursor);
      const response = await this.request<ListCasesResponse>(
        params.size > 0 ? `/cases?${params.toString()}` : "/cases",
        ListCasesResponseSchema,
      );
      collected.push(...response.cases);
      if (!response.nextCursor) break;
      cursor = response.nextCursor;
    }
    return collected;
  }

  async getCase(caseId: string): Promise<Case> {
    const response = await this.request<CaseResponse>(
      `/cases/${encodeURIComponent(caseId)}`,
      CaseResponseSchema,
    );
    return response.case;
  }

  async getCaseWorkspace(caseId: string): Promise<CaseWorkspace> {
    return this.request<CaseWorkspace>(
      `/cases/${encodeURIComponent(caseId)}`,
      CaseWorkspaceResponseSchema,
    );
  }

  async downloadDocument(caseId: string, documentId: string): Promise<Blob> {
    const token = this.options.getToken();
    if (!token) throw new ApiError(401, "Sign in to continue.");
    const response = await this.fetcher(
      `${this.baseUrl}/cases/${encodeURIComponent(caseId)}/documents/${encodeURIComponent(documentId)}/download`,
      {
        headers: { Authorization: `Bearer ${token}` },
        cache: "no-store",
        credentials: "omit",
      },
    );
    if (response.status === 401 && this.options.getToken() === token) {
      this.clearPrivateState();
      this.options.onUnauthorized();
    }
    if (!response.ok) throw await this.errorFromResponse(response);
    return response.blob();
  }

  async downloadDeliverable(
    deliverable: Deliverable,
    format: "pdf" | "xlsx" | "json",
  ): Promise<Blob> {
    const token = this.options.getToken();
    if (!token) throw new ApiError(401, "Sign in to continue.");
    const params = new URLSearchParams({
      format,
      version: String(deliverable.version),
    });
    const response = await this.fetcher(
      `${this.baseUrl}/cases/${encodeURIComponent(deliverable.caseId)}/deliverables/${encodeURIComponent(deliverable.id)}/export?${params}`,
      {
        headers: { Authorization: `Bearer ${token}` },
        cache: "no-store",
        credentials: "omit",
      },
    );
    if (this.options.getToken() !== token)
      throw new ApiError(401, "The signed-in identity changed.");
    if (response.status === 401) {
      this.clearPrivateState();
      this.options.onUnauthorized();
    }
    if (!response.ok) throw await this.errorFromResponse(response);
    const blob = await response.blob();
    if (this.options.getToken() !== token)
      throw new ApiError(401, "The signed-in identity changed.");
    return blob;
  }

  async updateDeliverableSection(
    caseId: string,
    deliverableId: string,
    sectionId: string,
    update: ReviewSectionUpdate,
  ): Promise<Deliverable> {
    const response = await this.request(
      `/cases/${encodeURIComponent(caseId)}/deliverables/${encodeURIComponent(deliverableId)}/sections/${encodeURIComponent(sectionId)}`,
      DeliverableResponseSchema,
      this.jsonInit("PATCH", update),
    );
    return response.deliverable;
  }

  async approveDeliverable(
    caseId: string,
    deliverableId: string,
    deliverableVersion: number,
    note = "",
  ): Promise<Approval> {
    const response = await this.request(
      `/cases/${encodeURIComponent(caseId)}/approve`,
      ApprovalResponseSchema,
      this.jsonInit("POST", { deliverableId, deliverableVersion, note }),
    );
    return response.approval;
  }

  async createCase(request: CreateCaseRequest): Promise<Case> {
    const input = CreateCaseRequestSchema.parse(request);
    const response = await this.request<CaseResponse>(
      "/cases",
      CaseResponseSchema,
      this.jsonInit("POST", input),
    );
    return response.case;
  }

  async getLatestRun(caseId: string): Promise<RunDto | null> {
    const response = await this.request<LatestRunResponse>(
      `/cases/${encodeURIComponent(caseId)}/runs/latest`,
      LatestRunResponseSchema,
    );
    return response.run;
  }

  async uploadDocument(
    caseId: string,
    file: File,
    extractionMethod: ExtractionMethod,
  ): Promise<DocumentResponse["document"]> {
    const formData = new FormData();
    formData.set("files", file);
    const response = await this.request<
      z.infer<typeof UploadedDocumentsResponseSchema>
    >(
      `/cases/${encodeURIComponent(caseId)}/documents`,
      UploadedDocumentsResponseSchema,
      { method: "POST", body: formData },
    );
    void extractionMethod;
    return response.documents[0]!;
  }

  async startRun(
    caseId: string,
    input: Record<string, unknown> = {},
  ): Promise<RunDto> {
    const response = await this.request<RunResponse>(
      "/runs",
      RunResponseSchema,
      this.jsonInit("POST", { caseId, input }),
    );
    return response.run;
  }

  async retryRun(runId: string): Promise<RunDto> {
    const response = await this.request<RunResponse>(
      `/runs/${encodeURIComponent(runId)}/retry`,
      RunResponseSchema,
      this.jsonInit("POST", {}),
    );
    return response.run;
  }

  async cancelRun(runId: string): Promise<RunDto> {
    const response = await this.request<RunResponse>(
      `/runs/${encodeURIComponent(runId)}/cancel`,
      RunResponseSchema,
      this.jsonInit("POST", {}),
    );
    return response.run;
  }

  async resumeRun(
    caseId: string,
    runId: string,
    input: Record<string, unknown>,
    idempotencyKey: string,
  ): Promise<RunDto | null> {
    const response = await this.request(
      `/cases/${encodeURIComponent(caseId)}/runs/${encodeURIComponent(runId)}/resume`,
      z.object({ outcome: z.string(), run: RunDtoSchema.nullable() }),
      this.jsonInit("POST", { idempotencyKey, input }),
    );
    return response.run;
  }

  async getAdminUsage(): Promise<AdminUsageResponse> {
    return this.request<AdminUsageResponse>(
      "/admin/usage/cases?limit=200",
      AdminUsageResponseSchema,
    );
  }

  async getProfile(): Promise<UserProfile> {
    const response = await this.request("/auth/me", ProfileResponseSchema);
    return response.user;
  }

  async listAgentDirectory(): Promise<AgentProfile[]> {
    const response = await this.fetcher(`${this.baseUrl}/directory/agents`, {
      headers: { Accept: "application/json" },
      cache: "no-store",
      credentials: "omit",
    });
    if (!response.ok) throw await this.errorFromResponse(response);
    const parsed = await this.parseResponse(
      response,
      z.object({ agents: AgentProfileSetSchema }),
    );
    return parsed.agents;
  }

  async streamRunEvents(
    runId: string,
    options: {
      afterSequence?: number;
      signal: AbortSignal;
      caseId: string;
      onEvent: (event: RunEvent) => void;
      onResync?: (lastSequence: number, nextSequence: number) => void;
      replayOnly?: boolean;
    },
  ): Promise<void> {
    const token = this.options.getToken();
    if (!token) throw new ApiError(401, "Sign in to continue.");
    const controller = new AbortController();
    const abort = () => controller.abort();
    if (options.signal.aborted) abort();
    options.signal.addEventListener("abort", abort, { once: true });
    this.activeStreams.add(controller);
    try {
      await streamRunEvents({
        url: `${this.baseUrl}/cases/${encodeURIComponent(options.caseId)}/stream?runId=${encodeURIComponent(runId)}`,
        token,
        afterSequence: options.afterSequence,
        signal: controller.signal,
        onEvent: options.onEvent,
        onResync: options.onResync,
        replayOnly: options.replayOnly,
        onUnauthorized: () => {
          if (this.options.getToken() === token) {
            this.clearPrivateState();
            this.options.onUnauthorized();
          }
        },
        fetcher: this.fetcher,
      });
    } finally {
      options.signal.removeEventListener("abort", abort);
      this.activeStreams.delete(controller);
    }
  }

  clearPrivateState(): void {
    for (const stream of this.activeStreams) stream.abort();
    this.activeStreams.clear();
  }

  async exchangeAccessKey(accessKey: string): Promise<AuthToken> {
    const response = await this.fetcher(`${this.baseUrl}/auth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ accessKey }),
      cache: "no-store",
      credentials: "omit",
    });
    if (!response.ok) {
      throw new ApiError(
        response.status,
        response.status === 401
          ? "The access key was not accepted."
          : "Sign-in failed. Try again.",
      );
    }
    return this.parseResponse<AuthToken>(response, TokenResponseSchema);
  }

  async revokeSession(token: string): Promise<void> {
    const response = await this.fetcher(`${this.baseUrl}/auth/logout`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      cache: "no-store",
      credentials: "omit",
    });
    if (!response.ok && response.status !== 401)
      throw await this.errorFromResponse(response);
  }

  private jsonInit(method: string, body: unknown): RequestInit {
    return {
      method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    };
  }

  private async request<T>(
    path: string,
    schema: ResponseSchema<T>,
    init: RequestInit = {},
  ): Promise<T> {
    const token = this.options.getToken();
    if (!token) throw new ApiError(401, "Sign in to continue.");

    const headers = new Headers(init.headers);
    headers.set("Authorization", `Bearer ${token}`);
    headers.set("Accept", "application/json");
    const response = await this.fetcher(`${this.baseUrl}${path}`, {
      ...init,
      headers,
      cache: "no-store",
    });
    if (response.status === 401 && this.options.getToken() === token) {
      this.clearPrivateState();
      this.options.onUnauthorized();
    }
    if (!response.ok) throw await this.errorFromResponse(response);
    return this.parseResponse(response, schema);
  }

  private async parseResponse<T>(
    response: Response,
    schema: ResponseSchema<T>,
  ): Promise<T> {
    let body: unknown;
    try {
      body = await response.json();
    } catch (error) {
      throw new ApiError(502, "The server returned an invalid response.", {
        cause: error,
      });
    }
    const parsed = schema.safeParse(body);
    if (!parsed.success) {
      throw new ApiError(502, "The server returned an invalid response.", {
        cause: parsed.error,
      });
    }
    return parsed.data;
  }

  private async errorFromResponse(response: Response): Promise<ApiError> {
    const detail = await response.text();
    let message = `Request failed (${response.status}).`;
    if (detail) {
      try {
        const body: unknown = JSON.parse(detail);
        const errorMessage =
          typeof body === "object" &&
          body !== null &&
          "error" in body &&
          typeof body.error === "object" &&
          body.error !== null &&
          "message" in body.error &&
          typeof body.error.message === "string"
            ? body.error.message
            : typeof body === "object" &&
                body !== null &&
                "message" in body &&
                typeof body.message === "string"
              ? body.message
              : undefined;

        if (errorMessage) {
          message = errorMessage.slice(0, 500);
        } else {
          message = detail.slice(0, 500);
        }
      } catch {
        message = detail.slice(0, 500);
      }
    }
    return new ApiError(response.status, message);
  }
}
