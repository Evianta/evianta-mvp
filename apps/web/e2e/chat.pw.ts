import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import {
  csv,
  mockApi,
  waitingSegments,
  type MockState,
} from "./support/mock-api";

const message = (page: Page) => page.getByLabel("Message to Evianta");

test("a planning failure is not presented as finished work", async ({
  page,
}) => {
  const errorMessage =
    'No active price is configured for muse:spark with settings {"maxOutputTokens":2048}. Ask an administrator to import a matching price record.';
  await mockApi(page, {
    findings: [],
    segments: [
      {
        final: "failed",
        events: [
          {
            type: "run-failed",
            error: {
              code: "usage-admission-rejected",
              message: errorMessage,
            },
          },
        ],
      },
    ],
  });
  await page.goto("/#access=jury-amber-falcon-47");
  await page.getByLabel("Attach records").setInputFiles(csv);
  await send(page, "Analyze my sales spreadsheet");
  await expect(page.getByText("Work could not finish")).toBeVisible();
  await expect(
    page.getByText(`The run stopped: ${errorMessage}`),
  ).toBeVisible();
  await expect(page.getByText("Work finished", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Try again" })).toBeVisible();
});

async function send(page: Page, text: string) {
  await message(page).fill(text);
  await page.getByRole("button", { name: "Send message" }).click();
}

async function signInFromCard(page: Page, key = "jury-amber-falcon-47") {
  await page.getByRole("button", { name: "Enter access key" }).last().click();
  await page.getByLabel("Access key", { exact: true }).fill(key);
  await page.getByRole("button", { name: "Continue", exact: true }).click();
}

test("the chat is usable before sign-in and keeps the message through sign-in", async ({
  page,
}) => {
  const state = await mockApi(page);
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "Hi, I am Evianta." }),
  ).toBeVisible();
  await expect(message(page)).toBeEnabled();
  await expect(page.getByLabel("Attach records")).toBeEnabled();
  await expect(
    page.getByRole("button", { name: "Business data analysis" }),
  ).toBeVisible();

  await page.getByLabel("Attach records").setInputFiles(csv);
  await expect(page.getByText("sales.csv")).toBeVisible();
  await send(page, "Analyze my sales spreadsheet and highlight trends");

  await expect(
    page.getByText("I need your access key first", { exact: false }),
  ).toBeVisible();
  expect(state.created).toHaveLength(0);
  await signInFromCard(page);
  expect(state.authTokens).toEqual(["jury-amber-falcon-47"]);

  await expect(
    page.getByText("Got it. This looks like business data analysis."),
  ).toBeVisible();
  await expect(page.getByRole("list", { name: "Task setup" })).toBeVisible();
  await expect(page.getByText("Work finished")).toBeVisible();
  await expect(page.getByText("Business Data Analyst").first()).toBeVisible();
  await expect(page.getByText("Independent Reviewer").first()).toBeVisible();
  await expect(
    page.getByText("Revenue grew 12 percent quarter over quarter", {
      exact: false,
    }),
  ).toBeVisible();

  const details = page.getByRole("link", { name: "Open full details" });
  await expect(details).toHaveAttribute("href", "/cases/case-1");
  expect(state).toMatchObject({ runs: 1, uploads: ["sales.csv"] });
  expect(state.created[0]).toMatchObject({ useCase: "data-analysis" });
  await expect(page).toHaveURL(/\/\?case=case-1$/);
});

