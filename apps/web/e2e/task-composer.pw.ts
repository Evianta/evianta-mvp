import AxeBuilder from "@axe-core/playwright";
import { syntheticWorkflowFixtures, type RunDto } from "@evianta/core";
import { expect, test, type Page } from "@playwright/test";

const record = {
  ...syntheticWorkflowFixtures.dataAnalysis.case,
  id: "composer-case",
  ownerId: "owner-1",
  isSample: false,
  synthetic: false,
};
const sourceDocument = {
  id: "source-1",
  caseId: record.id,
  name: "sales.csv",
  mimeType: "text/csv",
  sizeBytes: 27,
  state: "ready",
  uploadedAt: record.createdAt,
  processedAt: record.updatedAt,
};
const run: RunDto = {
  id: "composer-run",
  caseId: record.id,
  status: "completed",
  planVersion: 1,
  priorRunId: null,
  cancellationRequested: false,
  inputRequired: false,
  usage: record.usage,
  createdAt: record.createdAt,
  updatedAt: record.updatedAt,
};
const source = {
  name: "sales.csv",
  mimeType: "text/csv",
  buffer: Buffer.from("month,revenue\nJan,100\nFeb,200"),
};
const settings = {
  workflows: ["data-analysis"],
  uploadMaxBytes: 1024,
  uploadMaxFiles: 2,
  documentMaxPages: 20,
};

async function setup(page: Page) {
  const calls = { create: 0, upload: 0, start: 0, input: {} };
  await page.route("**/auth/token", (route) =>
    route.fulfill({
      json: {
        accessToken: "composer-session",
        expiresAt: new Date(Date.now() + 1800000).toISOString(),
      },
    }),
  );
  await page.route("**/auth/logout", (route) => route.fulfill({ status: 204 }));
  await page.route("**/intake/configuration", (route) =>
    route.fulfill({ json: settings }),
  );
  await page.route("**/cases", (route) => {
    if (route.request().headers().accept !== "application/json")
      return route.continue();
    if (route.request().method() === "GET")
      return route.fulfill({ json: { cases: [record], nextCursor: null } });
    calls.create++;
    calls.input = route.request().postDataJSON();
    return route.fulfill({ json: { case: record } });
  });
  await page.route("**/cases/composer-case", (route) =>
    route.request().headers().accept !== "application/json"
      ? route.continue()
      : route.fulfill({
          json: {
            case: record,
            documents: [sourceDocument],
            findings: [],
            evidence: [],
            deliverables: [],
          },
        }),
  );
  await page.route("**/cases/composer-case/documents", (route) => {
    calls.upload++;
    return route.fulfill({ json: { documents: [sourceDocument] } });
  });
  await page.route("**/runs", (route) => {
    calls.start++;
    return route.fulfill({ json: { run } });
  });
  await page.route("**/cases/composer-case/runs/latest", (route) =>
    route.fulfill({ json: { run: calls.start ? run : null } }),
  );
  await page.route("**/cases/composer-case/stream?*", (route) =>
    route.fulfill({ contentType: "text/event-stream", body: "" }),
  );
  return calls;
}

async function signIn(page: Page) {
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.getByLabel("Access key", { exact: true }).fill("test-key");
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.getByLabel("Task prompt", { exact: true })).toBeEnabled();
}

async function prepare(page: Page, path = "/") {
  await page.goto(path);
  await signIn(page);
  await page.getByRole("button", { name: /^Data analysis/ }).click();
  await page.locator("#case-files").setInputFiles(source);
}

test("suggestions are static, preserve selection through sign-in and require confirmation before replacing edits", async ({
  page,
}) => {
  const calls = await setup(page);
  await page.goto("/");
  for (const name of [
    /^Tax notice/,
    /^MSME delayed payment/,
    /^Data analysis/,
  ]) {
    await page.getByRole("button", { name }).click();
  }
  await expect(page.getByLabel("Task prompt", { exact: true })).toHaveValue(
    /Analyze my sales/,
  );
  await expect(page.getByLabel("Task prompt", { exact: true })).toBeDisabled();
  expect(calls).toMatchObject({ create: 0, upload: 0, start: 0 });
  await signIn(page);
  await expect(page.getByLabel("Task prompt", { exact: true })).toHaveValue(
    /Analyze my sales/,
  );
  await page.getByLabel("Task prompt", { exact: true }).fill("My edited task");
  page.once("dialog", (dialog) => dialog.dismiss());
  await page.getByRole("button", { name: /^Tax notice/ }).click();
  await expect(page.getByLabel("Task prompt", { exact: true })).toHaveValue(
    "My edited task",
  );
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: /^Tax notice/ }).click();
  await expect(page.getByLabel("Task prompt", { exact: true })).toHaveValue(
    /income-tax notice/,
  );
  await expect(
    page.getByRole("button", { name: "Start task", exact: true }),
  ).toBeDisabled();
  await expect(page.locator("#case-files")).toBeEnabled();
  expect(calls).toMatchObject({ create: 0, upload: 0, start: 0 });
});

