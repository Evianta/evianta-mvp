import type {
  AiClient,
  Citation,
  ModelProviderName,
  ModelTier,
  RunStructuredResult,
} from "@evianta/ai";
import type {
  AgentProfile,
  Case,
  EvidenceConfidence,
  EvidenceLocation,
  ExtractedTable,
  UsageUnits,
} from "@evianta/core";
import type { ZodType } from "zod";

export type AgentRole = string;

export interface AgentLogger {
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
}

export const silentLogger: AgentLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

export interface DocumentSummary {
  id: string;
  name: string;
  mimeType: string;
  state: string;
}

export interface DocumentSlice {
  documentId: string;
  name: string;
  pages: Array<{ page: number; text: string }>;
  tables?: Array<{
    tableId: string;
    sheet: string | null;
    cellRange: string | null;
    text: string;
  }>;
  truncated: boolean;
}

/**
 * Read-only, bounded access to case documents. Agents receive slices rather
 * than whole files and never reach storage directly.
 */
export interface DocumentAccess {
  listAsync(): Promise<DocumentSummary[]>;
  tablesAsync(documentIds: readonly string[]): Promise<
    Array<{
      documentId: string;
      name: string;
      table: ExtractedTable;
    }>
  >;
  sliceAsync(
    documentId: string,
    options?: { pages?: number[]; maxChars?: number },
  ): Promise<DocumentSlice | null>;
}

/** Usage admission is enforced by the AI client; agents pass this boundary. */
export interface UsageBoundary {
  userId: string;
  caseId: string;
  runId: string;
  leaseId: string;
  fencingToken: number;
  taskId?: string;
}

export interface AgentContext {
  ownerId: string;
  case: Case;
  runId: string;
  taskId: string | null;
  documents: DocumentAccess;
  logger: AgentLogger;
  signal: AbortSignal;
  usage: UsageBoundary;
  ai: AiClient;
  /** Validated human input supplied when resuming an interrupted task. */
  humanInput?: unknown;
}

export interface AgentEvidenceDraft {
  kind: "document" | "research";
  documentId?: string;
  location?: EvidenceLocation;
  url?: string;
  title?: string;
  claim?: string;
  span?: string | null;
  sourceRef: string;
  confidence: EvidenceConfidence;
}

export interface AgentResult<O> {
  output: O;
  usage: UsageUnits;
  cost: { status: "estimated" | "unknown"; costUsd: number | null };
  citations: Citation[];
  provider: ModelProviderName | null;
  model: string | null;
  modelTier: ModelTier;
}

export interface Tool {
  name: string;
  description: string;
}

export interface Agent<I, O, ModelOutput = O> {
  role: AgentRole;
  modelTier: ModelTier;
  systemPrompt: string;
  inputSchema: ZodType<I>;
  outputSchema: ZodType<ModelOutput>;
  tools?: Tool[];
  profile: AgentProfile;
  run(input: I, ctx: AgentContext): Promise<AgentResult<O>>;
}

export function toAgentResult<O>(
  result: RunStructuredResult<O>,
  modelTier: ModelTier,
): AgentResult<O> {
  return {
    output: result.output,
    usage: result.usage,
    cost: { status: result.cost.status, costUsd: result.cost.costUsd },
    citations: result.citations,
    provider: result.provider,
    model: result.model,
    modelTier,
  };
}

/** Builds an agent whose `run` wraps `runStructured` from `@evianta/ai`. */
export function defineStructuredAgent<I, O>(definition: {
  profile: AgentProfile;
  systemPrompt: string;
  inputSchema: ZodType<I>;
  outputSchema: ZodType<O>;
  tools?: Tool[];
  maxOutputTokens?: number;
  webSearch?: boolean;
}): Agent<I, O> {
  const modelTier = definition.profile.modelTier;
  return {
    role: definition.profile.role,
    modelTier,
    systemPrompt: definition.systemPrompt,
    inputSchema: definition.inputSchema,
    outputSchema: definition.outputSchema,
    tools: definition.tools,
    profile: definition.profile,
    async run(input, ctx) {
      const result = await ctx.ai.runStructured({
        tier: modelTier,
        inputSchema: definition.inputSchema,
        outputSchema: definition.outputSchema,
        system: definition.systemPrompt,
        input,
        usageContext: { ...ctx.usage, taskId: ctx.taskId ?? undefined },
        signal: ctx.signal,
        maxOutputTokens: definition.maxOutputTokens,
        webSearch: definition.webSearch,
      });
      return toAgentResult(result, modelTier);
    },
  };
}
