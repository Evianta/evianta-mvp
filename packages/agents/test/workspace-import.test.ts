import { describe, expect, it } from "vitest";

import { assertNever } from "@evianta/core";

describe("workspace imports", () => {
  it("loads the public entry point of an internal package", () => {
    expect(() => assertNever("unexpected" as never, "Smoke test")).toThrow(
      "Smoke test: unexpected",
    );
  });
});
