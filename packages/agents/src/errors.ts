export class OrchestrationError extends Error {
  constructor(
    message: string,
    readonly code: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = new.target.name;
  }
}

export class PlanValidationError extends OrchestrationError {
  constructor(
    message: string,
    readonly issues: string[] = [],
  ) {
    super(
      issues.length ? `${message}: ${issues.join("; ")}` : message,
      "invalid-plan",
    );
  }
}

export class GraphVersionMismatchError extends OrchestrationError {
  constructor(expected: string, actual: string) {
    super(
      `Checkpoint graph version ${actual} does not match ${expected}`,
      "graph-version-mismatch",
    );
  }
}

export class RunNotFoundError extends OrchestrationError {
  constructor() {
    super("The run does not exist in the requested owner scope", "not-found");
  }
}

export class RunConflictError extends OrchestrationError {
  constructor(message: string) {
    super(message, "run-conflict");
  }
}

/**
 * Stops the current worker without committing more domain writes. Thrown
 * when the fenced lease is lost; another worker recovers from durable state.
 */
export class WorkerAbortedError extends OrchestrationError {
  constructor(message = "The worker lost its run lease") {
    super(message, "worker-aborted");
  }
}

export class RunCancelledError extends OrchestrationError {
  constructor() {
    super("The run was cancelled", "cancelled");
  }
}

export function errorCode(error: unknown): string | undefined {
  if (error && typeof error === "object" && "code" in error) {
    const code = (error as { code: unknown }).code;
    return typeof code === "string" ? code : undefined;
  }
  return undefined;
}