test("unclear prompts ask for selection without replacing text; file limits and prompt length are enforced", async ({
  page,
}) => {
  const calls = await setup(page);
  await page.goto("/");
  await signIn(page);
  const prompt = page.getByLabel("Task prompt", { exact: true });
  await prompt.fill("My own question");
  await expect(page.getByRole("combobox")).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Start task", exact: true }),
  ).toBeEnabled();
  await page.getByRole("button", { name: "Start task", exact: true }).click();
  await expect(
    page.getByRole("group", { name: "Which type of work did you mean?" }),
  ).toBeVisible();
  expect(calls.create).toBe(0);
  await page
    .getByRole("button", { name: "Choose Data analysis", exact: true })
    .click();
  await expect(prompt).toHaveValue("My own question");
  await page.getByRole("button", { name: "Start task", exact: true }).click();
  await expect(page.getByRole("main").getByRole("alert")).toContainText(
    "Attach a CSV or Excel",
  );
  await page
    .locator("#case-files")
    .setInputFiles({ ...source, buffer: Buffer.alloc(1025) });
  await expect(page.getByRole("main").getByRole("alert")).toContainText(
    "at most 1 KB",
  );
  await page.locator("#case-files").setInputFiles([source, source, source]);
  await expect(page.getByRole("main").getByRole("alert")).toContainText(
    "at most 2",
  );
  await page.locator("#case-files").setInputFiles(source);
  await prompt.fill("x".repeat(5001));
  await page.getByRole("button", { name: "Start task", exact: true }).click();
  await expect(page.getByRole("main").getByRole("alert")).toContainText(
    "5,000",
  );
  expect(calls.create).toBe(0);
});

test("edited prompt starts once with Enter, not Shift+Enter or IME; Cases reopening never resubmits", async ({
  page,
}) => {
  const calls = await setup(page);
  await prepare(page);
  const prompt = page.getByLabel("Task prompt", { exact: true });
  await prompt.fill("Analyze this quarter");
  await prompt.press("Shift+Enter");
  await expect(prompt).toHaveValue("Analyze this quarter\n");
  await prompt.dispatchEvent("compositionstart");
  await prompt.press("Enter");
  await prompt.dispatchEvent("compositionend");
  expect(calls.create).toBe(0);
  await prompt.fill("Analyze this quarter\nKeep the full context.");
  await prompt.press("Enter");
  await expect(page).toHaveURL(/\/cases\/composer-case$/);
  expect(calls).toMatchObject({
    create: 1,
    upload: 1,
    start: 1,
    input: {
      title: "Analyze this quarter",
      description: "Analyze this quarter\nKeep the full context.",
      useCase: "data-analysis",
    },
  });
  await page.getByRole("link", { name: "Cases", exact: true }).click();
  await page.getByRole("link", { name: record.title, exact: true }).click();
  await expect(page.getByRole("button", { name: "Run again" })).toBeVisible();
  expect(calls.start).toBe(1);
});

test("generic message uses CSV headers without uploading or classifying via a model", async ({
  page,
}) => {
  const calls = await setup(page);
  await page.goto("/");
  await signIn(page);
  await page
    .getByLabel("Task prompt", { exact: true })
    .fill("Please review the attached records");
  await page
    .locator("#case-files")
    .setInputFiles({ ...source, name: "records.csv" });
  await expect(
    page.getByRole("status").filter({ hasText: "Detected: Data analysis" }),
  ).toBeVisible();
  expect(calls).toMatchObject({ create: 0, upload: 0, start: 0 });
  await page.getByRole("button", { name: "Start task", exact: true }).click();
  await expect(page).toHaveURL(/\/cases\/composer-case$/);
  expect(calls.input).toMatchObject({
    title: "Please review the attached records",
    description: "Please review the attached records",
    useCase: "data-analysis",
  });
});

