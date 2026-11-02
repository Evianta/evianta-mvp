import { syntheticWorkflowFixtures, type RunDto } from "@evianta/core";
import { expect, test, type Page } from "@playwright/test";
import { mockApi } from "./support/mock-api";

const record = {
  ...syntheticWorkflowFixtures.dataAnalysis.case,
  id: "private-case",
  ownerId: "owner-1",
  isSample: false,
  synthetic: false,
};

async function mockAuth(page: Page) {
  await page.route("**/intake/configuration", (route) =>
    route.fulfill({
      json: {
        workflows: ["data-analysis"],
        uploadMaxBytes: 25 * 1024 * 1024,
        uploadMaxFiles: 5,
        documentMaxPages: 80,
      },
    }),
  );
  let session = 0;
  await page.route("**/auth/token", (route) =>
    route.fulfill({
      json: {
        accessToken: `session-${++session}`,
        expiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
      },
    }),
  );
  await page.route("**/auth/logout", (route) => route.fulfill({ status: 204 }));
}

async function signIn(page: Page) {
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.getByLabel("Access key").fill("test-key");
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
}

for (const phase of ["create", "upload"] as const) {
  test(`never applies a late ${phase} response to the next session`, async ({
    page,
  }) => {
    await mockAuth(page);
    let release!: () => void;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    let reached!: () => void;
    const pendingRequest = new Promise<void>((resolve) => {
      reached = resolve;
    });
    let uploadCount = 0;
    let runCount = 0;
    await page.route("**/cases", async (route) => {
      if (route.request().resourceType() !== "fetch") {
        await route.continue();
        return;
      }
      if (route.request().method() !== "POST") {
        await route.fulfill({ json: { cases: [], nextCursor: null } });
        return;
      }
      if (phase === "create") {
        reached();
        await released;
      }
      await route.fulfill({ status: 201, json: { case: record } });
    });
    await page.route("**/cases/private-case/documents", async (route) => {
      uploadCount += 1;
      reached();
      await released;
      await route.fulfill({
        status: 201,
        json: {
          documents: [syntheticWorkflowFixtures.dataAnalysis.documents[0]],
        },
      });
    });
    await page.route("**/runs", async (route) => {
      runCount += 1;
      await route.fulfill({ status: 500, json: { error: { message: "no" } } });
    });

    await page.goto("/");
    await signIn(page);
    await page.getByLabel("Attach records").setInputFiles({
      name: "old.csv",
      mimeType: "text/csv",
      buffer: Buffer.from("a,b\n1,2"),
    });
    await page.getByLabel("Message to Evianta").fill("Private old sales notes");
    await page.getByRole("button", { name: "Send message" }).click();
    await pendingRequest;
    await page
      .getByRole("button", { name: "Sign out and revoke this session" })
      .click();
    await signIn(page);
    await expect(
      page.getByRole("heading", { name: "Hi, I am Evianta." }),
    ).toBeVisible();
    await expect(page.getByLabel("Message to Evianta")).toHaveValue("");
    await expect(page.getByText("Private old sales notes")).toHaveCount(0);
    await expect(page.getByRole("list", { name: "Task setup" })).toHaveCount(0);

    const response = page.waitForResponse(
      (candidate) =>
        candidate.request().method() === "POST" &&
        new URL(candidate.url()).pathname ===
          (phase === "create" ? "/cases" : "/cases/private-case/documents"),
    );
    release();
    await (await response).finished();
    await page.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
    );
    await page.waitForTimeout(300);

    await expect(
      page.getByRole("heading", { name: "Hi, I am Evianta." }),
    ).toBeVisible();
    await expect(page.getByRole("log")).toHaveCount(0);
    await expect(page.getByRole("main").getByRole("alert")).toHaveCount(0);
    expect(uploadCount).toBe(phase === "create" ? 0 : 1);
    expect(runCount).toBe(0);
  });
}

