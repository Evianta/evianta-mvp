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
                  document: syntheticWorkflowFixtures.dataAnalysis.documents[0],
                },
        });
      });

      await page.goto("/cases/new");
      await signIn(page);
      await page
        .getByLabel("Case title", { exact: true })
        .fill("Private old title");
      await page
        .getByLabel("What should the review answer?")
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
      await page.getByRole("button", { name: "Create private case" }).click();
      await pendingRequest;
      await page
        .getByRole("button", { name: "Sign out and revoke this session" })
        .click();
      await signIn(page);
      await expect(page.getByLabel("Case title", { exact: true })).toHaveValue(
        "",
      );
      await expect(
        page.getByLabel("What should the review answer?"),
      ).toHaveValue("");
      await expect(
        page.getByRole("list", { name: "Selected documents" }),
      ).toHaveCount(0);
      await page
        .getByLabel("Case title", { exact: true })
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
      await expect(page.getByLabel("Case title", { exact: true })).toHaveValue(
        "New session title",
      );
      await expect(page.getByRole("main").getByRole("alert")).toHaveCount(0);
      await expect(
        page.getByRole("link", { name: "Open created case" }),
      ).toHaveCount(0);
      await expect(
        page.getByRole("button", { name: "Create private case" }),
      ).toBeEnabled();
      expect(uploadCount).toBe(phase === "create" ? 0 : 1);
    });
  }
}

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
        await route.fulfill({ json: { case: record } });
      }
    });
    await page.route("**/cases", async (route) => {
      if (route.request().headers().accept !== "application/json") {
        await route.continue();
        return;
      }
      await route.fulfill({ json: { cases: [record], nextCursor: null } });
    });
    await page.route("**/runs/existing-run/events?*", (route) => {
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
    await expect(page).toHaveURL(/\/cases$/);
    await page.getByRole("link", { name: record.title, exact: true }).click();
    await expect(page.getByRole("button", { name: action })).toBeVisible();
    expect(lookups).toBeGreaterThan(initialLookups);
    if (status === "queued" || status === "running") {
      await expect(
        page.getByRole("list", { name: "Run event timeline" }),
      ).toContainText("A review task started");
      expect(streams).toBeGreaterThanOrEqual(2);
    } else {
      expect(streams).toBe(0);
    }
  });
}
