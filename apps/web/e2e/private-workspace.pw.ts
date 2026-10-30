import { syntheticWorkflowFixtures, type RunDto } from "@evianta/core";
import { expect, test, type Page } from "@playwright/test";

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
  for (const outcome of ["success", "failure"] as const) {
    test(`discards late ${phase} ${outcome} after signing into another session`, async ({
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
      await page.route("**/cases", async (route) => {
        if (route.request().method() !== "POST") {
          await route.continue();
          return;
        }
        if (phase === "create") {
          reached();
          await released;
        }
        await route.fulfill({
          status: phase === "create" && outcome === "failure" ? 500 : 200,
          json:
            phase === "create" && outcome === "failure"
              ? { error: { message: "Old session create failed." } }
              : { case: record },
        });
      });
      await page.route("**/cases/private-case/documents", async (route) => {
        uploadCount += 1;
        reached();
        await released;
        await route.fulfill({
          status: outcome === "failure" ? 500 : 200,
          json:
            outcome === "failure"
              ? { error: { message: "Old session upload failed." } }
              : {
                  documents: [
                    syntheticWorkflowFixtures.dataAnalysis.documents[0],
                  ],
                },
        });
      });

      await page.goto("/cases/new");
      await expect(
        page.getByRole("navigation").getByRole("link", { name: "New task" }),
      ).toHaveAttribute("aria-current", "page");
      await expect(
        page.getByRole("link", { name: "Cases", exact: true }),
      ).not.toHaveAttribute("aria-current", "page");
      await signIn(page);
      await page
        .getByText("Recommended documents and optional case details", {
          exact: true,
        })
        .click();
      await page
        .getByLabel("Case title (optional)", { exact: true })
        .fill("Private old title");
      await page
        .getByLabel("Task prompt", { exact: true })
        .fill("Private old notes");
      await page
        .getByLabel("Workflow", { exact: true })
        .selectOption("data-analysis");
      await page.locator("#case-files").setInputFiles([
        {
          name: "old.csv",
          mimeType: "text/csv",
          buffer: Buffer.from("a,b\n1,2"),
        },
        {
          name: "other.csv",
          mimeType: "text/csv",
          buffer: Buffer.from("a,b\n3,4"),
        },
      ]);
      await page
        .getByRole("button", { name: "Start task", exact: true })
        .click();
      await pendingRequest;
      await page
        .getByRole("button", { name: "Sign out and revoke this session" })
        .click();
      await signIn(page);
      await page
        .getByText("Recommended documents and optional case details", {
          exact: true,
        })
        .click();
      await expect(
        page.getByLabel("Case title (optional)", { exact: true }),
      ).toHaveValue("");
      await expect(page.getByLabel("Task prompt", { exact: true })).toHaveValue(
        "",
      );
      await expect(
        page.getByRole("list", { name: "Selected documents" }),
      ).toHaveCount(0);
      await page
        .getByLabel("Case title (optional)", { exact: true })
        .fill("New session title");

      const response = page.waitForResponse(
        (response) =>
          response.request().method() === "POST" &&
          new URL(response.url()).pathname ===
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

      await expect(page).toHaveURL(/\/cases\/new$/);
      await expect(
        page.getByLabel("Case title (optional)", { exact: true }),
      ).toHaveValue("New session title");
      await expect(page.getByRole("main").getByRole("alert")).toHaveCount(0);
      await expect(
        page.getByRole("link", { name: "Open created case" }),
      ).toHaveCount(0);
      await expect(
        page.getByRole("button", { name: "Start task", exact: true }),
      ).toBeDisabled();
      expect(uploadCount).toBe(phase === "create" ? 0 : 1);
    });
  }
}

test("resumes failed uploads in the existing case", async ({ page }) => {
  await mockAuth(page);
  let createCount = 0;
  let uploadCount = 0;
  let releaseFirstUpload!: () => void;
  const firstUploadStarted = new Promise<void>((resolve) => {
    releaseFirstUpload = resolve;
  });
  let finishFirstUpload!: () => void;
  const firstUploadCanFinish = new Promise<void>((resolve) => {
    finishFirstUpload = resolve;
  });
  await page.route("**/cases", async (route) => {
    if (route.request().method() !== "POST") {
      await route.continue();
      return;
    }
    createCount += 1;
    await route.fulfill({ json: { case: record } });
  });
  await page.route("**/cases/private-case/documents", async (route) => {
    uploadCount += 1;
    if (uploadCount === 1) {
      releaseFirstUpload();
      await firstUploadCanFinish;
      await route.fulfill({
        json: {
          documents: [syntheticWorkflowFixtures.dataAnalysis.documents[0]],
        },
      });
      return;
    }
    if (uploadCount === 2) {
      await route.fulfill({
        status: 400,
        json: { error: { message: "Temporary upload failure." } },
      });
      return;
    }
    await route.fulfill({
      json: {
        documents: [syntheticWorkflowFixtures.dataAnalysis.documents[0]],
      },
    });
  });

  await page.goto("/cases/new");
  await signIn(page);
  await page.getByLabel("Task prompt", { exact: true }).fill("Recovery case");
  await page
    .getByLabel("Workflow", { exact: true })
    .selectOption("data-analysis");
  await page.locator("#case-files").setInputFiles([
    {
      name: "first.csv",
      mimeType: "text/csv",
      buffer: Buffer.from("a,b\n1,2"),
    },
    {
      name: "second.csv",
      mimeType: "text/csv",
      buffer: Buffer.from("a,b\n3,4"),
    },
  ]);
  await page.getByRole("button", { name: "Start task", exact: true }).click();
  await firstUploadStarted;
  const firstDocument = page
    .getByRole("listitem")
    .filter({ hasText: "first.csv" });
  const secondDocument = page
    .getByRole("listitem")
    .filter({ hasText: "second.csv" });
  await expect(
    firstDocument.getByRole("button", { name: "Remove first.csv" }),
  ).toBeDisabled();
  await expect(
    secondDocument.getByRole("button", { name: "Remove second.csv" }),
  ).toBeDisabled();
  finishFirstUpload();
  await expect(
    page.getByRole("alert").filter({
      hasText: "Case created.",
    }),
  ).toBeVisible();
  await expect(
    firstDocument.getByRole("button", { name: "Remove first.csv" }),
  ).toBeDisabled();
  await expect(
    secondDocument.getByRole("button", { name: "Remove second.csv" }),
  ).toBeEnabled();
  await page.route("**/cases/private-case", async (route) => {
    if (route.request().headers().accept !== "application/json") {
      await route.continue();
      return;
    }
    await route.fulfill({
      json: {
        case: record,
        documents: [
          {
            ...syntheticWorkflowFixtures.dataAnalysis.documents[0],
            state: "processing",
          },
        ],
        findings: [],
        evidence: [],
        deliverables: [],
      },
    });
  });
  await page
    .getByRole("button", { name: "Retry second.csv", exact: true })
    .click();
  await expect.poll(() => uploadCount).toBe(3);
  await expect(page).toHaveURL(/\/cases\/private-case$/);
  expect(createCount).toBe(1);
  expect(uploadCount).toBe(3);
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
      ).toContainText("A review task started");
      expect(streams).toBeGreaterThanOrEqual(2);
    } else {
      expect(streams).toBe(0);
    }
  });
}
