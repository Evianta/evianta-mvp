export function assertNever(value: never, message = "Unexpected value"): never {
  throw new Error(`${message}: ${String(value)}`);
}

export * from "./domain.js";
export * from "./fixture-schemas.js";
export * from "./fixtures.js";
export * from "./ports.js";