test("conflicting message and data ask for selection; choosing never replaces the message or files", async ({
  page,
}) => {
  const calls = await setup(page);
  await prepare(page);
  const prompt = page.getByLabel("Task prompt", { exact: true });
  await prompt.fill("Review the income-tax notice");
  await page.getByRole("button", { name: "Start task", exact: true }).click();
  await expect(
    page.getByRole("group", { name: "Which type of work did you mean?" }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Choose Data analysis", exact: true })
    .click();
  await expect(prompt).toHaveValue("Review the income-tax notice");
  await expect(
    page.getByRole("list", { name: "Selected documents" }),
  ).toContainText("sales.csv");
  expect(calls.create).toBe(0);
  await prompt.fill("Review my overdue invoices");
  await page.getByRole("button", { name: "Start task", exact: true }).click();
  await expect(
    page.getByRole("group", { name: "Which type of work did you mean?" }),
  ).toBeVisible();
  await page
    .getByRole("button", {
      name: "Choose MSME delayed payment - Coming next",
      exact: true,
    })
    .click();
  await expect(
    page.getByRole("button", { name: "Start task", exact: true }),
  ).toBeDisabled();
  await expect(prompt).toHaveValue("Review my overdue invoices");
  expect(calls).toMatchObject({ create: 0, upload: 0, start: 0 });
});

test("clear tax and MSME messages are detected but cannot start unavailable work", async ({
  page,
}) => {
  const calls = await setup(page);
  await page.goto("/");
  await signIn(page);
  for (const [message, label] of [
    ["Reply to a 143(1) intimation about TDS", "Tax notice"],
    ["Reconcile my overdue invoices", "MSME delayed payment"],
  ]) {
    await page.getByLabel("Task prompt", { exact: true }).fill(message);
    await expect(
      page.getByRole("status").filter({ hasText: `Detected: ${label}` }),
    ).toContainText("Coming next");
    await expect(
      page.getByRole("button", { name: "Start task", exact: true }),
    ).toBeDisabled();
  }
  expect(calls).toMatchObject({ create: 0, upload: 0, start: 0 });
});

test("Start is the only intake surface and legacy links preserve sample origin through redirects", async ({
  page,
}) => {
  const calls = await setup(page);
  await page.goto("/cases/new");
  await expect(page).toHaveURL("/");
  await expect(
    page
      .getByRole("navigation")
      .getByRole("link", { name: "New task", exact: true }),
  ).toHaveCount(0);
  await expect(page.getByRole("combobox")).toHaveCount(0);
  await expect(page.locator("details")).toHaveCount(0);
  await expect(
    page.getByRole("heading", { name: "Private by design", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("heading", { name: "Ready for review", exact: true }),
  ).toBeVisible();
  const logos = page.locator('img[src="/logo.svg"]');
  await expect(logos).toHaveCount(2);
  expect(
    await logos.evaluateAll((images) =>
      images.every(
        (image) =>
          image instanceof HTMLImageElement &&
          image.complete &&
          image.naturalWidth > 0,
      ),
    ),
  ).toBe(true);
  await page.goto("/cases/new?source=sample-sales-quarter");
  await expect(page).toHaveURL(/\/\?source=sample-sales-quarter/);
  await expect(
    page.getByText("Copying a synthetic workflow", { exact: true }),
  ).toBeVisible();
  expect(calls.create).toBe(0);
});

test("disables duplicate submission while creation is pending", async ({
  page,
}) => {
  const calls = await setup(page);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/cases", async (route) => {
    calls.create++;
    await gate;
    await route.fulfill({ json: { case: record } });
  });
  await prepare(page);
  await page.getByRole("button", { name: "Start task", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Starting task..." }),
  ).toBeDisabled();
  await page.locator("form[aria-busy]").evaluate((form: HTMLFormElement) => {
    form.requestSubmit();
    form.requestSubmit();
  });
  expect(calls.create).toBe(1);
  release();
  await expect(page).toHaveURL(/\/cases\/composer-case$/);
  expect(calls).toMatchObject({ create: 1, upload: 1, start: 1 });
});

for (const stage of ["create", "upload", "run"] as const) {
  test(`ambiguous ${stage} response is reconciled without blindly retrying`, async ({
    page,
  }) => {
    const calls = await setup(page);
    const path =
      stage === "create"
        ? "**/cases"
        : stage === "upload"
          ? "**/cases/composer-case/documents"
          : "**/runs";
    await page.route(path, (route) => {
      if (route.request().method() === "GET")
        return route.fulfill({ json: { cases: [], nextCursor: null } });
      if (stage === "create") calls.create++;
      if (stage === "upload") calls.upload++;
      if (stage === "run") calls.start++;
      return route.fulfill({
        status: 502,
        json: { error: { message: "Response lost." } },
      });
    });
    if (stage === "run")
      await page.route("**/cases/composer-case/runs/latest", (route) =>
        route.fulfill({ json: { run: null } }),
      );
    await prepare(page);
    await page.getByRole("button", { name: "Start task", exact: true }).click();
    await expect(page.getByRole("main").getByRole("alert")).toBeVisible();
    await expect(
      page.getByRole("button", {
        name: stage === "create" ? "Start task" : "Resume task setup",
        exact: true,
      }),
    ).toBeDisabled();
    await expect(
      page.getByRole("link", {
        name: stage === "create" ? "Check Cases" : "Open created case",
        exact: true,
      }),
    ).toBeVisible();
    expect(calls.create).toBe(1);
    expect(calls.upload).toBe(stage === "create" ? 0 : 1);
    expect(calls.start).toBe(stage === "run" ? 1 : 0);
  });
}

test("reconciles an admitted run after a lost response, including completed execution", async ({
  page,
}) => {
  const calls = await setup(page);
  await page.route("**/runs", (route) => {
    calls.start++;
    return route.abort("failed");
  });
  await prepare(page);
  await page.getByRole("button", { name: "Start task", exact: true }).click();
  await expect(page).toHaveURL(/\/cases\/composer-case$/);
  await expect(page.getByRole("button", { name: "Run again" })).toBeVisible();
  expect(calls.start).toBe(1);
});

test("admitted execution uses persisted SSE progress in the detailed case", async ({
  page,
}) => {
  const calls = await setup(page);
  const queued = { ...run, status: "queued" };
  await page.route("**/runs", (route) => {
    calls.start++;
    return route.fulfill({ json: { run: queued } });
  });
  await page.route("**/cases/composer-case/runs/latest", (route) =>
    route.fulfill({ json: { run: queued } }),
  );
  await page.route("**/cases/composer-case/stream?*", (route) =>
    route.fulfill({
      contentType: "text/event-stream",
      body: `data: ${JSON.stringify({
        id: "persisted-1",
        runId: run.id,
        caseId: record.id,
        sequence: 1,
        occurredAt: record.updatedAt,
        payload: {
          type: "task-started",
          taskId: "sales-task",
          role: "business-data-analyst",
        },
      })}\n\n`,
    }),
  );
  await prepare(page);
  await page.getByRole("button", { name: "Start task", exact: true }).click();
  await expect(
    page.getByRole("list", { name: "Run event timeline" }),
  ).toContainText("A review task started");
  await expect(page.getByRole("button", { name: "Cancel run" })).toBeVisible();
  expect(calls.start).toBe(1);
});

test("late run admission cannot navigate or revive a private draft after session loss", async ({
  page,
}) => {
  const calls = await setup(page);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/runs", async (route) => {
    calls.start++;
    await gate;
    await route.fulfill({ json: { run } });
  });
  await prepare(page);
  await page.getByRole("button", { name: "Start task", exact: true }).click();
  await expect.poll(() => calls.start).toBe(1);
  await page
    .getByRole("button", { name: "Sign out and revoke this session" })
    .click();
  await signIn(page);
  const response = page.waitForResponse(
    (response) => new URL(response.url()).pathname === "/runs",
  );
  release();
  await (await response).finished();
  await expect(page.getByLabel("Task prompt", { exact: true })).toHaveValue("");
  await expect(page).toHaveURL("/");
  await expect(
    page.getByRole("list", { name: "Selected documents" }),
  ).toHaveCount(0);
  expect(calls.create).toBe(1);
});

test("reading sources open preparation state without dispatch; readiness enables the existing Start control", async ({
  page,
}) => {
  const calls = await setup(page);
  let ready = false;
  await page.route("**/cases/composer-case", (route) => {
    if (route.request().headers().accept !== "application/json")
      return route.continue();
    return route.fulfill({
      json: {
        case: record,
        documents: [
          { ...sourceDocument, state: ready ? "ready" : "processing" },
        ],
        findings: [],
        evidence: [],
        deliverables: [],
      },
    });
  });
  await prepare(page);
  await page.getByRole("button", { name: "Start task", exact: true }).click();
  await expect(page).toHaveURL(/\/cases\/composer-case$/);
  await expect(
    page.getByText("Reading source files.", { exact: false }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Start analysis" }),
  ).toBeDisabled();
  expect(calls.start).toBe(0);
  ready = true;
  await expect(
    page.getByRole("button", { name: "Start analysis" }),
  ).toBeEnabled({ timeout: 10000 });
});

test("private draft and attachments clear on sign-out, with no browser persistence", async ({
  page,
}) => {
  await setup(page);
  await prepare(page);
  await page
    .getByLabel("Task prompt", { exact: true })
    .fill("Private draft not for storage");
  expect(
    await page.evaluate(() =>
      JSON.stringify({
        local: { ...localStorage },
        session: { ...sessionStorage },
      }),
    ),
  ).not.toContain("Private draft");
  await page
    .getByRole("button", { name: "Sign out and revoke this session" })
    .click();
  await expect(page.getByLabel("Task prompt", { exact: true })).toHaveValue("");
  await signIn(page);
  await expect(page.getByLabel("Task prompt", { exact: true })).toHaveValue("");
  await expect(
    page.getByRole("list", { name: "Selected documents" }),
  ).toHaveCount(0);
});

test("authenticated composer and attachment controls pass axe in mobile light/dark and reduced motion", async ({
  page,
}) => {
  await setup(page);
  await prepare(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect(
    page.getByRole("button", { name: "Remove sales.csv" }),
  ).toBeEnabled();
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  await page.getByRole("button", { name: "Switch to dark theme" }).click();
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});
