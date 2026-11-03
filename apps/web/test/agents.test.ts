import type { AgentProfile } from "@evianta/core";
import { describe, expect, it } from "vitest";
import { agentNameForRole, avatarFor, buildDirectory } from "../src/agents.js";

function profile(overrides: Partial<AgentProfile>): AgentProfile {
  return {
    id: "a",
    role: "business-data-analyst",
    displayName: "Business Data Analyst",
    specialty: "Sales",
    summary: "s",
    capabilities: ["c"],
    tools: [],
    procedures: [],
    outputFormats: [],
    limitations: [],
    modelTier: "mid",
    enabled: true,
    ...overrides,
  };
}

describe("agent directory", () => {
  it("puts Evianta first, groups by category and hides engine-only agents", () => {
    const directory = buildDirectory([
      profile({ role: "generic-analyst", displayName: "Generic Analyst" }),
      profile({
        role: "independent-reviewer",
        displayName: "Independent Reviewer",
        kind: "reviewer",
        modelTier: "high",
      }),
      profile({ role: "coordinator", displayName: "Evianta", kind: "lead" }),
      profile({}),
    ]);
    expect(directory.map((agent) => agent.role)).toEqual([
      "coordinator",
      "business-data-analyst",
      "independent-reviewer",
      "calculation-engine",
      "document-reader",
      "evidence-linker",
    ]);
    expect(
      directory.find((a) => a.role === "independent-reviewer")?.speed,
    ).toBe("Deep review");
  });

  it("treats the coordinator as the lead even without a stored category", () => {
    const [lead] = buildDirectory([profile({ role: "coordinator" })]);
    expect(lead?.category).toBe("lead");
    expect(lead?.avatar).toBe("/agents/evianta.svg");
  });

  it("falls back gracefully for unknown roles", () => {
    expect(avatarFor("some-new-role")).toBeNull();
    expect(agentNameForRole("some-new-role", [])).toBe("Some New Role");
    expect(
      agentNameForRole("coordinator", [
        profile({ role: "coordinator", displayName: "Evianta" }),
      ]),
    ).toBe("Evianta");
  });
});
