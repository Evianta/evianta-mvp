import { StoreError } from "@evianta/store";
import { AiError, inputTokenAllowance, ModelTimeoutError } from "@evianta/ai";
import { MemorySaver } from "@langchain/langgraph";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  RunConflictError,
  RunNotFoundError,
  createMsmePaymentPlan,
  createMsmePaymentSpecialists,
  deliverableIdFor,
  MSME_CASE_PREPARATION_ROLE,
  MSME_DOCUMENT_ANALYSIS_ROLE,
  MSME_EVIDENCE_ANALYSIS_ROLE,
  MSME_LEGAL_RESEARCH_ROLE,
  MSME_PAYMENT_RECONCILIATION_ROLE,
  createTaxNoticePlan,
  createTaxNoticeSpecialists,
  createReviewAgent,
  SpecialistModelOutputSchema,
  SpecialistInputSchema,
  ReviewInputSchema,
  type ReviewInput,
  TAX_NOTICE_ANALYST_ROLE,
  TAX_RECONCILIATION_ROLE,
  TAX_RESPONSE_DRAFTER_ROLE,
  TAX_RESEARCH_ROLE,
  summarizeUsage,
  WorkerAbortedError,
  toTaskRecords,
  type OrchestratorHooks,
} from "../src/index.js";
import {
  CASE_ID,
  Clock,
  LEASE_TTL_SECONDS,
  OWNER,
  ScriptedProvider,
  createHarness,
  newMemoryStore,
  planOf,
  reviewOutput,
  seedAsync,
  specialistOutput,
  makeCase,
  type HarnessOptions,
  type Store,
} from "./harness.js";

const scope = { ownerId: OWNER, caseId: CASE_ID };

let store: Store;

beforeEach(async () => {
  store = newMemoryStore();
  await seedAsync(store.repositories);
});

function routes(...keys: string[]) {
  return Object.fromEntries([
    ...keys.map((key) => [key, () => specialistOutput(key)] as const),
    ["review", () => reviewOutput] as const,
  ]);
}

function harness(options: Omit<HarnessOptions, "repositories">) {
  return createHarness({ repositories: store.repositories, ...options });
}

async function startRunAsync(h: ReturnType<typeof harness>) {
  const run = await h.orchestrator.createRunAsync({
    ownerId: OWNER,
    caseId: CASE_ID,
  });
  const result = await h.worker.runOnceAsync();
  return { run, result };
}

async function tasksOf(runId: string) {
  const tasks = await store.repositories.tasks.listForRun(runId, scope);
  return Object.fromEntries(
    tasks.map((task) => [task.id.slice(runId.length + 1), task]),
  );
}

async function eventsOf(runId?: string) {
  const events = await store.repositories.events.listAfter(CASE_ID, 0, scope);
  return events.filter((event) => !runId || event.runId === runId);
}

async function expectConsistentEvents() {
  const events = await eventsOf();
  const sequences = events.map((event) => event.sequence);
  expect(sequences).toEqual([...sequences].sort((a, b) => a - b));
  expect(new Set(sequences).size).toBe(sequences.length);
  expect(new Set(events.map((event) => event.id)).size).toBe(events.length);
}

async function caseUsage() {
  return (await store.repositories.cases.findOwnedById(CASE_ID, OWNER))!.usage;
}

async function ledger() {
  return store.repositories.usageLedger.list({
    ownerId: OWNER,
    caseId: CASE_ID,
    limit: 5_000,
  });
}