test("chips open an inspector and agents open their profile", async ({
  page,
}) => {
  await mockApi(page);
  await page.goto("/#access=jury-amber-falcon-47");
  await expect(page).toHaveURL(/\/$/);
  await page.getByLabel("Attach records").setInputFiles(csv);
  await send(page, "Analyze my sales spreadsheet");
  await expect(page.getByText("Work finished")).toBeVisible();

  await page
    .getByRole("button", { name: /Revenue grew 12 percent/ })
    .first()
    .click();
  const panel = page.getByRole("dialog");
  await expect(panel.getByText("detailed explanation")).toBeVisible();
  await expect(
    panel.getByText("Rows are complete for the quarter"),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(panel).toHaveCount(0);

  await page
    .getByRole("button", { name: /Business Data Analyst, done/ })
    .click();
  await expect(
    page.getByRole("dialog").getByText("Does careful work"),
  ).toBeVisible();
  await page.keyboard.press("Escape");
});

test("a shared access link signs in once and removes the key from the address bar", async ({
  page,
}) => {
  const state = await mockApi(page);
  await page.goto("/#access=Jury%20Amber%20Falcon%2047");
  await expect(
    page.getByRole("button", { name: "Sign out and revoke this session" }),
  ).toBeVisible();
  expect(state.authTokens).toEqual(["Jury Amber Falcon 47"]);
  expect(page.url()).not.toContain("access");
  expect(
    await page.evaluate(() => JSON.stringify({ ...localStorage })),
  ).not.toContain("Falcon");
});

test("an unclear request asks which of the three scenarios to use", async ({
  page,
}) => {
  const state = await mockApi(page);
  await page.goto("/#access=jury-amber-falcon-47");
  await send(page, "Can you help me with this?");
  await expect(
    page.getByText("I could not tell which type of work you mean"),
  ).toBeVisible();
  for (const name of [
    "Business data analysis",
    "Income-tax notice response",
    "MSME delayed-payment dispute",
  ]) {
    await expect(
      page.getByRole("button", { name: new RegExp(name) }).first(),
    ).toBeVisible();
  }
  expect(state.created).toHaveLength(0);
  await page
    .getByRole("button", { name: /Business data analysis Trends/ })
    .click();
  await expect(
    page.getByText("I still need the dataset to analyze"),
  ).toBeVisible();
  await page.getByRole("button", { name: "Attach a file" }).click();
  await page.getByLabel("Attach records").setInputFiles(csv);
  await expect(page.getByText("Thanks, I have it.")).toBeVisible();
  await expect(page.getByText("Work finished")).toBeVisible();
  expect(state.created[0]).toMatchObject({ useCase: "data-analysis" });
});

test("missing documents and facts are requested interactively and recorded", async ({
  page,
}) => {
  const state = await mockApi(page);
  await page.goto("/#access=jury-amber-falcon-47");
  await page.getByLabel("Attach records").setInputFiles({
    name: "notice.pdf",
    mimeType: "application/pdf",
    buffer: Buffer.from("%PDF-1.4 notice"),
  });
  await send(page, "Help me reply to my 143(1) intimation");

  await expect(
    page.getByText("I still need your return or income summary"),
  ).toBeVisible();
  await page.getByRole("button", { name: "I do not have it" }).click();
  await expect(
    page.getByText("Which assessment year is this notice for?"),
  ).toBeVisible();
  await page.getByRole("button", { name: "AY 2024-25" }).click();

  await expect(page.getByText("Work finished")).toBeVisible();
  const description = String(state.created[0]?.description);
  expect(state.created[0]).toMatchObject({ useCase: "tax-notice" });
  expect(description).toContain("Help me reply to my 143(1) intimation");
  expect(description).toContain("Assessment year: AY 2024-25");
  expect(description).toContain("Not available: your return or income summary");
});

test("a clarification form submits answers and resumes the run", async ({
  page,
}) => {
  const state: MockState = await mockApi(page, { segments: waitingSegments });
  await page.goto("/#access=jury-amber-falcon-47");
  await page.getByLabel("Attach records").setInputFiles([
    {
      name: "notice.pdf",
      mimeType: "application/pdf",
      buffer: Buffer.from("%PDF-1.4 a"),
    },
    {
      name: "itr.pdf",
      mimeType: "application/pdf",
      buffer: Buffer.from("%PDF-1.4 b"),
    },
  ]);
  await send(page, "Reply to my income tax notice for AY 2024-25");

  await expect(page.getByText("Waiting for your answer")).toBeVisible();
  await expect(
    page.getByText("Which bank account were the payments received in?"),
  ).toBeVisible();
  await expect(message(page)).toBeDisabled();

  await page
    .getByLabel("Which bank account were the payments received in?")
    .fill("HDFC current account ending 4821");
  await page
    .getByRole("button", { name: "Submit answers and continue" })
    .click();
  await expect(page.getByText("Work finished")).toBeVisible();
  expect(state.resumes).toHaveLength(1);
  expect(state.resumes[0]).toMatchObject({
    idempotencyKey: expect.stringMatching(/^resume-/),
    input: {
      "t1:input:1:q0": {
        question: "Which bank account were the payments received in?",
        answer: "HDFC current account ending 4821",
      },
    },
  });
  await expect(
    page.getByRole("link", { name: "Open full details" }),
  ).toBeVisible();
});

test("all clarification answers are submitted together with supporting files", async ({
  page,
}) => {
  const questions = [
    { id: "t1:input:1:q0", text: "What TDS credit was claimed?" },
    { id: "t1:input:1:q1", text: "What is the response deadline?" },
    { id: "t1:input:1:q2", text: "Which tax regime applies?" },
  ];
  const state = await mockApi(page, {
    segments: waitingSegments,
    questions,
  });
  await page.goto("/#access=jury-amber-falcon-47");
  await page.getByLabel("Attach records").setInputFiles(csv);
  await send(page, "Analyze my sales spreadsheet");
  const form = page.getByRole("form", { name: "Details needed to continue" });
  const submit = form.getByRole("button", {
    name: "Submit answers and continue",
  });
  await expect(form.getByRole("textbox")).toHaveCount(3);
  await expect(submit).toBeDisabled();
  await form.getByLabel(questions[0]!.text).fill("52000 and 8000");
  await expect(submit).toBeDisabled();
  expect(state.resumes).toHaveLength(0);
  await form.getByLabel(questions[1]!.text).fill("   ");
  await form.getByLabel(questions[2]!.text).fill("New regime");
  await expect(submit).toBeDisabled();
  await form.getByLabel(questions[1]!.text).fill("15 November 2026");
  await form.getByLabel("Supporting files (optional)").setInputFiles({
    ...csv,
    name: "tds.csv",
  });
  await submit.click();
  await expect(page.getByText("Work finished")).toBeVisible();
  expect(state.resumes).toHaveLength(1);
  expect(state.resumes[0]).toMatchObject({
    input: {
      "t1:input:1:q0": {
        question: questions[0]!.text,
        answer: "52000 and 8000. Uploaded: tds.csv",
      },
      "t1:input:1:q1": {
        question: questions[1]!.text,
        answer: "15 November 2026. Uploaded: tds.csv",
      },
      "t1:input:1:q2": {
        question: questions[2]!.text,
        answer: "New regime. Uploaded: tds.csv",
      },
    },
  });
  expect(state.uploads).toEqual(["sales.csv", "tds.csv"]);
  await expect(form.getByRole("status")).toHaveText(
    "Answers sent. The team can continue.",
  );
  await expect(message(page)).toBeEnabled();
});

test("clarification form retries keep answers and the resume idempotency key", async ({
  page,
}) => {
  const state = await mockApi(page, {
    segments: waitingSegments,
    failResumeOnce: true,
  });
  await page.goto("/#access=jury-amber-falcon-47");
  await page.getByLabel("Attach records").setInputFiles(csv);
  await send(page, "Analyze my sales spreadsheet");
  const form = page.getByRole("form", { name: "Details needed to continue" });
  await form.getByRole("textbox").fill("HDFC current account ending 4821");
  await form
    .getByRole("button", { name: "Submit answers and continue" })
    .click();
  await expect(form.getByRole("alert")).toContainText(
    "I could not pass your answers on",
  );
  await expect(form.getByRole("textbox")).toHaveValue(
    "HDFC current account ending 4821",
  );
  await form.getByRole("button", { name: "Retry sending answers" }).click();
  await expect(page.getByText("Work finished")).toBeVisible();
  expect(state.resumes).toHaveLength(2);
  expect(state.resumes[1]).toEqual(state.resumes[0]);
});

test("an uncertain case creation is never resent", async ({ page }) => {
  const state = await mockApi(page, { failCreate: true });
  await page.goto("/#access=jury-amber-falcon-47");
  await page.getByLabel("Attach records").setInputFiles(csv);
  await send(page, "Analyze my sales");
  await expect(
    page.getByText("I could not confirm that your case was created", {
      exact: false,
    }),
  ).toBeVisible();
  expect(state.created).toHaveLength(0);
  await expect(message(page)).toBeDisabled();
  await expect(
    page.getByRole("button", { name: "Check your cases" }),
  ).toBeVisible();
});

test("file limits are explained in the composer", async ({ page }) => {
  await mockApi(page, { maxFiles: 1 });
  await page.goto("/#access=jury-amber-falcon-47");
  await expect(
    page.getByRole("button", { name: "Sign out and revoke this session" }),
  ).toBeVisible();
  await page.getByLabel("Attach records").setInputFiles(csv);
  await page.getByLabel("Attach records").setInputFiles({
    ...csv,
    name: "more.csv",
  });
  await expect(
    page.getByText("Please attach at most 1 file for one task."),
  ).toBeVisible();
  await page.getByLabel("Attach records").setInputFiles({
    name: "program.exe",
    mimeType: "application/octet-stream",
    buffer: Buffer.from("MZ"),
  });
  await expect(
    page.getByRole("alert").getByText(/does not accept/),
  ).toBeVisible();
});

test("opening a case link rebuilds the conversation from saved progress", async ({
  page,
}) => {
  await mockApi(page, { seedCase: true });
  await page.goto("/?case=case-1#access=jury-amber-falcon-47");
  await expect(page.getByText("Welcome back.", { exact: false })).toBeVisible();
  await expect(
    page.getByText("Analyze my sales spreadsheet and highlight trends"),
  ).toBeVisible();
  await expect(page.getByText("Work finished")).toBeVisible();
  await expect(
    page.getByText("Revenue grew 12 percent quarter over quarter", {
      exact: false,
    }),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: "Open full details" }),
  ).toHaveAttribute("href", "/cases/case-1");
  await expect(page).toHaveURL(/\/\?case=case-1$/);
});

