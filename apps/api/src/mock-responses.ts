import type { StructuredGenerationRequest } from "@evianta/ai";

const defaultAnalysis = {
  summary: "Analysis completed using the supplied case record.",
  findings: [],
  inputRequired: null,
  interpretation:
    "No significant trend was identified in the supplied records.",
  insights: [],
};

function propertiesOf(request: StructuredGenerationRequest): Set<string> {
  const properties = request.schema.properties;
  return new Set(
    properties && typeof properties === "object" ? Object.keys(properties) : [],
  );
}

/**
 * Deterministic offline answers for each structured agent call, so every
 * enabled workflow runs end to end without a live model.
 */
export function respondToMockRequest(
  request: StructuredGenerationRequest,
): string | undefined {
  const properties = propertiesOf(request);
  const input = request.input as { referencePlan?: unknown } | null;
  if (properties.has("tasks") && Array.isArray(input?.referencePlan)) {
    return JSON.stringify({
      tasks: (
        input.referencePlan as Array<{
          key: string;
          role: string;
          dependsOn: string[];
          instructions: string;
        }>
      ).map((task) => ({
        key: task.key,
        assignedRole: task.role,
        dependsOn: task.dependsOn,
        instructions: task.instructions,
      })),
    });
  }
  if (properties.has("items")) {
    return JSON.stringify({
      summary: "Synthetic review completed; no further concerns were raised.",
      items: [],
    });
  }
  if (properties.has("sources")) {
    return JSON.stringify({
      summary: "No search sources are available in offline mode.",
      sources: [],
    });
  }
  return JSON.stringify(defaultAnalysis);
}