describe("orchestrator", () => {
  const MSME_DOCUMENT_ID = "msme-document-1";
  it("runs the MSME case-pack DAG with unavailable research safely flagged", async () => {
    const plan = createMsmePaymentPlan();
    const invoiceEvidence = specialistOutput(
      "invoices",
    ).findings[0]!.evidence.map((item) => ({
      ...item,
      sourceRef: `${MSME_DOCUMENT_ID}#page=1`,
      documentId: MSME_DOCUMENT_ID,
    }));
    const provider = new ScriptedProvider({
      ...routes("document-analysis", "evidence-analysis", "case-preparation"),
      coordinator: () => ({
        tasks: plan.tasks.map((task) => ({
          key: task.key,
          assignedRole: task.role,
          dependsOn: task.dependsOn,
          instructions: task.instructions,
        })),
      }),
      "document-analysis": () => ({
        summary: "Extracted synthetic invoice and payment amounts.",
        findings: [
          {
            ...specialistOutput("invoices").findings[0]!,
            title: "Invoice records",
            evidence: invoiceEvidence,
            claims: [
              {
                label: "invoice amount: INV-1",
                value: 150_000,
                components: null,
                date: null,
              },
            ],
          },
          {
            ...specialistOutput("payments").findings[0]!,
            title: "Payment records",
            evidence: invoiceEvidence,
            claims: [
              {
                label: "payment amount: PAY-1",
                value: 60_000,
                components: null,
                date: null,
              },
            ],
          },
        ],
        inputRequired: null,
      }),
      "legal-search": () => ({
        summary: "No search citations returned.",
        sources: [],
      }),
    });
    const h = harness({
      provider,
      plan,
      specialists: createMsmePaymentSpecialists(),
      coordinator: true,
    });
    await seedAsync(
      store.repositories,
      "msme-workflow-case",
      { useCase: "msme-payment" },
      MSME_DOCUMENT_ID,
    );
    const msmeCase = makeCase("msme-workflow-case", {
      useCase: "msme-payment",
    });
    const run = await h.orchestrator.createRunAsync({
      ownerId: OWNER,
      caseId: msmeCase.id,
    });

    const result = await h.worker.runOnceAsync();
    const tasks = await store.repositories.tasks.listForRun(run.id, {
      ownerId: OWNER,
      caseId: msmeCase.id,
    });

    expect(result?.run?.status).toBe("completed");
    expect(
      tasks.map((task) => [task.role, task.status, task.lastError]),
    ).toEqual(
      expect.arrayContaining(
        [
          MSME_DOCUMENT_ANALYSIS_ROLE,
          MSME_PAYMENT_RECONCILIATION_ROLE,
          MSME_EVIDENCE_ANALYSIS_ROLE,
          MSME_LEGAL_RESEARCH_ROLE,
          MSME_CASE_PREPARATION_ROLE,
          "independent-reviewer",
        ].map((role) => [role, "completed", null]),
      ),
    );
    const deliverables = await store.repositories.deliverables.listForRun(
      run.id,
      { ownerId: OWNER, caseId: msmeCase.id },
    );
    const deliverable = deliverables[0];
    expect(deliverable).toMatchObject({
      format: "document",
      title: "MSME delayed-payment case pack",
    });
    expect(
      deliverable?.sections.some((section) =>
        JSON.stringify(section).includes("90000"),
      ),
    ).toBe(true);
    expect(
      deliverable?.sections.some((section) =>
        JSON.stringify(section).includes(
          "No legal research sources were verified",
        ),
      ),
    ).toBe(true);
  });

  it.each(["no findings", "unrelated findings"])(
    "reviews the displayed tax draft with %s",
    async (scenario) => {
      await store.repositories.cases.replaceOwned(
        makeCase(CASE_ID, { useCase: "tax-notice" }),
        OWNER,
      );
      const draft =
        "The taxpayer owes no penalty and must respond within seven days.";
      const concern =
        "Verify the penalty outcome and deadline; the draft assertions lack supporting evidence.";
      const provider = new ScriptedProvider({
        "case-analysis": () => specialistOutput("analysis"),
        "response-preparation": () => ({
          summary: draft,
          findings:
            scenario === "no findings"
              ? []
              : specialistOutput("unrelated").findings,
          inputRequired: null,
        }),
        review: (input) => {
          const review = ReviewInputSchema.parse(input);
          expect(review.drafts).toContainEqual({
            taskId: expect.stringContaining(":response-preparation"),
            role: TAX_RESPONSE_DRAFTER_ROLE,
            text: draft,
          });
          expect(JSON.stringify(review.findings)).not.toContain(draft);
          return {
            summary: "Draft assertions need professional verification.",
            items: [{ text: concern, severity: "high", findingId: null }],
          };
        },
      });
      const h = harness({
        provider,
        plan: createTaxNoticePlan(),
        specialists: createTaxNoticeSpecialists(),
      });
      const { run, result } = await startRunAsync(h);
      expect(result?.run?.status).toBe("completed");
      const pack = (
        await store.repositories.deliverables.listForRun(run.id, scope)
      )[0]!;
      expect(
        pack.sections.find(
          (section) => section.producingRole === TAX_RESPONSE_DRAFTER_ROLE,
        )?.content,
      ).toMatchObject({ summary: draft });
      const findings = await store.repositories.findings.listForCase(scope);
      expect(
        findings.flatMap((finding) => finding.openQuestions),
      ).toContainEqual(
        expect.objectContaining({
          text: concern,
          severity: "high",
          status: "open",
        }),
      );
    },
  );

  it.each(["source text ".repeat(250), "é".repeat(2_750)])(
    "budgets repeated tax drafting excerpts (scenario %#)",
    async (quote) => {
      await store.repositories.cases.replaceOwned(
        makeCase(CASE_ID, { useCase: "tax-notice" }),
        OWNER,
      );
      const provider = new ScriptedProvider({
        "case-analysis": () => ({
          summary: "Extracted figures",
          inputRequired: null,
          findings: [
            "return income",
            "notice income",
            "claimed credit",
            "available credit",
          ].map((label, index) => {
            const finding = specialistOutput(label).findings[0]!;
            return {
              ...finding,
              confidence: 1,
              evidence: [
                { ...finding.evidence[0]!, textQuote: quote },
                {
                  kind: "research",
                  sourceRef: "https://www.incometax.gov.in/",
                  confidence: "medium",
                  documentId: null,
                  page: null,
                  textQuote: quote,
                  url: "https://www.incometax.gov.in/",
                  title: "Official guidance",
                  claim: "A source for professional verification.",
                },
              ],
              claims: [
                {
                  label,
                  value: 100 + index * 10,
                  components: null,
                  date: null,
                },
              ],
            };
          }),
        }),
        "response-preparation": () => specialistOutput("response"),
        review: () => reviewOutput,
      });
      const h = harness({
        provider,
        plan: createTaxNoticePlan(),
        specialists: createTaxNoticeSpecialists(),
      });
      const { result } = await startRunAsync(h);
      expect(result?.run?.status).toBe("completed");
      const input = SpecialistInputSchema.parse(
        provider.inputs.get("response-preparation")![0],
      );
      const drafter = createTaxNoticeSpecialists().find(
        (agent) => agent.role === TAX_RESPONSE_DRAFTER_ROLE,
      )!;
      expect(
        inputTokenAllowance({
          system: drafter.systemPrompt,
          input,
          schema: z.toJSONSchema(drafter.outputSchema),
        }),
      ).toBeLessThanOrEqual(32_000 - 256);
      const storedFindings =
        await store.repositories.findings.listForCase(scope);
      const storedEvidence =
        await store.repositories.evidence.listForCase(scope);
      expect(input.priorFindings).toHaveLength(7);
      expect(
        inputTokenAllowance({
          system: drafter.systemPrompt,
          input: {
            ...input,
            documents: [],
            priorFindings: input.priorFindings.map((finding) => ({
              ...finding,
              sourceEvidence: finding.sourceEvidence?.map((evidence) => ({
                ...evidence,
                ...(evidence.location
                  ? { location: { ...evidence.location, textQuote: quote } }
                  : {}),
                ...(evidence.citation
                  ? { citation: { ...evidence.citation, span: quote } }
                  : {}),
              })),
            })),
          },
          schema: z.toJSONSchema(drafter.outputSchema),
        }),
      ).toBeGreaterThan(32_000);
      for (const finding of input.priorFindings) {
        const stored = storedFindings.find(
          (item) => item.id === finding.findingId,
        )!;
        expect(finding).toMatchObject({
          description: stored.description,
          evidenceIds: stored.evidenceIds,
          assumptions: stored.assumptions,
          openQuestions: stored.openQuestions,
        });
        for (const evidence of finding.sourceEvidence ?? []) {
          const original = storedEvidence.find(
            (item) => item.id === evidence.evidenceId,
          )!;
          expect(evidence).toMatchObject({
            sourceRef: original.sourceRef,
            confidence: original.confidence,
            excerptsTruncated: true,
          });
          if (original.kind === "document") {
            expect(evidence.location).toEqual({
              ...original.location,
              textQuote: expect.any(String),
            });
            expect(original.location.textQuote).toBe(quote);
            expect(evidence.location!.textQuote!.length).toBeLessThan(
              quote.length,
            );
          } else {
            expect(evidence.citation).toEqual({
              url: original.citation.url,
              title: original.citation.title,
              claim: original.citation.claim,
              span: expect.any(String),
            });
            expect(original.citation.span).toBe(quote);
            expect(evidence.citation!.span!.length).toBeLessThan(quote.length);
          }
        }
      }
      const reconciled = input.priorFindings.filter(
        (finding) => finding.role === TAX_RECONCILIATION_ROLE,
      );
      expect(reconciled).toHaveLength(2);
      expect(reconciled.map((finding) => finding.claims[0]?.value)).toEqual([
        10, 10,
      ]);
      expect(
        input.priorFindings
          .filter((finding) => finding.role === TAX_NOTICE_ANALYST_ROLE)
          .flatMap((finding) => finding.claims),
      ).toEqual(
        [
          "return income",
          "notice income",
          "claimed credit",
          "available credit",
        ].map((label, index) => ({
          label,
          value: 100 + index * 10,
          components: null,
          date: null,
        })),
      );
      expect(provider.count("response-preparation")).toBe(1);
    },
  );

  it("fails explicitly when mandatory specialist findings exceed the input budget", async () => {
    const provider = new ScriptedProvider({
      a: () => specialistOutput("a", { description: "x".repeat(50_000) }),
      b: () => specialistOutput("b"),
    });
    const h = harness({
      provider,
      plan: planOf([{ key: "a" }, { key: "b", dependsOn: ["a"] }]),
    });
    const { run } = await startRunAsync(h);
    expect((await tasksOf(run.id)).b).toMatchObject({
      status: "failed",
      lastError: { code: "input-limit-exceeded" },
    });
    expect(provider.count("b")).toBe(0);
  });

  it.each(["é", "\u{1f600}"])(
    "budgets repeated review excerpts without dropping findings or source positions (%s)",
    async (character) => {
      const keys = ["a", "b", "c"];
      const quote = character.repeat(14_000);
      const provider = new ScriptedProvider({
        ...Object.fromEntries(
          keys.map((key) => [
            key,
            () => {
              const output = specialistOutput(key);
              output.summary = `${key} draft ${"complete narrative ".repeat(50)}`;
              output.findings[0]!.evidence[0]!.textQuote = quote;
              output.findings[0]!.evidence.push({
                kind: "research",
                sourceRef: "https://www.incometax.gov.in/",
                confidence: "medium",
                documentId: null,
                page: null,
                textQuote: quote,
                url: "https://www.incometax.gov.in/",
                title: "Official guidance",
                claim: "A source for professional verification.",
              });
              return output;
            },
          ]),
        ),
        review: () => reviewOutput,
      });
      const h = harness({
        provider,
        plan: planOf([
          ...keys.map((key) => ({ key })),
          { key: "review", role: "independent-reviewer", dependsOn: keys },
        ]),
      });
      const { result } = await startRunAsync(h);
      expect(result?.run?.status).toBe("completed");
      const input = provider.inputs.get("review")![0] as ReviewInput;
      expect(input.findings).toHaveLength(3);
      expect(input.drafts).toEqual(
        keys.map((key) => ({
          taskId: expect.stringContaining(`:${key}`),
          role: "analyst",
          text: `${key} draft ${"complete narrative ".repeat(50)}`,
        })),
      );
      const reviewer = createReviewAgent();
      expect(
        inputTokenAllowance({
          system: reviewer.systemPrompt,
          input,
          schema: z.toJSONSchema(reviewer.outputSchema),
        }),
      ).toBeLessThanOrEqual(32_000 - 256);
      for (const finding of input.findings) {
        expect(finding.claims).toHaveLength(1);
        expect(finding.sourceEvidence?.[0]).toMatchObject({
          evidenceId: finding.evidenceIds[0],
          sourceRef: "document-1#page=1",
          documentId: "document-1",
          location: { page: 1 },
          excerptsTruncated: true,
        });
        expect(
          finding.sourceEvidence![0]!.location!.textQuote!.length,
        ).toBeLessThan(quote.length);
        expect(finding.sourceEvidence?.[1]).toMatchObject({
          evidenceId: finding.evidenceIds[1],
          sourceRef: "https://www.incometax.gov.in/",
          excerptsTruncated: true,
          citation: {
            url: "https://www.incometax.gov.in/",
            title: "Official guidance",
            claim: "A source for professional verification.",
          },
        });
        expect(finding.sourceEvidence![1]!.citation!.span!.length).toBeLessThan(
          quote.length,
        );
        for (const excerpt of [
          finding.sourceEvidence![0]!.location!.textQuote!,
          finding.sourceEvidence![1]!.citation!.span!,
        ]) {
          expect(excerpt).toBe(character.repeat(Array.from(excerpt).length));
        }
      }
      const stored = await store.repositories.evidence.listForCase(scope);
      expect(
        stored
          .filter((item) => item.kind === "document")
          .every((item) => item.location.textQuote === quote),
      ).toBe(true);
      expect(provider.count("review")).toBe(1);
    },
  );

  it("keeps short excerpts when truncation markers would make them larger", async () => {
    const output = specialistOutput("a");
    const source = output.findings[0]!.evidence[0]!;
    output.findings[0]!.evidence = [
      ...Array.from({ length: 15 }, () => ({
        ...source,
        textQuote: "short text",
      })),
      { ...source, textQuote: "long text ".repeat(300) },
    ];
    const plan = planOf([
      { key: "a" },
      { key: "review", role: "independent-reviewer", dependsOn: ["a"] },
    ]);
    const providerOf = () =>
      new ScriptedProvider({
        a: () => output,
        review: () => reviewOutput,
      });
    const calibration = providerOf();
    expect(
      (await startRunAsync(harness({ provider: calibration, plan }))).result
        ?.run?.status,
    ).toBe("completed");
    const original = ReviewInputSchema.parse(
      calibration.inputs.get("review")![0],
    );
    const reviewer = createReviewAgent();
    const allowance = (input: ReviewInput) =>
      inputTokenAllowance({
        system: reviewer.systemPrompt,
        input,
        schema: z.toJSONSchema(reviewer.outputSchema),
      });
    const trimmed = (cap: number): ReviewInput => ({
      ...original,
      findings: original.findings.map((finding) => ({
        ...finding,
        sourceEvidence: finding.sourceEvidence!.map((evidence) => ({
          ...evidence,
          location: {
            ...evidence.location,
            textQuote: evidence.location!.textQuote!.slice(0, cap),
          },
          ...(evidence.location!.textQuote!.length > cap
            ? { excerptsTruncated: true }
            : {}),
        })),
      })),
    });
    const limit = allowance(trimmed(10));
    expect(allowance(original)).toBeGreaterThan(limit);
    expect(allowance(trimmed(1))).toBeGreaterThan(limit);
    store = newMemoryStore();
    await seedAsync(store.repositories);
    const provider = providerOf();
    const { result } = await startRunAsync(
      harness({ provider, plan, maxInputTokens: limit + 256 }),
    );
    expect(result?.run?.status).toBe("completed");
    const input = ReviewInputSchema.parse(provider.inputs.get("review")![0]);
    expect(allowance(input)).toBeLessThanOrEqual(limit);
    const evidence = input.findings[0]!.sourceEvidence!;
    for (const short of evidence.slice(0, 15)) {
      expect(short.location!.textQuote).toBe("short text");
      expect(short.excerptsTruncated).toBeUndefined();
    }
    expect(evidence[15]).toMatchObject({ excerptsTruncated: true });
    expect(evidence[15]!.location!.textQuote!.length).toBeGreaterThan(1);
  });

  it.each(["findings", "draft"])(
    "fails explicitly when mandatory review %s cannot fit",
    async (content) => {
      const provider = new ScriptedProvider({
        a: () => ({
          ...specialistOutput(
            "a",
            content === "findings" ? { description: "x".repeat(50_000) } : {},
          ),
          ...(content === "draft" ? { summary: "x".repeat(50_000) } : {}),
        }),
        review: () => reviewOutput,
      });
      const h = harness({
        provider,
        plan: planOf([
          { key: "a" },
          { key: "review", role: "independent-reviewer", dependsOn: ["a"] },
        ]),
      });
      const { run } = await startRunAsync(h);
      expect((await tasksOf(run.id)).review).toMatchObject({
        status: "failed",
        lastError: { code: "input-limit-exceeded" },
      });
      expect(provider.count("review")).toBe(0);
    },
  );

  it.each([
    "low-confidence",
    "handwriting",
    "warning-bearing",
    "unreliable-page",
    "reliable OCR",
    "long reliable OCR",
    "long unreliable-page",
    "long warning-bearing",
  ])(
    "uses persisted %s extraction reliability instead of analyst confidence",
    async (scenario) => {
      const reliability = scenario.replace("long ", "");
      const pageCount = scenario.startsWith("long ") ? 200 : 1;
      const original = (await store.repositories.extractions.findForDocument(
        "document-1",
        scope,
      ))!;
      const method = reliability === "handwriting" ? "handwriting" : "ocr";
      await store.repositories.extractions.saveForDocument(
        {
          ...original,
          method,
          confidence: reliability === "low-confidence" ? 0.4 : 0.9,
          pages: Array.from({ length: pageCount }, (_, index) => ({
            ...original.pages[0]!,
            index,
            method,
            confidence:
              reliability === "unreliable-page" && index === pageCount - 1
                ? 0.4
                : 0.9,
          })),
          warnings:
            reliability === "warning-bearing"
              ? Array.from({ length: pageCount }, (_, index) => ({
                  code: "handwriting-needs-review",
                  message: "Verify handwritten text against the original.",
                  pageIndex: index,
                }))
              : [],
        },
        scope,
      );
      await store.repositories.cases.replaceOwned(
        makeCase(CASE_ID, { useCase: "tax-notice" }),
        OWNER,
      );
      const provider = new ScriptedProvider({
        "case-analysis": () => ({
          summary: "Extracted figures",
          inputRequired: null,
          findings: [
            "return income",
            "notice income",
            "claimed credit",
            "available credit",
          ].map((label, index) => ({
            ...specialistOutput(label).findings[0]!,
            confidence: 1,
            claims: [
              { label, value: 100 + index * 10, components: null, date: null },
            ],
          })),
        }),
        "response-preparation": () => specialistOutput("response"),
        review: () => reviewOutput,
      });
      const h = harness({
        provider,
        plan: createTaxNoticePlan(),
        specialists: createTaxNoticeSpecialists(),
      });
      const { run, result } = await startRunAsync(h);
      expect(result?.run?.status).toBe("completed");
      const analysis = provider.inputs.get("case-analysis")![0]!;
      expect(analysis.documents).toEqual([
        expect.objectContaining({
          extraction: expect.objectContaining({
            method,
            confidence: reliability === "low-confidence" ? 0.4 : 0.9,
            pageCount,
          }),
        }),
      ]);
      const pack = (
        await store.repositories.deliverables.listForRun(run.id, scope)
      )[0]!;
      const section = pack.sections.find(
        (item) => item.producingRole === TAX_RECONCILIATION_ROLE,
      )!;
      const content = section.content as {
        findings: { title: string; claims: unknown[] }[];
      };
      const draftingInput = SpecialistInputSchema.parse(
        provider.inputs.get("response-preparation")![0],
      );
      const drafter = createTaxNoticeSpecialists().find(
        (specialist) => specialist.role === TAX_RESPONSE_DRAFTER_ROLE,
      )!;
      expect(
        inputTokenAllowance({
          system: drafter.systemPrompt,
          input: draftingInput,
          schema: z.toJSONSchema(SpecialistModelOutputSchema),
        }),
      ).toBeLessThanOrEqual(32_000);
      for (const finding of draftingInput.priorFindings) {
        for (const evidence of finding.sourceEvidence ?? []) {
          if (evidence.kind !== "document") continue;
          expect(evidence.extraction).not.toHaveProperty("pages");
          expect(JSON.stringify(evidence.extraction).length).toBeLessThan(400);
        }
      }
      expect(
        (
          await store.repositories.extractions.findForDocument(
            "document-1",
            scope,
          )
        )?.pages,
      ).toHaveLength(pageCount);
      if (reliability === "reliable OCR") {
        expect(
          content.findings.every((finding) => finding.claims.length === 1),
        ).toBe(true);
        const findings = await store.repositories.findings.listForCase(scope);
        expect(
          findings
            .filter((finding) => section.findingIds.includes(finding.id))
            .every((finding) => finding.confidence === 0.9),
        ).toBe(true);
      } else {
        expect(
          content.findings.every(
            (finding) =>
              finding.title.endsWith("incomplete") &&
              finding.claims.length === 0,
          ),
        ).toBe(true);
        const findings = await store.repositories.findings.listForCase(scope);
        expect(
          findings
            .filter((finding) => section.findingIds.includes(finding.id))
            .every((finding) =>
              finding.openQuestions.some(
                (question) =>
                  question.severity === "high" &&
                  question.text.includes("Verify unreadable"),
              ),
            ),
        ).toBe(true);
      }
    },
  );

  it.each(["unavailable search", "search citations", "omitted slices"])(
    "runs the tax DAG and preserves evidence with %s",
    async (scenario) => {
      const withCitations = scenario === "search citations";
      const plan = createTaxNoticePlan();
      const citation = {
        url: "https://www.incometax.gov.in/",
        title: "Income Tax Department guidance",
        span: "A provider excerpt that is not an applicability determination.",
      };
      const provider = new ScriptedProvider(
        {
          ...routes("case-analysis", "response-preparation"),
          coordinator: () => ({
            tasks: plan.tasks.map((task) => ({
              key: task.key,
              assignedRole: task.role,
              dependsOn: task.dependsOn,
              instructions: task.instructions,
            })),
          }),
          "case-analysis": () => ({
            summary: "Extracted synthetic source figures.",
            findings: [
              {
                ...specialistOutput("return").findings[0]!,
                title: "Return figures",
                assumptions: ["Return values are in INR."],
                openQuestions: [
                  { text: "Confirm the assessment year.", severity: "medium" },
                ],
                claims: [
                  {
                    label: "return income",
                    value: 1_200_000,
                    components: null,
                    date: null,
                  },
                ],
              },
              {
                ...specialistOutput("claimed-credit").findings[0]!,
                title: "Claimed credit",
                claims: [
                  {
                    label: "claimed credit",
                    value: 80_000,
                    components: null,
                    date: null,
                  },
                ],
              },
              {
                ...specialistOutput("notice").findings[0]!,
                title: "Notice figures",
                description: "Notice requests bank records by 15 November.",
                claims: [
                  {
                    label: "notice income",
                    value: 1_350_000,
                    components: null,
                    date: null,
                  },
                ],
              },
              {
                ...specialistOutput("available-credit").findings[0]!,
                title: "Available credit",
                claims: [
                  {
                    label: "available credit",
                    value: 75_000,
                    components: null,
                    date: null,
                  },
                ],
              },
              {
                ...specialistOutput("notice-questions").findings[0]!,
                title: "Notice requirements",
                assumptions: ["The supplied notice is complete."],
                openQuestions: [
                  {
                    text: "Verify the response deadline against the full notice.",
                    severity: "high",
                  },
                ],
                claims: [],
              },
            ],
            inputRequired: null,
          }),
          "tax-search": () => ({ summary: "No search citations returned." }),
        },
        0,
        withCitations ? { "tax-search": [citation] } : {},
      );
      const h = harness({
        provider,
        plan,
        specialists: createTaxNoticeSpecialists().map((specialist) =>
          scenario === "omitted slices" &&
          specialist.role === TAX_RECONCILIATION_ROLE
            ? {
                ...specialist,
                systemPrompt: "x".repeat(150_000),
                async run(input, context) {
                  expect(input.documents).toEqual([]);
                  return specialist.run(input, context);
                },
              }
            : specialist,
        ),
        coordinator: true,
        ...(withCitations
          ? {
              accounting: {
                mode: "test" as const,
                admit: async () => undefined,
                record: async () => undefined,
                cancel: async () => undefined,
              },
            }
          : {}),
      });
      await store.repositories.cases.replaceOwned(
        makeCase(CASE_ID, { useCase: "tax-notice" }),
        OWNER,
      );
      const run = await h.orchestrator.createRunAsync({
        ownerId: OWNER,
        caseId: CASE_ID,
      });

      const result = await h.worker.runOnceAsync();

      const tasks = await store.repositories.tasks.listForRun(run.id, {
        ownerId: OWNER,
        caseId: CASE_ID,
      });
      expect(
        tasks.map((task) => [task.role, task.status, task.lastError]),
      ).toEqual(
        expect.arrayContaining(
          [
            TAX_NOTICE_ANALYST_ROLE,
            TAX_RECONCILIATION_ROLE,
            TAX_RESEARCH_ROLE,
            TAX_RESPONSE_DRAFTER_ROLE,
            "independent-reviewer",
          ].map((role) => [role, "completed", null]),
        ),
      );
      expect(result?.run?.status).toBe("completed");
      expect(tasks.map((task) => task.role).sort()).toEqual(
        [
          TAX_NOTICE_ANALYST_ROLE,
          TAX_RECONCILIATION_ROLE,
          TAX_RESEARCH_ROLE,
          TAX_RESPONSE_DRAFTER_ROLE,
          "independent-reviewer",
        ].sort(),
      );
      expect(provider.calls).toContain("coordinator");
      const deliverables = await store.repositories.deliverables.listForRun(
        run.id,
        scope,
      );
      const deliverable = deliverables[0];
      expect(deliverable).toMatchObject({
        format: "document",
        title: "Tax notice response pack",
      });
      expect(
        deliverable?.sections.some((section) =>
          JSON.stringify(section).includes("150000"),
        ),
      ).toBe(true);
      const drafter = provider.inputs.get("response-preparation")?.[0];
      expect(drafter?.priorFindings).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            title: "Notice figures",
            description: "Notice requests bank records by 15 November.",
          }),
          expect.objectContaining({
            title: "Return figures",
            confidence: 0.8,
            assumptions: ["Return values are in INR."],
            openQuestions: [
              expect.objectContaining({
                text: "Confirm the assessment year.",
                status: "open",
              }),
            ],
          }),
        ]),
      );
      const review = provider.inputs.get("review")?.[0];
      expect(JSON.stringify(review?.findings)).toContain(
        "Confirm the assessment year.",
      );
      expect(drafter?.priorFindings).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            title: "Notice requirements",
            assumptions: ["The supplied notice is complete."],
            openQuestions: [
              expect.objectContaining({
                text: "Verify the response deadline against the full notice.",
                severity: "high",
                status: "open",
              }),
            ],
          }),
        ]),
      );
      expect(JSON.stringify(review?.findings)).toContain(
        "Verify the response deadline against the full notice.",
      );
      const evidence = await store.repositories.evidence.listForCase(scope);
      const reconciliation = deliverable?.sections.find(
        (section) => section.producingRole === TAX_RECONCILIATION_ROLE,
      );
      expect(reconciliation?.evidenceIds).toHaveLength(2);
      expect(
        evidence.filter((item) =>
          reconciliation?.evidenceIds.includes(item.id),
        ),
      ).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            kind: "document",
            documentId: "document-1",
          }),
        ]),
      );
      if (withCitations) {
        expect(evidence).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              kind: "research",
              citation: expect.objectContaining({
                ...citation,
                claim: expect.stringContaining(
                  "currency and applicability have not been verified",
                ),
                span: citation.span,
              }),
            }),
          ]),
        );
        expect(JSON.stringify(drafter?.priorFindings)).toContain(citation.url);
        expect(JSON.stringify(review?.findings)).toContain(citation.url);
        expect(
          deliverable?.sections.find(
            (section) => section.producingRole === TAX_RESEARCH_ROLE,
          )?.evidenceIds,
        ).toHaveLength(1);
      } else {
        expect(JSON.stringify(drafter?.priorFindings)).toContain(
          "Which provisions and deadlines apply",
        );
        expect(
          deliverable?.sections.some((section) =>
            JSON.stringify(section).includes(
              "No legal research sources were verified",
            ),
          ),
        ).toBe(true);
      }
    },
  );

  it("rejects a changed reference version before planning or dispatch", async () => {
    const provider = new ScriptedProvider(routes("a"));
    const plan = planOf([{ key: "a" }]);
    const h = harness({ provider, plan, reviewer: false });
    const run = await h.orchestrator.createRunAsync({
      ownerId: OWNER,
      caseId: CASE_ID,
    });
    h.plans.register({ ...plan, version: 2 });
    expect((await h.worker.runOnceAsync())?.run?.status).toBe("failed");
    expect(provider.calls).toEqual([]);
    expect(await tasksOf(run.id)).toEqual({});
    expect((await eventsOf(run.id)).at(-1)?.payload).toMatchObject({
      type: "run-failed",
      error: { code: "plan-version-mismatch" },
    });
  });

  it("restores a persisted spend stop before starting pending branches", async () => {
    const provider = new ScriptedProvider(routes("a", "b"));
    const plan = planOf([{ key: "a" }, { key: "b" }]);
    const h = harness({ provider, plan, reviewer: false });
    const run = await h.orchestrator.createRunAsync({
      ownerId: OWNER,
      caseId: CASE_ID,
    });
    const lease = await h.orchestrator.acquireAsync(run, "first-worker");
    const records = toTaskRecords(CASE_ID, run.id, 1, plan.tasks);
    records[0].status = "limit-reached";
    await store.repositories.tasks.insertPlan(records, scope, lease);
    h.clock.advance(LEASE_TTL_SECONDS + 1);

    expect((await h.worker.runOnceAsync())?.run?.status).toBe("limit-reached");
    expect(provider.calls).toEqual([]);
    expect((await tasksOf(run.id)).b.status).toBe("limit-reached");
  });

  it("does not repeat paid planning after losing its uncommitted result", async () => {
    const plan = planOf([{ key: "a" }, { key: "b" }]);
    const provider = new ScriptedProvider({
      ...routes("a", "b"),
      coordinator: () => ({
        tasks: plan.tasks.map((task) => ({
          ...task,
          assignedRole: task.role,
        })),
      }),
    });
    const h = harness({ provider, plan, coordinator: true, reviewer: false });
    const insert = vi
      .spyOn(store.repositories.tasks, "insertPlan")
      .mockRejectedValueOnce(new WorkerAbortedError());
    const run = await h.orchestrator.createRunAsync({
      ownerId: OWNER,
      caseId: CASE_ID,
    });
    expect((await h.worker.runOnceAsync())?.outcome).toBe("aborted");
    insert.mockRestore();
    h.clock.advance(LEASE_TTL_SECONDS + 1);

    expect((await h.worker.runOnceAsync())?.run?.status).toBe("failed");
    expect(provider.calls).toEqual(["coordinator"]);
    expect((await eventsOf(run.id)).at(-1)?.payload).toMatchObject({
      type: "run-failed",
      error: { code: "planning-interrupted" },
    });
  });

  it("shares the model input budget across full document slices", async () => {
    const documents = store.repositories.documents;
    const original = (await documents.findOwned("document-1", scope))!;
    const extraction = (await store.repositories.extractions.findForDocument(
      original.id,
      scope,
    ))!;
    for (const id of ["document-1", "document-2"]) {
      if (id !== original.id) {
        await documents.insert({ ...original, id, name: `${id}.pdf` }, scope);
      }
      await store.repositories.extractions.saveForDocument(
        {
          ...extraction,
          documentId: id,
          pages: [{ ...extraction.pages[0], text: "x".repeat(20000) }],
        },
        scope,
      );
    }
    const provider = new ScriptedProvider(routes("a"));
    const h = harness({ provider, plan: planOf([{ key: "a" }]) });
    expect((await startRunAsync(h)).result?.run?.status).toBe("completed");
    const slices = provider.inputs.get("a")![0].documents as Array<{
      pages: Array<{ text: string }>;
      truncated: boolean;
    }>;
    expect(slices).toHaveLength(2);
    expect(slices.every((slice) => slice.truncated)).toBe(true);
    expect(slices.every((slice) => slice.pages[0].text.length > 0)).toBe(true);
    expect(provider.count("a")).toBe(1);
  });

  it("advances past an admission-blocked batch to another eligible owner", async () => {
    const provider = new ScriptedProvider(routes("a"));
    const h = harness({ provider, plan: planOf([{ key: "a" }]) });
    for (let index = 0; index < 12; index += 1) {
      const id = `busy-case-${index}`;
      await store.repositories.cases.insert(makeCase(id));
      const run = await h.orchestrator.createRunAsync({
        ownerId: OWNER,
        caseId: id,
      });
      if (index < 2) await h.orchestrator.acquireAsync(run, `lease-${index}`);
      h.clock.advance(1);
    }
    await store.repositories.cases.insert(
      makeCase("eligible-case", { ownerId: "other-owner" }),
    );
    const eligible = await h.orchestrator.createRunAsync({
      ownerId: "other-owner",
      caseId: "eligible-case",
    });
    expect(await h.worker.runOnceAsync()).toBeNull();
    expect((await h.worker.runOnceAsync())?.run).toMatchObject({
      id: eligible.id,
      status: "completed",
    });
    expect(provider.calls).toEqual(["a"]);
  });

  it("runs a linear plan to completion with findings, evidence and usage", async () => {
    const provider = new ScriptedProvider(routes("a", "b"));
    const h = harness({
      provider,
      plan: planOf([{ key: "a" }, { key: "b", dependsOn: ["a"] }]),
    });
    const { run, result } = await startRunAsync(h);

    expect(result?.outcome).toBe("finalized");
    expect(result?.run?.status).toBe("completed");
    expect(result?.run?.leaseId).toBeNull();
    expect(provider.calls).toEqual(["a", "b"]);
    const tasks = await tasksOf(run.id);
    expect(tasks.a.status).toBe("completed");
    expect(tasks.a.attemptCount).toBe(1);
    expect(tasks.a.usage.totalUnits).toBe(500);
    expect(tasks.b.usage.costStatus).toBe("estimated");

    // Dependency findings flow into the dependent task input.
    const bInput = provider.inputs.get("b")![0] as {
      priorFindings: Array<{ findingId: string }>;
      documents: Array<{ documentId: string }>;
    };
    expect(bInput.priorFindings.map((item) => item.findingId)).toEqual([
      `${run.id}:a:finding:0`,
    ]);
    expect(bInput.documents[0].documentId).toBe("document-1");

    const findings = await store.repositories.findings.listForCase(scope);
    expect(findings.map((finding) => finding.id).sort()).toEqual([
      `${run.id}:a:finding:0`,
      `${run.id}:b:finding:0`,
    ]);
    const evidence = await store.repositories.evidence.listForCase(scope);
    expect(evidence).toHaveLength(2);
    expect(evidence[0]).toMatchObject({
      kind: "document",
      documentId: "document-1",
      location: { page: 1, textQuote: "Revenue 100" },
    });

    const deliverable = await store.repositories.deliverables.findOwnedById(
      deliverableIdFor(run.id),
      scope,
    );
    expect(deliverable?.sections).toHaveLength(2);
    expect(deliverable?.sections[0]).toMatchObject({
      title: "Section a",
      producingRole: "analyst",
      routingTier: "cheap",
      provider: "mock",
      model: "mock-spark",
      findingIds: [`${run.id}:a:finding:0`],
      evidenceIds: [`${run.id}:a:evidence:0:0`],
      reviewStatus: "pending",
    });

    const types = (await eventsOf(run.id)).map((event) => event.payload.type);
    expect(types[0]).toBe("run-started");
    expect(types.at(-1)).toBe("run-completed");
    expect(types).toEqual(
      expect.arrayContaining([
        "task-started",
        "finding-added",
        "task-completed",
        "cost-updated",
      ]),
    );
    await expectConsistentEvents();

    const entries = await ledger();
    expect(entries).toHaveLength(2);
    expect(await caseUsage()).toEqual(summarizeUsage(entries));
    expect(result?.run?.usage.totalUnits).toBe(1_000);
  });

  it("fans out branches with bounded concurrency and runs deterministic review", async () => {
    const provider = new ScriptedProvider(
      {
        a: () =>
          specialistOutput("a", {
            claims: [
              { label: "total", value: 100, components: [60, 30], date: null },
            ],
          }),
        b: () => specialistOutput("b", { severity: "high", evidence: [] }),
        review: () => ({
          summary: "Narrative is thin",
          items: [
            { text: "Explain the variance", severity: "low", findingId: null },
          ],
        }),
      },
      5,
    );
    const h = harness({
      provider,
      maxBranchConcurrency: 1,
      plan: planOf([
        { key: "a" },
        { key: "b" },
        { key: "review", role: "independent-reviewer", dependsOn: ["a", "b"] },
      ]),
    });
    const { run, result } = await startRunAsync(h);

    expect(result?.run?.status).toBe("completed");
    expect(provider.maxActive).toBe(1);
    expect(provider.calls.at(-1)).toBe("review");
    const reviewInput = provider.inputs.get("review")![0] as {
      findings: Array<{ taskId: string }>;
      deterministicFlags: Array<{ code: string }>;
      instructions: string;
    };
    expect(reviewInput.instructions).toBe("Do review");
    expect(new Set(reviewInput.findings.map((item) => item.taskId))).toEqual(
      new Set([`${run.id}:a`, `${run.id}:b`]),
    );
    expect(
      reviewInput.deterministicFlags.map((flag) => flag.code).sort(),
    ).toEqual(["missing-evidence", "total-mismatch"]);
    const review = (await store.repositories.findings.listForCase(scope)).find(
      (finding) => finding.id === `${run.id}:review:finding:0`,
    )!;
    expect(review.severity).toBe("high");
    expect(review.openQuestions).toHaveLength(3);
    expect(review.openQuestions[0].id).toBe(`${run.id}:review:finding:0:q0`);
    const deliverable = await store.repositories.deliverables.findOwnedById(
      deliverableIdFor(run.id),
      scope,
    );
    expect(
      deliverable?.sections.find(
        (section) => section.producingRole === "independent-reviewer",
      ),
    ).toMatchObject({ routingTier: "high", model: "mock-wonder" });
  });

  it("runs independent branches in parallel when allowed", async () => {
    const provider = new ScriptedProvider(routes("a", "b"), 20);
    const h = harness({
      provider,
      maxBranchConcurrency: 2,
      reviewer: false,
      plan: planOf([{ key: "a" }, { key: "b" }]),
    });
    const { result } = await startRunAsync(h);
    expect(result?.run?.status).toBe("completed");
    expect(provider.maxActive).toBe(2);
  });

  it("blocks only dependents of a failed task and retries only failed work", async () => {
    let failA = true;
    const provider = new ScriptedProvider({
      ...routes("b", "c"),
      a: () => {
        if (failA) throw new Error("synthetic provider outage");
        return specialistOutput("a");
      },
    });
    const h = harness({
      provider,
      reviewer: false,
      plan: planOf([
        { key: "a" },
        { key: "b", dependsOn: ["a"] },
        { key: "c" },
      ]),
    });
    const { run, result } = await startRunAsync(h);

    expect(result?.run?.status).toBe("partially-completed");
    let tasks = await tasksOf(run.id);
    expect(tasks.a.status).toBe("failed");
    expect(tasks.a.lastError?.code).toBeTruthy();
    expect(tasks.b.status).toBe("skipped");
    expect(tasks.b.lastError?.code).toBe("blocked-by-dependency");
    expect(tasks.c.status).toBe("completed");
    expect(
      (await eventsOf(run.id)).some(
        (event) => event.payload.type === "task-failed",
      ),
    ).toBe(true);
    // A provider failure after dispatch leaves the charge unknown.
    expect(result?.run?.usage.costStatus).toBe("unknown");
    expect((await caseUsage()).costStatus).toBe("unknown");

    failA = false;
    const callsBefore = provider.calls.length;
    const retry = await h.orchestrator.retryFailedAsync({
      ownerId: OWNER,
      caseId: CASE_ID,
      priorRunId: run.id,
    });
    expect(retry.priorRunId).toBe(run.id);
    const retried = await h.worker.runOnceAsync();
    expect(retried?.run?.status).toBe("completed");
    expect(provider.calls.slice(callsBefore).sort()).toEqual(["a", "b"]);
    tasks = await tasksOf(retry.id);
    expect(tasks.c.status).toBe("completed");
    expect(tasks.a.attemptCount).toBe(1);

    const sections = (await store.repositories.deliverables.findOwnedById(
      deliverableIdFor(retry.id),
      scope,
    ))!.sections;
    expect(
      sections.map((section) => section.id.split(":").at(-1)).sort(),
    ).toEqual(["a", "b", "c"]);
    // Carried sections reuse the original commit rather than re-running it.
    expect(
      sections.find((section) => section.id.endsWith(":c"))?.findingIds,
    ).toEqual([`${run.id}:c:finding:0`]);

    const entries = await ledger();
    expect(new Set(entries.map((entry) => entry.runId))).toEqual(
      new Set([run.id, retry.id]),
    );
    expect(await caseUsage()).toEqual(summarizeUsage(entries));
  });

  it("retains the failed task's timeout in durable terminal state and events", async () => {
    const timeout = new ModelTimeoutError(180_000);
    const provider = new ScriptedProvider({
      a: () => {
        throw timeout;
      },
    });
    const h = harness({
      provider,
      reviewer: false,
      plan: planOf([{ key: "a" }, { key: "b", dependsOn: ["a"] }]),
    });
    const { run, result } = await startRunAsync(h);
    expect(result?.run?.status).toBe("failed");
    const error = {
      code: "model-timeout",
      message: `The analyst task failed: ${timeout.message}`,
    };
    expect(result?.run?.terminalEvent?.error).toEqual(error);
    expect((await eventsOf(run.id)).at(-1)?.payload).toEqual({
      type: "run-failed",
      error,
    });
    const tasks = await tasksOf(run.id);
    expect(tasks.a.lastError).toEqual({
      code: "model-timeout",
      message: timeout.message,
    });
    expect(tasks.b.lastError?.code).toBe("blocked-by-dependency");
    expect(provider.calls).toEqual(["a"]);
    expect(result?.run?.usage.costStatus).toBe("unknown");
  });

  it("keeps terminal task errors within the public error message limit", async () => {
    const h = harness({
      provider: new ScriptedProvider({
        a: () => {
          throw new AiError("x".repeat(500), "provider-request-failed");
        },
      }),
      reviewer: false,
      plan: planOf([{ key: "a" }]),
    });
    const { run, result } = await startRunAsync(h);
    expect(result?.run?.status).toBe("failed");
    const terminal = (await eventsOf(run.id)).at(-1)?.payload;
    expect(terminal).toMatchObject({
      type: "run-failed",
      error: {
        code: "provider-request-failed",
        message: `The analyst task failed: ${"x".repeat(500)}`.slice(0, 500),
      },
    });
  });

  it("refuses to retry runs without failed work or with an active run", async () => {
    const provider = new ScriptedProvider(routes("a"));
    const h = harness({
      provider,
      reviewer: false,
      plan: planOf([{ key: "a" }]),
    });
    const { run } = await startRunAsync(h);
    await expect(
      h.orchestrator.retryFailedAsync({
        ownerId: OWNER,
        caseId: CASE_ID,
        priorRunId: run.id,
      }),
    ).rejects.toBeInstanceOf(RunConflictError);
    await expect(
      h.orchestrator.retryFailedAsync({
        ownerId: "user-2",
        caseId: CASE_ID,
        priorRunId: run.id,
      }),
    ).rejects.toBeInstanceOf(RunNotFoundError);
  });

  it("retries planning after a missing price fails before any tasks exist", async () => {
    const plan = planOf([{ key: "a" }, { key: "b" }]);
    const provider = new ScriptedProvider({
      ...routes("a", "b"),
      coordinator: () => ({
        tasks: plan.tasks.map((task) => ({
          key: task.key,
          assignedRole: task.role,
          dependsOn: task.dependsOn,
          instructions: task.instructions,
        })),
      }),
    });
    const h = harness({
      provider,
      coordinator: true,
      reviewer: false,
      plan,
    });
    const priceLookup = vi
      .spyOn(store.repositories.usagePrices, "findActive")
      .mockResolvedValueOnce(null);
    const { run, result } = await startRunAsync(h);
    expect(result?.run?.status).toBe("failed");
    expect(await tasksOf(run.id)).toEqual({});
    expect(provider.calls).toEqual([]);
    expect(await ledger()).toEqual([]);
    expect((await eventsOf(run.id)).at(-1)?.payload).toMatchObject({
      type: "run-failed",
      error: { code: "usage-admission-rejected" },
    });
    priceLookup.mockRestore();

    const retry = await h.orchestrator.retryFailedAsync({
      ownerId: OWNER,
      caseId: CASE_ID,
      priorRunId: run.id,
    });
    expect(retry.priorRunId).toBe(run.id);
    expect(retry.usage.costUsd).toBe(0);
    expect(retry.terminalEvent).toBeUndefined();
    expect((await h.worker.runOnceAsync())?.run?.status).toBe("completed");
    expect(provider.calls).toEqual(["coordinator", "a", "b"]);
    expect(
      (await store.repositories.runs.findOwnedById(run.id, OWNER))?.status,
    ).toBe("failed");
    expect(await caseUsage()).toEqual(summarizeUsage(await ledger()));
  });

  it("plans multi-agent cases with the coordinator and counts planning usage", async () => {
    const provider = new ScriptedProvider({
      ...routes("a", "b"),
      coordinator: () => ({
        tasks: [
          {
            key: "a",
            assignedRole: "analyst",
            dependsOn: [],
            instructions: "Adapted a",
          },
          {
            key: "b",
            assignedRole: "analyst",
            dependsOn: ["a"],
            instructions: "Adapted b",
          },
          {
            key: "review",
            assignedRole: "independent-reviewer",
            dependsOn: ["a", "b"],
            instructions: "Review",
          },
        ],
      }),
    });
    const h = harness({
      provider,
      coordinator: true,
      plan: planOf([
        { key: "a" },
        { key: "b" },
        { key: "review", role: "independent-reviewer", dependsOn: ["a", "b"] },
      ]),
    });
    const { run, result } = await startRunAsync(h);

    expect(result?.run?.status).toBe("completed");
    expect(provider.calls).toEqual(["coordinator", "a", "b", "review"]);
    const tasks = await tasksOf(run.id);
    expect(tasks.b.dependencyIds).toEqual([`${run.id}:a`]);
    expect(
      (provider.inputs.get("b")![0] as { task: { instructions: string } }).task
        .instructions,
    ).toBe("Adapted b");
    const entries = await ledger();
    expect(entries.filter((entry) => entry.taskId === null)).toHaveLength(1);
    expect(result?.run?.usage).toEqual(summarizeUsage(entries));
    expect(await caseUsage()).toEqual(summarizeUsage(entries));
  });

  it("falls back to the reference plan when the coordinator returns a cycle", async () => {
    const provider = new ScriptedProvider({
      ...routes("a", "b"),
      coordinator: () => ({
        tasks: [
          {
            key: "a",
            assignedRole: "analyst",
            dependsOn: ["b"],
            instructions: "x",
          },
          {
            key: "b",
            assignedRole: "analyst",
            dependsOn: ["a"],
            instructions: "y",
          },
        ],
      }),
    });
    const h = harness({
      provider,
      coordinator: true,
      reviewer: false,
      plan: planOf([{ key: "a" }, { key: "b" }]),
    });
    const { run, result } = await startRunAsync(h);
    expect(result?.run?.status).toBe("completed");
    const tasks = await tasksOf(run.id);
    expect(tasks.a.dependencyIds).toEqual([]);
  });

  describe("worker restarts", () => {
    class Crash extends Error {}

    it("replays a failure event after a crash following the task status write", async () => {
      const clock = new Clock();
      const provider = new ScriptedProvider({
        a: () => {
          throw new StoreError("Failed", "test-failure");
        },
      });
      const h = harness({
        clock,
        provider,
        reviewer: false,
        plan: planOf([{ key: "a" }]),
      });
      const replace = store.repositories.tasks.replaceOwned.bind(
        store.repositories.tasks,
      );
      const spy = vi
        .spyOn(store.repositories.tasks, "replaceOwned")
        .mockImplementation(async (...args) => {
          const saved = await replace(...args);
          if (args[0].status === "failed")
            throw new Crash("worker died after failed task");
          return saved;
        });
      const run = await h.orchestrator.createRunAsync({
        ownerId: OWNER,
        caseId: CASE_ID,
      });
      await expect(h.worker.runOnceAsync()).rejects.toBeInstanceOf(Crash);
      spy.mockRestore();
      clock.advance(LEASE_TTL_SECONDS + 1);
      expect((await h.worker.runOnceAsync())?.run?.status).toBe("failed");
      expect(provider.count("a")).toBe(1);
      expect(
        (await eventsOf(run.id)).filter(
          (event) => event.payload.type === "task-failed",
        ),
      ).toHaveLength(1);
    });

    it("keeps the complete adapted plan before a checkpoint and across retries", async () => {
      const clock = new Clock();
      let fail = true;
      const provider = new ScriptedProvider({
        ...routes("a", "extra"),
        b: () => {
          if (fail) {
            fail = false;
            throw new StoreError("Unavailable", "test-failure");
          }
          return specialistOutput("b");
        },
        coordinator: () => ({
          tasks: [
            {
              key: "a",
              assignedRole: "analyst",
              dependsOn: [],
              instructions: "Adapted a",
            },
            {
              key: "b",
              assignedRole: "analyst",
              dependsOn: ["a"],
              instructions: "Adapted b",
            },
            {
              key: "extra",
              assignedRole: "analyst",
              dependsOn: ["b"],
              instructions: "Added task instructions",
            },
          ],
        }),
      });
      const plan = planOf([{ key: "a" }, { key: "b", dependsOn: ["a"] }]);
      const h = harness({
        clock,
        provider,
        plan,
        coordinator: true,
        reviewer: false,
      });
      const insert = store.repositories.tasks.insertPlan.bind(
        store.repositories.tasks,
      );
      vi.spyOn(store.repositories.tasks, "insertPlan").mockImplementationOnce(
        async (...args) => {
          await insert(...args);
          throw new WorkerAbortedError();
        },
      );
      const run = await h.orchestrator.createRunAsync({
        ownerId: OWNER,
        caseId: CASE_ID,
      });
      expect((await h.worker.runOnceAsync())?.outcome).toBe("aborted");
      expect(Object.keys(await tasksOf(run.id))).toHaveLength(3);
      clock.advance(LEASE_TTL_SECONDS + 1);
      expect((await h.worker.runOnceAsync())?.run?.status).toBe(
        "partially-completed",
      );
      const retry = await h.orchestrator.retryFailedAsync({
        ownerId: OWNER,
        caseId: CASE_ID,
        priorRunId: run.id,
      });
      expect(Object.keys(await tasksOf(retry.id))).toHaveLength(3);
      expect((await h.worker.runOnceAsync())?.run?.status).toBe("completed");
      expect(provider.count("coordinator")).toBe(1);
      expect(provider.inputs.get("b")!.at(-1)?.task).toMatchObject({
        instructions: "Adapted b",
      });
      expect(provider.inputs.get("extra")![0].task).toMatchObject({
        instructions: "Added task instructions",
      });
    });

    it("does not publish any result after another generation reclaims the lease", async () => {
      const clock = new Clock();
      const provider = new ScriptedProvider(routes("a"));
      const plan = planOf([{ key: "a" }]);
      const next = harness({ clock, provider, plan, reviewer: false });
      const h = harness({
        clock,
        provider,
        plan,
        reviewer: false,
        hooks: {
          afterAgentCall: async (task) => {
            clock.advance(LEASE_TTL_SECONDS + 1);
            const current = (await store.repositories.runs.findOwnedById(
              task.runId,
              OWNER,
            ))!;
            await next.orchestrator.acquireAsync(current, "replacement-worker");
          },
        },
      });
      const { run, result } = await startRunAsync(h);
      expect(result?.outcome).toBe("aborted");
      expect(await store.repositories.findings.listForCase(scope)).toEqual([]);
      expect(await store.repositories.evidence.listForCase(scope)).toEqual([]);
      expect(
        await store.repositories.deliverables.findOwnedById(
          deliverableIdFor(run.id),
          scope,
        ),
      ).toBeNull();
    });

    async function crashAndRecoverAsync(boundary: keyof OrchestratorHooks) {
      const checkpointer = new MemorySaver();
      const clock = new Clock();
      const provider = new ScriptedProvider(routes("a", "b"));
      const plan = planOf([{ key: "a" }, { key: "b", dependsOn: ["a"] }]);
      let crashed = false;
      const first = harness({
        provider,
        plan,
        clock,
        checkpointer,
        reviewer: false,
        hooks: {
          [boundary]: (task: { id: string }) => {
            if (!crashed && task.id.endsWith(":a")) {
              crashed = true;
              throw new Crash("worker died");
            }
          },
        },
      });
      const run = await first.orchestrator.createRunAsync({
        ownerId: OWNER,
        caseId: CASE_ID,
      });
      await expect(first.worker.runOnceAsync()).rejects.toBeInstanceOf(Crash);

      // The lease still belongs to the dead worker until it expires.
      const second = harness({
        provider,
        plan,
        clock,
        checkpointer,
        reviewer: false,
      });
      expect(await second.worker.runOnceAsync()).toBeNull();
      clock.advance(LEASE_TTL_SECONDS + 1);
      const recovered = await second.worker.runOnceAsync();
      await expectConsistentEvents();
      const findings = await store.repositories.findings.listForCase(scope);
      expect(new Set(findings.map((item) => item.id)).size).toBe(
        findings.length,
      );
      return { run, recovered, provider, tasks: await tasksOf(run.id) };
    }

    it("re-dispatches work that never reached the provider", async () => {
      const { recovered, provider, tasks } =
        await crashAndRecoverAsync("beforeAgentCall");
      expect(recovered?.run?.status).toBe("completed");
      expect(provider.count("a")).toBe(1);
      expect(tasks.a.attemptCount).toBe(1);
    });

    it("marks a dispatched call without a durable result as interrupted", async () => {
      const { recovered, provider, tasks } =
        await crashAndRecoverAsync("afterAgentCall");
      expect(provider.count("a")).toBe(1);
      expect(tasks.a.status).toBe("failed");
      expect(tasks.a.lastError?.code).toBe("attempt-interrupted");
      expect(tasks.a.usage.totalUnits).toBe(500);
      expect(tasks.b.status).toBe("skipped");
      expect(recovered?.run?.status).toBe("failed");
    });

    it("reconciles committed results without repeating paid work", async () => {
      const { recovered, provider, tasks, run } =
        await crashAndRecoverAsync("afterResultCommit");
      expect(recovered?.run?.status).toBe("completed");
      expect(provider.count("a")).toBe(1);
      expect(tasks.a.status).toBe("completed");
      const entries = await ledger();
      expect(entries).toHaveLength(2);
      expect(
        (await eventsOf(run.id)).filter(
          (event) => event.payload.type === "finding-added",
        ),
      ).toHaveLength(2);
    });

    it("resumes from the checkpoint after a committed task", async () => {
      const { recovered, provider, run } =
        await crashAndRecoverAsync("afterTaskCommit");
      expect(recovered?.run?.status).toBe("completed");
      expect(provider.calls).toEqual(["a", "b"]);
      expect(
        (await eventsOf(run.id)).filter(
          (event) =>
            event.payload.type === "task-completed" &&
            event.payload.taskId === `${run.id}:a`,
        ),
      ).toHaveLength(1);
      expect(
        (await eventsOf(run.id)).filter(
          (event) => event.id === `${run.id}:a:cost:1`,
        ),
      ).toHaveLength(1);
    });

    it("reconciles an abandoned cancellation without model calls", async () => {
      const clock = new Clock();
      const provider = new ScriptedProvider(routes("a"));
      const h = harness({
        clock,
        provider,
        reviewer: false,
        plan: planOf([{ key: "a" }]),
      });
      const run = await h.orchestrator.createRunAsync({
        ownerId: OWNER,
        caseId: CASE_ID,
      });
      await h.orchestrator.acquireAsync(run, "remote-worker");
      const cancelling = await h.orchestrator.cancelRunAsync({
        ownerId: OWNER,
        runId: run.id,
      });
      expect(cancelling.status).toBe("running");
      clock.advance(LEASE_TTL_SECONDS + 1);
      expect((await h.worker.runOnceAsync())?.run?.status).toBe("cancelled");
      expect(provider.calls).toEqual([]);
      expect((await eventsOf(run.id)).at(-1)?.payload.type).toBe(
        "run-cancelled",
      );
    });

    it("recovers a terminal event after a crash following atomic finalization", async () => {
      const provider = new ScriptedProvider(routes("a"));
      const h = harness({
        provider,
        reviewer: false,
        plan: planOf([{ key: "a" }]),
      });
      const emit = store.repositories.events.append.bind(
        store.repositories.events,
      );
      const spy = vi
        .spyOn(store.repositories.events, "append")
        .mockImplementation(async (event, scope, options) => {
          if (event.payload.type === "run-completed")
            throw new Crash("worker died before terminal event");
          return emit(event, scope, options);
        });
      const run = await h.orchestrator.createRunAsync({
        ownerId: OWNER,
        caseId: CASE_ID,
      });
      await expect(h.worker.runOnceAsync()).rejects.toBeInstanceOf(Crash);
      expect(
        await store.repositories.runs.findOwnedById(run.id, OWNER),
      ).toMatchObject({
        status: "completed",
        terminalEvent: { pending: true },
      });
      spy.mockRestore();
      await h.worker.runOnceAsync();
      expect(
        (await eventsOf(run.id)).filter(
          (event) => event.payload.type === "run-completed",
        ),
      ).toHaveLength(1);
      expect(await h.worker.runOnceAsync()).toBeNull();
      expect(provider.calls).toEqual(["a"]);
    });

    it("retains unknown billed exposure when recovering an admitted orphan", async () => {
      const clock = new Clock();
      const provider = new ScriptedProvider(routes("a", "b"));
      const reserve = vi.spyOn(store.repositories.usageAdmission, "reserve");
      const plan = planOf([{ key: "a" }, { key: "b", dependsOn: ["a"] }]);
      const h = harness({
        clock,
        provider,
        plan,
        reviewer: false,
        hooks: {
          beforeAgentCall: async (task) => {
            if (!task.id.endsWith(":b")) return;
            const admitted = reserve.mock.calls[0][0];
            await store.repositories.usageAdmission.reserve({
              ...admitted,
              attemptId: "orphan-attempt",
              idempotencyKey: "orphan-attempt",
              taskId: task.id,
            });
            throw new Crash("worker died in provider");
          },
        },
      });
      const run = await h.orchestrator.createRunAsync({
        ownerId: OWNER,
        caseId: CASE_ID,
      });
      await expect(h.worker.runOnceAsync()).rejects.toBeInstanceOf(Crash);
      expect(summarizeUsage(await ledger()).costStatus).toBe("unknown");
      clock.advance(LEASE_TTL_SECONDS + 1);
      const next = harness({
        clock,
        provider,
        plan,
        reviewer: false,
        checkpointer: h.checkpointer,
      });
      const result = await next.worker.runOnceAsync();
      const entries = await ledger();
      expect(
        entries.find((entry) => entry.attemptId === "orphan-attempt"),
      ).toMatchObject({
        outcome: "unknown",
        reservationStatus: "reserved",
        costStatus: "unknown",
      });
      expect((await tasksOf(run.id)).b.usage).toMatchObject({
        costStatus: "unknown",
        costUsd: null,
        totalUnits: null,
      });
      expect(result?.run?.usage.costStatus).toBe("unknown");
      expect((await caseUsage()).costStatus).toBe("unknown");
      expect(provider.calls).toEqual(["a"]);
    });

    it("fails safely when the checkpoint graph version changed", async () => {
      const checkpointer = new MemorySaver();
      const clock = new Clock();
      const provider = new ScriptedProvider(routes("a", "b"));
      const plan = planOf([{ key: "a" }, { key: "b", dependsOn: ["a"] }]);
      const first = harness({
        provider,
        plan,
        clock,
        checkpointer,
        reviewer: false,
        hooks: {
          afterTaskCommit: (task) => {
            if (task.id.endsWith(":b")) throw new Crash("worker died");
          },
        },
      });
      const run = await first.orchestrator.createRunAsync({
        ownerId: OWNER,
        caseId: CASE_ID,
      });
      await expect(first.worker.runOnceAsync()).rejects.toBeInstanceOf(Crash);
      clock.advance(LEASE_TTL_SECONDS + 1);
      const second = harness({
        provider,
        plan,
        clock,
        checkpointer,
        reviewer: false,
        graphVersion: "task-dag/2",
      });
      const result = await second.worker.runOnceAsync();
      expect(result?.run?.status).toBe("failed");
      const failed = (await eventsOf(run.id)).find(
        (event) => event.payload.type === "run-failed",
      );
      expect(failed?.payload).toMatchObject({
        error: { code: "graph-version-mismatch" },
      });
      expect((await tasksOf(run.id)).a.status).toBe("completed");
      expect(provider.calls).toEqual(["a", "b"]);
    });
  });

  it("fences a stale worker after its lease is reclaimed", async () => {
    const clock = new Clock();
    const provider = new ScriptedProvider(routes("a"));
    let reclaimed: Awaited<
      ReturnType<typeof h.orchestrator.acquireAsync>
    > | null = null;
    const h = harness({
      provider,
      clock,
      reviewer: false,
      plan: planOf([{ key: "a" }]),
      hooks: {
        beforeAgentCall: async () => {
          if (reclaimed) return;
          clock.advance(LEASE_TTL_SECONDS + 1);
          const run = (
            await store.repositories.runs.listClaimable(
              clock.now().toISOString(),
            )
          )[0];
          reclaimed = await h.orchestrator.acquireAsync(run, "worker-b");
        },
      },
    });
    const { run, result } = await startRunAsync(h);

    expect(result?.outcome).toBe("aborted");
    expect(provider.calls).toEqual([]);
    expect(await store.repositories.findings.listForCase(scope)).toEqual([]);
    expect((await tasksOf(run.id)).a.status).toBe("running");

    const resumed = await h.orchestrator.executeClaimedRunAsync(
      run.id,
      OWNER,
      reclaimed!,
    );
    expect(resumed.run?.status).toBe("completed");
    expect(provider.calls).toEqual(["a"]);
    await expectConsistentEvents();
  });

  it("admits one active run per case and one worker per run", async () => {
    const provider = new ScriptedProvider(routes("a"), 5);
    const h = harness({
      provider,
      reviewer: false,
      plan: planOf([{ key: "a" }]),
    });
    const other = harness({
      provider,
      reviewer: false,
      plan: planOf([{ key: "a" }]),
    });
    await h.orchestrator.createRunAsync({ ownerId: OWNER, caseId: CASE_ID });
    await expect(
      h.orchestrator.createRunAsync({ ownerId: OWNER, caseId: CASE_ID }),
    ).rejects.toBeInstanceOf(RunConflictError);
    await expect(
      h.orchestrator.createRunAsync({ ownerId: "user-2", caseId: CASE_ID }),
    ).rejects.toBeInstanceOf(RunNotFoundError);

    const results = await Promise.all([
      h.worker.runOnceAsync(),
      other.worker.runOnceAsync(),
    ]);
    expect(results.filter((item) => item !== null)).toHaveLength(1);
    expect(provider.calls).toEqual(["a"]);
  });

  it("stops new work at the spend limit and preserves partial results", async () => {
    const provider = new ScriptedProvider(routes("a", "b", "c"));
    let reserves = 0;
    const h = harness({
      provider,
      reviewer: false,
      maxBranchConcurrency: 1,
      plan: planOf([
        { key: "a" },
        { key: "b", dependsOn: ["a"] },
        { key: "c", dependsOn: ["b"] },
      ]),
      admission: (port) =>
        Object.assign(Object.create(port) as typeof port, {
          reserve: async (request: Parameters<typeof port.reserve>[0]) => {
            reserves += 1;
            if (reserves > 1) {
              throw new StoreError(
                "User spend limit exceeded",
                "spend-limit-exceeded",
              );
            }
            return port.reserve(request);
          },
        }),
    });
    const { run, result } = await startRunAsync(h);

    expect(result?.run?.status).toBe("limit-reached");
    const tasks = await tasksOf(run.id);
    expect(tasks.a.status).toBe("completed");
    expect(tasks.b.status).toBe("limit-reached");
    expect(["limit-reached", "skipped"]).toContain(tasks.c.status);
    expect(provider.calls).toEqual(["a"]);
    expect(await store.repositories.findings.listForCase(scope)).toHaveLength(
      1,
    );
    const limitEvents = (await eventsOf(run.id)).filter(
      (event) => event.payload.type === "limit-reached",
    );
    expect(limitEvents).toHaveLength(1);
    const entries = await ledger();
    expect(
      entries.every((entry) => entry.reservationStatus !== "reserved"),
    ).toBe(true);
  });

  it("cancels an executing run and keeps completed work", async () => {
    const provider = new ScriptedProvider(routes("a", "b"));
    let runId = "";
    const h = harness({
      provider,
      reviewer: false,
      plan: planOf([{ key: "a" }, { key: "b", dependsOn: ["a"] }]),
      hooks: {
        beforeAgentCall: async (task) => {
          if (task.id.endsWith(":b")) {
            await h.orchestrator.cancelRunAsync({
              ownerId: OWNER,
              runId,
              reason: "stop",
            });
          }
        },
      },
    });
    const run = await h.orchestrator.createRunAsync({
      ownerId: OWNER,
      caseId: CASE_ID,
    });
    runId = run.id;
    const result = await h.worker.runOnceAsync();

    expect(result?.run?.status).toBe("cancelled");
    expect(result?.run?.cancellationRequested).toBe(true);
    const tasks = await tasksOf(run.id);
    expect(tasks.a.status).toBe("completed");
    expect(tasks.b.status).toBe("cancelled");
    expect(provider.calls).toEqual(["a"]);
    expect((await eventsOf(run.id)).at(-1)?.payload.type).toBe("run-cancelled");
    expect(await store.repositories.findings.listForCase(scope)).toHaveLength(
      1,
    );
  });

  it("honors a cancellation racing the last task result", async () => {
    const provider = new ScriptedProvider(routes("a"));
    const h = harness({
      provider,
      reviewer: false,
      plan: planOf([{ key: "a" }]),
      hooks: {
        afterTaskCommit: async (task) => {
          await h.orchestrator.cancelRunAsync({
            ownerId: OWNER,
            runId: task.runId,
          });
        },
      },
    });
    const { run, result } = await startRunAsync(h);
    expect(result?.run?.status).toBe("cancelled");
    const terminal = (await eventsOf(run.id)).filter((event) =>
      ["run-completed", "run-cancelled"].includes(event.payload.type),
    );
    expect(terminal.map((event) => event.payload.type)).toEqual([
      "run-cancelled",
    ]);
  });

  it("rechecks the spend stop after waiting for a branch permit", async () => {
    const provider = new ScriptedProvider(routes("a", "b", "c"));
    let reservations = 0;
    const h = harness({
      provider,
      reviewer: false,
      maxBranchConcurrency: 1,
      plan: planOf([{ key: "a" }, { key: "b" }, { key: "c" }]),
      admission: (port) => ({
        reserve: async () => {
          reservations++;
          throw new StoreError("Run limit reached", "spend-limit-exceeded");
        },
        settle: (request) => port.settle(request),
        release: (id, reason) => port.release(id, reason),
      }),
    });

    const { result } = await startRunAsync(h);
    expect(result?.run?.status).toBe("limit-reached");
    expect(reservations).toBe(1);
    expect(provider.calls).toEqual([]);
  });

  it("cancels a queued run without a worker", async () => {
    const h = harness({
      provider: new ScriptedProvider(routes("a")),
      reviewer: false,
      plan: planOf([{ key: "a" }]),
    });
    const run = await h.orchestrator.createRunAsync({
      ownerId: OWNER,
      caseId: CASE_ID,
    });
    await expect(
      h.orchestrator.cancelRunAsync({ ownerId: "user-2", runId: run.id }),
    ).rejects.toBeInstanceOf(RunNotFoundError);
    const cancelled = await h.orchestrator.cancelRunAsync({
      ownerId: OWNER,
      runId: run.id,
    });
    expect(cancelled.status).toBe("cancelled");
    expect(await h.worker.runOnceAsync()).toBeNull();
  });

  describe("human input", () => {
    it("recovers before dispatch after output correction and asks the next question", async () => {
      let first = true;
      const provider = new ScriptedProvider({
        a: (input) => {
          if (first) {
            first = false;
            return { invalid: true };
          }
          const answer = input.humanInput as Record<string, unknown> | null;
          if (answer?.currency) return specialistOutput("a");
          return {
            ...specialistOutput("a"),
            inputRequired: {
              questions: [
                {
                  text: answer?.year ? "Currency?" : "Year?",
                  severity: "high",
                },
              ],
            },
          };
        },
      });
      const plan = planOf([{ key: "a" }]);
      const h = harness({
        provider,
        plan,
        reviewer: false,
        hooks: {
          beforeAgentCall: (task) => {
            if (task.attemptCount === 2) throw new Error("worker died");
          },
        },
      });
      const { run } = await startRunAsync(h);
      expect(provider.count("a")).toBe(2);
      await expect(
        h.orchestrator.resumeRunAsync({
          ownerId: OWNER,
          runId: run.id,
          request: { idempotencyKey: "year-answer", input: { year: 2026 } },
        }),
      ).rejects.toThrow("worker died");
      h.clock.advance(LEASE_TTL_SECONDS + 1);
      const recovered = harness({
        provider,
        plan,
        reviewer: false,
        clock: h.clock,
        checkpointer: h.checkpointer,
      });
      const resumed = await recovered.worker.runOnceAsync();
      expect((await tasksOf(run.id)).a.lastError).toBeNull();
      expect(resumed?.run?.status).toBe("waiting-for-input");
      expect(provider.count("a")).toBe(3);
      const done = await recovered.orchestrator.resumeRunAsync({
        ownerId: OWNER,
        runId: run.id,
        request: {
          idempotencyKey: "currency-answer",
          input: { currency: "INR" },
        },
      });
      expect(done.run?.status).toBe("completed");
      expect(provider.inputs.get("a")!.at(-1)!.humanInput).toEqual({
        year: 2026,
        currency: "INR",
      });
    });

    it("recovers a resumed call that crashed before dispatch with its saved answer", async () => {
      const clock = new Clock();
      const provider = new ScriptedProvider({
        a: (input) =>
          input.humanInput
            ? specialistOutput("a")
            : {
                ...specialistOutput("a"),
                inputRequired: {
                  questions: [{ text: "Year?", severity: "high" }],
                },
              },
      });
      const plan = planOf([{ key: "a" }]);
      const h = harness({
        clock,
        provider,
        plan,
        reviewer: false,
        hooks: {
          beforeAgentCall: (task) => {
            if (task.attemptCount === 2)
              throw new Error("worker died before resumed dispatch");
          },
        },
      });
      const { run } = await startRunAsync(h);
      await expect(
        h.orchestrator.resumeRunAsync({
          ownerId: OWNER,
          runId: run.id,
          request: { idempotencyKey: "saved-answer", input: { year: 2026 } },
        }),
      ).rejects.toThrow("worker died");
      expect(provider.count("a")).toBe(1);
      expect((await tasksOf(run.id)).a.attemptCount).toBe(2);
      clock.advance(LEASE_TTL_SECONDS + 1);
      const recovered = harness({
        clock,
        provider,
        plan,
        reviewer: false,
        checkpointer: h.checkpointer,
      });
      expect((await recovered.worker.runOnceAsync())?.run?.status).toBe(
        "completed",
      );
      expect(provider.inputs.get("a")![1].humanInput).toEqual({ year: 2026 });
      expect(provider.count("a")).toBe(2);
    });

    it("cancels a waiting run even when all execution slots are occupied", async () => {
      const provider = new ScriptedProvider({
        a: () => ({
          ...specialistOutput("a"),
          inputRequired: { questions: [{ text: "Year?", severity: "high" }] },
        }),
      });
      const h = harness({
        provider,
        reviewer: false,
        plan: planOf([{ key: "a" }]),
      });
      const { run } = await startRunAsync(h);
      for (const id of ["case-2", "case-3"]) {
        await store.repositories.cases.insert(makeCase(id));
        const other = await h.orchestrator.createRunAsync({
          ownerId: OWNER,
          caseId: id,
        });
        await h.orchestrator.acquireAsync(other, `lease:${id}`);
      }
      expect(
        (await h.orchestrator.cancelRunAsync({ ownerId: OWNER, runId: run.id }))
          .status,
      ).toBe("cancelled");
      expect(provider.count("a")).toBe(1);
    });

    it("supports repeated input rounds without replaying consumed answers", async () => {
      const provider = new ScriptedProvider({
        a: (input) => {
          const answer = input.humanInput as Record<string, unknown> | null;
          if (answer?.currency) return specialistOutput("a");
          return {
            ...specialistOutput("a"),
            findings: [],
            inputRequired: {
              questions: [
                {
                  text: answer?.fiscalYear
                    ? "Which currency?"
                    : "Which fiscal year?",
                  severity: "high",
                },
              ],
            },
          };
        },
      });
      const h = harness({
        provider,
        reviewer: false,
        plan: planOf([{ key: "a" }]),
      });
      const { run } = await startRunAsync(h);
      const firstRequest = {
        idempotencyKey: "fiscal-year-key",
        input: { fiscalYear: 2025 },
      };
      const first = await h.orchestrator.resumeRunAsync({
        ownerId: OWNER,
        runId: run.id,
        request: firstRequest,
      });
      expect(first.run?.status).toBe("waiting-for-input");
      const latest = (await eventsOf(run.id))
        .filter((event) => event.payload.type === "input-required")
        .at(-1)!;
      expect(latest.payload).toMatchObject({
        questionIds: [`${run.id}:a:input:2:q0`],
      });
      const findings = await store.repositories.findings.listForCase(scope);
      expect(
        findings.find((finding) => finding.id === `${run.id}:a:input:2`)
          ?.openQuestions[0].text,
      ).toBe("Which currency?");
      await h.orchestrator.resumeRunAsync({
        ownerId: OWNER,
        runId: run.id,
        request: firstRequest,
      });
      expect(provider.count("a")).toBe(2);
      const done = await h.orchestrator.resumeRunAsync({
        ownerId: OWNER,
        runId: run.id,
        request: { idempotencyKey: "currency-key", input: { currency: "INR" } },
      });
      expect(done.run?.status).toBe("completed");
      expect(provider.count("a")).toBe(3);
      expect((await tasksOf(run.id)).a.attemptCount).toBe(3);
      expect(provider.inputs.get("a")!.at(-1)!.humanInput).toEqual({
        fiscalYear: 2025,
        currency: "INR",
      });
    });

    it("does not apply an earlier key to a later waiting task", async () => {
      const ask = (key: string) => (input: Record<string, unknown>) =>
        input.humanInput
          ? specialistOutput(key)
          : {
              ...specialistOutput(key),
              findings: [],
              inputRequired: {
                questions: [{ text: `Answer ${key}`, severity: "high" }],
              },
            };
      const provider = new ScriptedProvider({ a: ask("a"), b: ask("b") });
      const h = harness({
        provider,
        reviewer: false,
        plan: planOf([{ key: "a" }, { key: "b", dependsOn: ["a"] }]),
      });
      const { run } = await startRunAsync(h);
      const request = { idempotencyKey: "answer-a-key", input: { value: "A" } };
      expect(
        (
          await h.orchestrator.resumeRunAsync({
            ownerId: OWNER,
            runId: run.id,
            request,
          })
        ).run?.status,
      ).toBe("waiting-for-input");
      await h.orchestrator.resumeRunAsync({
        ownerId: OWNER,
        runId: run.id,
        request,
      });
      expect(provider.count("b")).toBe(1);
      expect(
        (
          await h.orchestrator.resumeRunAsync({
            ownerId: OWNER,
            runId: run.id,
            request: { idempotencyKey: "answer-b-key", input: { value: "B" } },
          })
        ).run?.status,
      ).toBe("completed");
      expect(provider.inputs.get("b")![1].humanInput).toEqual({ value: "B" });
    });

    function inputHarness() {
      const provider = new ScriptedProvider({
        review: () => reviewOutput,
        a: (input) =>
          input.humanInput
            ? specialistOutput("a")
            : {
                ...specialistOutput("a"),
                findings: [],
                inputRequired: {
                  questions: [{ text: "Which fiscal year?", severity: "high" }],
                },
              },
      });
      const h = harness({
        provider,
        reviewer: false,
        plan: planOf([{ key: "a" }]),
      });
      return { provider, h };
    }

    it("suspends without a lease and resumes only for the owner", async () => {
      const { provider, h } = inputHarness();
      const { run, result } = await startRunAsync(h);

      expect(result?.outcome).toBe("waiting-for-input");
      expect(result?.run).toMatchObject({
        status: "waiting-for-input",
        inputRequired: true,
        leaseId: null,
      });
      const required = (await eventsOf(run.id)).find(
        (event) => event.payload.type === "input-required",
      );
      expect(required?.payload).toEqual({
        type: "input-required",
        questionIds: [`${run.id}:a:input:1:q0`],
      });
      await expect(
        h.orchestrator.createRunAsync({ ownerId: OWNER, caseId: CASE_ID }),
      ).rejects.toBeInstanceOf(RunConflictError);
      expect(await h.worker.runOnceAsync()).toBeNull();

      const request = {
        idempotencyKey: "resume-key-1",
        input: { fiscalYear: 2025 },
      };
      await expect(
        h.orchestrator.resumeRunAsync({
          ownerId: "user-2",
          runId: run.id,
          request,
        }),
      ).rejects.toBeInstanceOf(RunNotFoundError);
      await expect(
        h.orchestrator.resumeRunAsync({
          ownerId: OWNER,
          runId: run.id,
          request: { idempotencyKey: "x", input: {} },
        }),
      ).rejects.toThrow();

      const resumed = await h.orchestrator.resumeRunAsync({
        ownerId: OWNER,
        runId: run.id,
        request,
      });
      expect(resumed.run?.status).toBe("completed");
      expect(provider.count("a")).toBe(2);
      expect(provider.inputs.get("a")![1].humanInput).toEqual({
        fiscalYear: 2025,
      });

      const replay = await h.orchestrator.resumeRunAsync({
        ownerId: OWNER,
        runId: run.id,
        request,
      });
      expect(replay.run?.status).toBe("completed");
      expect(provider.count("a")).toBe(2);
      await expect(
        h.orchestrator.resumeRunAsync({
          ownerId: OWNER,
          runId: run.id,
          request: { ...request, idempotencyKey: "resume-key-2" },
        }),
      ).rejects.toBeInstanceOf(RunConflictError);
      await expectConsistentEvents();
    });

    it("cancels a run that is waiting for input", async () => {
      const { h } = inputHarness();
      const { run } = await startRunAsync(h);
      const cancelled = await h.orchestrator.cancelRunAsync({
        ownerId: OWNER,
        runId: run.id,
      });
      expect(cancelled.status).toBe("cancelled");
      expect(cancelled.leaseId).toBeNull();
      expect((await tasksOf(run.id)).a.status).toBe("cancelled");
      const next = await h.orchestrator.createRunAsync({
        ownerId: OWNER,
        caseId: CASE_ID,
      });
      expect(next.status).toBe("queued");
    });
  });
});