test("retrying after a failed upload reuses the same case and skips finished files", async ({
  page,
}) => {
  const state = await mockApi(page, { failUploadOnce: "second.csv" });
  await page.goto("/#access=jury-amber-falcon-47");
  await page.getByLabel("Attach records").setInputFiles(
    ["first.csv", "second.csv"].map((name) => ({
      name,
      mimeType: "text/csv",
      buffer: Buffer.from("month,revenue\nJan,1"),
    })),
  );
  await page.getByLabel("Message to Evianta").fill("Analyze my sales");
  await page.getByRole("button", { name: "Send message" }).click();
  await expect(page.getByText("Temporary upload failure.")).toBeVisible();
  await expect(
    page.getByText("Your case is saved", { exact: false }),
  ).toBeVisible();
  expect(state.created).toHaveLength(1);
  expect(state.uploadAttempts).toEqual(["first.csv", "second.csv"]);

  await page.getByRole("button", { name: "Try again" }).click();
  await expect(page.getByText("Work finished")).toBeVisible();
  expect(state.created).toHaveLength(1);
  expect(state.uploadAttempts).toEqual([
    "first.csv",
    "second.csv",
    "second.csv",
  ]);
  expect(state.runs).toBe(1);
});

for (const status of ["queued", "running", "failed", "none"] as const) {
  test(`restores ${status} run state when reopening a case`, async ({
    page,
  }) => {
    await mockAuth(page);
    const run: RunDto = {
      id: "existing-run",
      caseId: record.id,
      planVersion: 1,
      status: status === "none" ? "queued" : status,
      priorRunId: null,
      cancellationRequested: false,
      inputRequired: false,
      usage: record.usage,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    };
    let lookups = 0;
    let streams = 0;
    await page.route("**/cases/**", async (route) => {
      if (route.request().headers().accept !== "application/json") {
        await route.continue();
        return;
      }
      if (new URL(route.request().url()).pathname.endsWith("/runs/latest")) {
        lookups += 1;
        await route.fulfill({ json: { run: status === "none" ? null : run } });
      } else {
        await route.fulfill({
          json: {
            case: record,
            documents: [],
            runs: [],
            tasks: [],
            findings: [],
            evidence: [],
            deliverables: [],
          },
        });
      }
    });
    await page.route("**/cases", async (route) => {
      if (route.request().headers().accept !== "application/json") {
        await route.continue();
        return;
      }
      await route.fulfill({ json: { cases: [record], nextCursor: null } });
    });
    await page.route("**/cases/private-case/stream?*", (route) => {
      streams += 1;
      return route.fulfill({
        contentType: "text/event-stream",
        body: `data: ${JSON.stringify({
          id: "event-1",
          runId: run.id,
          caseId: record.id,
          sequence: 1,
          occurredAt: record.updatedAt,
          payload: { type: "task-started", taskId: "task-1", role: "analyst" },
        })}\n\n`,
      });
    });
    await page.goto(`/cases/${record.id}`);
    await signIn(page);
    const action =
      status === "none"
        ? "Start analysis"
        : status === "failed"
          ? "Retry analysis"
          : "Cancel run";
    await expect(page.getByRole("button", { name: action })).toBeVisible();
    const initialLookups = lookups;
    await page
      .getByRole("link", { name: "Your cases", exact: true })
      .first()
      .click();
    await expect(page).toHaveURL(/\/cases$/, { timeout: 15000 });
    await page.getByRole("link", { name: record.title, exact: true }).click();
    await expect(page.getByRole("button", { name: action })).toBeVisible();
    expect(lookups).toBeGreaterThan(initialLookups);
    if (status !== "none") {
      await expect(
        page.getByRole("list", { name: "Run event timeline" }),
      ).toContainText("Analyst started");
      expect(streams).toBeGreaterThanOrEqual(2);
    } else {
      expect(streams).toBe(0);
    }
  });
}