test("the Sources menu shows demo connectors with a preview", async ({
  page,
}) => {
  await mockApi(page);
  await page.goto("/");
  await page.getByRole("button", { name: "Sources" }).click();
  await expect(
    page.getByText("No data sources yet.", { exact: false }),
  ).toBeVisible();
  await page.getByRole("menuitem", { name: "Connect a source" }).click();
  const dialog = page.getByRole("dialog");
  await expect(
    dialog.getByRole("heading", { name: "Connect a source" }),
  ).toBeVisible();
  for (const name of [
    "Tally",
    "Busy",
    "Zoho Books",
    "Shopify",
    "Gmail",
    "Outlook",
    "Google Drive",
  ]) {
    await expect(
      dialog.getByRole("button", { name: new RegExp(`^${name}`) }),
    ).toBeVisible();
  }
  await dialog.getByRole("button", { name: /^Tally/ }).click();
  await expect(
    dialog.getByRole("img", { name: /Illustration of Tally/ }),
  ).toBeVisible();
  await dialog.getByRole("button", { name: "Upload files instead" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
});

test("the chat and the team directory pass accessibility checks in both themes and on mobile", async ({
  page,
}) => {
  await mockApi(page);
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "Hi, I am Evianta." }),
  ).toBeVisible();
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  await page.getByRole("button", { name: "Switch to dark theme" }).click();
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);

  await page.setViewportSize({ width: 390, height: 800 });
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);

  await page.goto("/agents");
  await expect(
    page.getByRole("heading", { name: "Meet the team behind your case" }),
  ).toBeVisible();
  await expect(page.getByText("Lead agent").first()).toBeVisible();
  await expect(page.getByText("System capabilities")).toBeVisible();
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  await page.getByRole("button", { name: /Business Data Analyst/ }).click();
  await expect(
    page.getByRole("dialog").getByText("What they can do"),
  ).toBeVisible();
  await expect(page.getByRole("dialog")).toHaveCSS("opacity", "1");
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
});
