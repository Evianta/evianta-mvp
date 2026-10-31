import { syntheticWorkflowFixtures, type RunDto } from "@evianta/core";
import { expect, test } from "@playwright/test";

const record = {
  ...syntheticWorkflowFixtures.dataAnalysis.case,
  id: "private-case",
  ownerId: "owner-1",
  isSample: false,
  synthetic: false,
};

const completedRun: RunDto = {
  id: "sales-run",
  caseId: record.id,
  planVersion: 1,
  status: "completed",
  priorRunId: null,
  cancellationRequested: false,
  inputRequired: false,
  usage: record.usage,
  createdAt: record.createdAt,
  updatedAt: record.updatedAt,
};

const workspace = {
  case: record,
  documents: [
    {
      id: "sales-document",
      caseId: record.id,
      name: "quarterly-sales.csv",
      mimeType: "text/csv",
      sizeBytes: 120,
      state: "ready" as const,
      uploadedAt: record.createdAt,
      processedAt: record.updatedAt,
    },
  ],
  findings: [],
  evidence: [],
  deliverables: [
    {
      id: "sales-deliverable",
      caseId: record.id,
      runId: completedRun.id,
      version: 1,
      format: "dashboard" as const,
      title: "Sales data analysis",
      summary: "Quarterly sales summary",
      sections: [
        {
          id: "sales-section",
          title: "Sales analysis",
          kind: "text" as const,
          content: {
            taskId: "sales-task",
            summary: "Revenue increased through the quarter.",
            findings: [],
            report: {
              summary:
                "6 row(s) analyzed. Revenue total: 1,000; average: 166.67.",
              interpretation:
                "Monthly revenue increased through the quarter, led by product B.",
              metrics: {
                rowCount: 6,
                valueColumn: "revenue",
                total: 1000,
                average: 1000 / 6,
                periodColumn: "month",
                byPeriod: [
                  { label: "Jan", value: 250, growthPercent: null },
                  { label: "Feb", value: 300, growthPercent: 20 },
                  { label: "Mar", value: 450, growthPercent: 50 },
                ],
                segmentColumn: "product",
                bySegment: [
                  { label: "B", value: 580 },
                  { label: "A", value: 420 },
                ],
                topSegment: { label: "B", value: 580 },
              },
              dataQuality: [],
              assumptions: [],
              openQuestions: [],
            },
            dashboard: {
              charts: [
                {
                  id: "sales-by-period",
                  title: "Revenue by month",
                  type: "bar",
                  categoryKey: "period",
                  valueKey: "revenue",
                  data: [
                    { period: "Jan", revenue: 250 },
                    { period: "Feb", revenue: 300 },
                    { period: "Mar", revenue: 450 },
                    ...Array.from({ length: 202 }, (_, index) => ({
                      period: `Period ${index + 3}`,
                      revenue: index + 3,
                    })),
                  ],
                  source: {
                    documentId: "sales-document",
                    tableId: "sales-table",
                    sheet: "Sales",
                    cellRange: "A1:C7",
                    rowRange: { start: 2, end: 7 },
                  },
                },
              ],
            },
          },
          reviewerContent: null,
          reviewerId: null,
          reviewedAt: null,
          producingRole: "business-data-analyst",
          routingTier: "mid" as const,
          provider: "mock",
          model: "mock-spark",
          findingIds: [],
          evidenceIds: [],
          reviewStatus: "pending" as const,
          reviewComment: null,
        },
      ],
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    },
  ],
};

test.beforeEach(async ({ page }) => {
  await page.route("**/intake/configuration", (route) =>
    route.fulfill({
      json: {
        workflows: ["data-analysis", "msme-payment"],
        uploadMaxBytes: 25 * 1024 * 1024,
        uploadMaxFiles: 5,
        documentMaxPages: 80,
      },
    }),
  );
});

test("shows each supported workflow's file limits in task intake", async ({
  page,
}) => {
  await page.route("**/auth/token", (route) =>
    route.fulfill({
      json: {
        accessToken: "session-token",
        expiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
      },
    }),
  );
  await page.goto("/");
  await page.getByRole("button", { name: "Enter access key" }).click();
  await page.getByLabel("Access key").fill("test-key");
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.getByRole("button", { name: /^Data analysis/ }).click();

  const dropzone = page.locator("#accepted-files");
  await expect(dropzone).toContainText(".csv, .xlsx");
  await expect(dropzone).not.toContainText("PDF files");
  await expect(page.locator("#case-files")).toHaveAttribute(
    "accept",
    ".csv,.xlsx,.pdf,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/pdf",
  );

  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: /^MSME delayed payment/ }).click();
  await expect(dropzone).toContainText(".pdf");
  await expect(page.getByRole("combobox")).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Start task", exact: true }),
  ).toBeEnabled();
  await expect(
    page.getByRole("status").filter({ hasText: "Coming next" }),
  ).toHaveCount(0);
});

