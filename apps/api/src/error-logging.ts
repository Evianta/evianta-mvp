export interface ErrorLogDetails {
  name: string;
  message: string;
  stack?: string;
  code?: string | number;
  cause?: ErrorLogDetails | { message: string };
  errors?: Array<ErrorLogDetails | { message: string }>;
}

function redact(value: string): string {
  let result = value.replace(
    /\b(mongodb(?:\+srv)?:\/\/)[^/\s@]+@/gi,
    "$1[REDACTED]@",
  );
  for (const [name, secret] of Object.entries(process.env)) {
    if (
      /(?:SECRET|PASSWORD|TOKEN|API_KEY|SIGNING_KEY|MONGODB_URI|PRIVATE_KEY|AWS_ACCESS_KEY_ID)/i.test(
        name,
      ) &&
      secret
    ) {
      result = result.replaceAll(secret, "[REDACTED]");
    }
  }
  return result;
}

export function getErrorLogDetails(error: unknown): ErrorLogDetails {
  const ancestors = new Set<object>();
  function describe(
    value: unknown,
    depth: number,
  ): ErrorLogDetails | { message: string } {
    if (!(value instanceof Error)) {
      return { message: redact(String(value)) };
    }
    if (ancestors.has(value))
      return { name: redact(value.name), message: "[Circular cause]" };
    ancestors.add(value);

    const details: ErrorLogDetails = {
      name: redact(value.name),
      message: redact(value.message),
    };
    if (value.stack) details.stack = redact(value.stack);
    if (
      "code" in value &&
      (typeof value.code === "string" || typeof value.code === "number")
    ) {
      details.code =
        typeof value.code === "string" ? redact(value.code) : value.code;
    }
    if (depth < 5 && value.cause !== undefined) {
      details.cause = describe(value.cause, depth + 1);
    }
    if (depth < 5 && value instanceof AggregateError) {
      details.errors = value.errors.map((error: unknown) =>
        describe(error, depth + 1),
      );
    }
    ancestors.delete(value);
    return details;
  }

  const details = describe(error, 0);
  if ("name" in details) return details;
  return { name: "UnknownError", message: details.message };
}
