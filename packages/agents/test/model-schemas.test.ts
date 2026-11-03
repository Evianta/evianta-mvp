import { MuseProvider, modelForTier } from "@evianta/ai";
import { WorkProductSchema } from "@evianta/core";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  PreparationModelOutputSchema,
  SpecialistModelOutputSchema,
} from "../src/contracts.js";
import { createMsmePaymentSpecialists } from "../src/msme-payment.js";
import { createTaxNoticeSpecialists } from "../src/tax-notice.js";

function strictSchemaErrors(value: unknown, path = "$"): string[] {
  if (typeof value !== "object" || value === null) return [];
  if (Array.isArray(value))
    return value.flatMap((entry, index) =>
      strictSchemaErrors(entry, `${path}[${index}]`),
    );
  const record = z.record(z.string(), z.unknown()).parse(value);
  const errors: string[] = [];
  if (record.type === "object") {
    const properties = z
      .record(z.string(), z.unknown())
      .parse(record.properties);
    const required = z.array(z.string()).parse(record.required ?? []);
    for (const key of Object.keys(properties))
      if (!required.includes(key))
        errors.push(`${path}: ${key} must be required`);
    if (record.additionalProperties !== false)
      errors.push(`${path}: additionalProperties must be false`);
  }
  return errors.concat(
    Object.entries(record).flatMap(([key, child]) =>
      strictSchemaErrors(child, `${path}.${key}`),
    ),
  );
}

describe("strict provider model schemas", () => {
  it("reproduces the optional work-product regression before dispatching a request", () => {
    const broken = SpecialistModelOutputSchema.extend({
      workProducts: z.array(WorkProductSchema).optional(),
    });
    const errors = strictSchemaErrors(z.toJSONSchema(broken));
    expect(errors).toContain("$: workProducts must be required");
    expect(
      errors.some((error) => error.endsWith("columnFormats must be required")),
    ).toBe(true);
    expect(
      errors.some((error) => error.endsWith("currencyCode must be required")),
    ).toBe(true);
  });

  it.each(
    [...createMsmePaymentSpecialists(), ...createTaxNoticeSpecialists()].map(
      (agent) => [agent.role, agent] as const,
    ),
  )("uses a strict-compatible schema for %s", (_role, agent) => {
    expect(strictSchemaErrors(z.toJSONSchema(agent.outputSchema))).toEqual([]);
  });

  it("keeps document output out of the analyst contract and requires it only for preparation", () => {
    expect(SpecialistModelOutputSchema.shape).not.toHaveProperty(
      "workProducts",
    );
    expect(z.toJSONSchema(PreparationModelOutputSchema).required).toContain(
      "workProducts",
    );
  });

  it("rejects malformed schedules during structured-output validation", () => {
    const output = {
      summary: "Prepared",
      findings: [],
      inputRequired: null,
      workProducts: [
        {
          key: "reconciliation",
          type: "reconciliation",
          title: "Reconciliation",
          claimant: "Buyer",
          counterparty: "Seller",
          body: "Review the reconciliation.",
          sources: [],
          missingOriginals: [],
          reviewBlockers: [],
          schedules: [
            {
              title: "Amounts",
              columns: ["Amount"],
              columnFormats: ["currency"],
              currencyCode: null,
              rows: [["not a number"]],
            },
          ],
        },
      ],
    };
    expect(PreparationModelOutputSchema.safeParse(output).success).toBe(false);
  });

  it.each([
    ["analysis", SpecialistModelOutputSchema],
    ["preparation", PreparationModelOutputSchema],
  ] as const)(
    "sends an accepted strict %s request through the provider transport",
    async (_name, schema) => {
      let called = false;
      const provider = new MuseProvider({
        apiKey: "synthetic-test-key",
        fetchImplementation: async (_url, init) => {
          called = true;
          const request = z
            .object({
              response_format: z.object({
                json_schema: z.object({
                  strict: z.boolean(),
                  schema: z.record(z.string(), z.unknown()),
                }),
              }),
            })
            .parse(JSON.parse(String(init?.body)));
          const format = request.response_format.json_schema;
          expect(format.strict).toBe(true);
          const errors = strictSchemaErrors(format.schema);
          if (errors.length)
            return new Response(
              JSON.stringify({ error: { message: errors.join("; ") } }),
              { status: 400 },
            );
          return new Response(
            JSON.stringify({
              choices: [
                {
                  finish_reason: "stop",
                  message: {
                    content: JSON.stringify({
                      summary: "Prepared",
                      findings: [],
                      inputRequired: null,
                      workProducts: [],
                    }),
                  },
                },
              ],
              usage: {
                prompt_tokens: 10,
                completion_tokens: 10,
                total_tokens: 20,
              },
            }),
            { status: 200 },
          );
        },
      });
      await expect(
        provider.generateStructured({
          model: modelForTier("cheap", {
            provider: "muse",
            sparkModel: "synthetic-model",
          }),
          system: "Synthetic schema transport test",
          input: { task: "synthetic" },
          schema: z.toJSONSchema(schema),
          maxOutputTokens: 1000,
          signal: new AbortController().signal,
        }),
      ).resolves.toMatchObject({ units: { input: 10, output: 10, total: 20 } });
      expect(called).toBe(true);
    },
  );
});