test("creates a case with two CSVs without optional supporting documents", async ({
  page,
}) => {
  await page.route("**/auth/token", (route) =>
    route.fulfill({
      json: {
        accessToken: "session-token",
        expiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
      },
    }),
  );
  let created = 0;
  let uploaded = 0;
  let started = 0;
  await page.route("**/runs", async (route) => {
    started += 1;
    await route.fulfill({ json: { run: completedRun } });
  });
  await page.route("**/cases", async (route) => {
    if (route.request().method() !== "POST") {
      await route.continue();
      return;
    }
    expect(route.request().postDataJSON()).toMatchObject({
      title: "Analyze the sales records",
      useCase: "data-analysis",
    });
    created += 1;
    await route.fulfill({ json: { case: record } });
  });
  await page.route("**/cases/private-case/documents", async (route) => {
    uploaded += 1;
    await route.fulfill({ json: { documents: workspace.documents } });
  });
  await page.route("**/cases/private-case", async (route) => {
    if (route.request().headers().accept !== "application/json") {
      await route.continue();
      return;
    }
    await route.fulfill({ json: { ...workspace, deliverables: [] } });
  });
  await page.route("**/cases/private-case/runs/latest", (route) =>
    route.fulfill({ json: { run: null } }),
  );

  await page.goto("/");
  await page.getByRole("button", { name: "Enter access key" }).click();
  await page.getByLabel("Access key").fill("test-key");
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.locator("#case-files").setInputFiles(
    ["messy-sales.csv", "quarterly-sales.csv"].map((name) => ({
      name,
      mimeType: "text/csv",
      buffer: Buffer.from("month,product,revenue\nJan,A,100\n"),
    })),
  );

  const create = page.getByRole("button", { name: "Start task", exact: true });
  await expect(create).toBeDisabled();
  await page
    .getByLabel("Task prompt", { exact: true })
    .fill("Analyze the sales records");
  await expect(
    page.getByText("Recommended documents and optional case details"),
  ).toHaveCount(0);
  await expect(create).toBeEnabled();
  await create.click();
  await expect(page).toHaveURL(/\/cases\/private-case$/, { timeout: 30000 });
  await expect(
    page.getByRole("button", { name: "Start analysis" }),
  ).toBeVisible();
  expect(created).toBe(1);
  expect(uploaded).toBe(2);
  expect(started).toBe(1);
});

test("reopens a completed analysis and renders its report and charts", async ({
  page,
}) => {
  await page.route("**/auth/token", (route) =>
    route.fulfill({
      json: {
        accessToken: "session-token",
        expiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
      },
    }),
  );
  await page.route("**/cases/**", async (route) => {
    const url = new URL(route.request().url());
    if (
      route.request().headers().accept !== "application/json" &&
      !url.pathname.endsWith("/stream")
    ) {
      await route.continue();
      return;
    }
    if (url.pathname.endsWith("/runs/latest")) {
      await route.fulfill({ json: { run: completedRun } });
      return;
    }
    if (url.pathname.endsWith("/stream")) {
      await route.fulfill({
        contentType: "text/event-stream",
        body: `id: 1\nevent: run-completed\ndata: ${JSON.stringify({
          id: "sales-event",
          runId: completedRun.id,
          caseId: record.id,
          sequence: 1,
          occurredAt: record.updatedAt,
          payload: {
            type: "run-completed",
            deliverableIds: ["sales-deliverable"],
          },
        })}\n\n`,
      });
      return;
    }
    await route.fulfill({ json: workspace });
  });

  await page.goto(`/cases/${record.id}`);
  await page.getByRole("button", { name: "Enter access key" }).click();
  await page.getByLabel("Access key").fill("test-key");
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);

  await expect(page.getByText("Revenue total: 1,000")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Dashboard" })).toBeVisible();
  await expect(
    page.getByText("Revenue by month", { exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("table")).toHaveCount(0);
  await page.getByText("View chart data", { exact: true }).click();
  const chartTable = page.getByRole("table").first();
  await expect(chartTable).toContainText("Jan");
  await expect(chartTable).toContainText("250");
  await expect(chartTable.getByRole("row")).toHaveCount(101);
  await expect(page.getByText("Rows 1–100 of 205")).toBeVisible();
  await page.getByRole("button", { name: "Next", exact: true }).click();
  await expect(chartTable.getByRole("row")).toHaveCount(101);
  await expect(chartTable).toContainText("Period 103");
  await expect(page.getByText("Rows 101–200 of 205")).toBeVisible();
  await expect(page.getByText("quarterly-sales.csv")).toBeVisible();
  await expect(page.getByText("rows 2–7")).toBeVisible();
});
