import { syntheticWorkflowFixtures } from "@evianta/core";
import { expect, test, type Page } from "@playwright/test";
import { SESSION_STORAGE_KEY } from "../src/session/session-controller";

async function enterKey(page: Page) {
  await page
    .getByRole("button", { name: "Enter access key", exact: true })
    .click();
  await page
    .getByLabel("Access key", { exact: true })
    .fill("test-key-not-saved");
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
}

async function mockAuth(page: Page) {
  await page.route("**/auth/token", (route) =>
    route.fulfill({
      json: {
        accessToken: "saved-session",
        expiresAt: new Date(Date.now() + 1800000).toISOString(),
      },
    }),
  );
  await page.route("**/intake/configuration", (route) =>
    route.fulfill({
      json: {
        workflows: ["data-analysis"],
        uploadMaxBytes: 1024,
        uploadMaxFiles: 5,
        documentMaxPages: 80,
      },
    }),
  );
  await page.route("**/auth/logout", (route) => route.fulfill({ status: 204 }));
}

async function savedSession(page: Page) {
  return page.evaluate((key) => localStorage.getItem(key), SESSION_STORAGE_KEY);
}

test("reload restores localStorage login without re-entering the key, cookies or resubmitting work", async ({
  page,
  context,
}) => {
  await mockAuth(page);
  let exchanges = 0;
  let cookieRestores = 0;
  page.on("request", (request) => {
    if (new URL(request.url()).pathname === "/auth/token") exchanges++;
    if (new URL(request.url()).pathname === "/auth/session") cookieRestores++;
  });
  await page.route("**/cases", (route) => {
    if (route.request().headers().accept !== "application/json")
      return route.continue();
    expect(route.request().method()).toBe("GET");
    expect(route.request().headers().authorization).toBe(
      "Bearer saved-session",
    );
    return route.fulfill({
      json: {
        cases: [
          {
            ...syntheticWorkflowFixtures.dataAnalysis.case,
            ownerId: "owner-1",
            isSample: false,
          },
        ],
        nextCursor: null,
      },
    });
  });
  await page.goto("/");
  await enterKey(page);
  const saved = await savedSession(page);
  expect(saved).toBeTruthy();
  expect(JSON.parse(saved!)).toEqual({
    accessToken: "saved-session",
    expiresAt: expect.any(Number),
  });
  expect(JSON.stringify(await context.storageState())).not.toContain(
    "test-key-not-saved",
  );
  expect(await context.cookies()).toHaveLength(0);
  await page
    .getByLabel("Task prompt", { exact: true })
    .fill("Private draft clears on reload");
  await page.reload();
  await expect(
    page.getByRole("button", { name: "Sign out and revoke this session" }),
  ).toBeVisible();
  await expect(page.getByLabel("Task prompt", { exact: true })).toHaveValue("");
  expect(await savedSession(page)).toBe(saved);
  await page.getByRole("link", { name: "Cases", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Your cases" })).toBeVisible();
  await page.reload();
  await expect(
    page.getByRole("link", {
      name: syntheticWorkflowFixtures.dataAnalysis.case.title,
      exact: true,
    }),
  ).toBeVisible();
  expect(exchanges).toBe(1);
  expect(cookieRestores).toBe(0);
  await page
    .getByRole("button", { name: "Sign out and revoke this session" })
    .click();
  await expect.poll(() => savedSession(page)).toBeNull();
  await page.reload();
  await expect(
    page.getByRole("button", { name: "Sign in", exact: true }),
  ).toBeVisible();
});

test("expired and malformed saved sessions cannot unlock drafts", async ({
  page,
}) => {
  await page.goto("/");
  await page.evaluate(
    (key) =>
      localStorage.setItem(
        key,
        JSON.stringify({ accessToken: "expired", expiresAt: Date.now() - 1 }),
      ),
    SESSION_STORAGE_KEY,
  );
  await page.reload();
  await expect(page.getByLabel("Task prompt", { exact: true })).toBeDisabled();
  expect(await savedSession(page)).toBeNull();
  await page.evaluate(
    (key) => localStorage.setItem(key, "{invalid"),
    SESSION_STORAGE_KEY,
  );
  await page.reload();
  await expect(
    page
      .getByRole("status")
      .filter({ hasText: "Sign-in could not be restored" }),
  ).toContainText("Saved sign-in is invalid");
  expect(await savedSession(page)).toBeNull();
});

test("active session expiry removes saved login and private drafts without a reload", async ({
  page,
}) => {
  await page.clock.install({ time: new Date() });
  await mockAuth(page);
  await page.goto("/");
  await enterKey(page);
  await page
    .getByLabel("Task prompt", { exact: true })
    .fill("Private sales draft");
  await page.clock.fastForward(31 * 60 * 1000);
  await expect(page.getByLabel("Task prompt", { exact: true })).toBeDisabled();
  await expect(page.getByLabel("Task prompt", { exact: true })).toHaveValue("");
  expect(await savedSession(page)).toBeNull();
});

test("an authentication rejection clears the persisted token and private draft", async ({
  page,
}) => {
  await mockAuth(page);
  let reject = false;
  await page.route("**/cases", (route) => {
    if (route.request().headers().accept !== "application/json")
      return route.continue();
    reject = true;
    return route.fulfill({
      status: 401,
      json: { error: { message: "Session revoked." } },
    });
  });
  await page.goto("/");
  await enterKey(page);
  await page
    .getByLabel("Task prompt", { exact: true })
    .fill("Private sales draft");
  await page.getByRole("link", { name: "Cases", exact: true }).click();
  await expect.poll(() => reject).toBe(true);
  await expect.poll(() => savedSession(page)).toBeNull();
  await page.reload();
  await expect(
    page.getByRole("button", { name: "Sign in", exact: true }),
  ).toBeVisible();
});

test("failed server revocation still removes local login, clears drafts and offers retry", async ({
  page,
}) => {
  await mockAuth(page);
  let attempts = 0;
  await page.route("**/auth/logout", (route) => {
    attempts++;
    expect(route.request().headers().authorization).toBe(
      "Bearer saved-session",
    );
    return attempts === 1
      ? route.fulfill({
          status: 503,
          json: { error: { message: "Session service unavailable." } },
        })
      : route.fulfill({ status: 204 });
  });
  await page.goto("/");
  await enterKey(page);
  await page
    .getByLabel("Task prompt", { exact: true })
    .fill("Private sales draft");
  await page
    .getByRole("button", { name: "Sign out and revoke this session" })
    .click();
  await expect(
    page.getByRole("status").filter({ hasText: "Sign-out could not finish" }),
  ).toContainText("Retry sign-out");
  expect(await savedSession(page)).toBeNull();
  await expect(page.getByLabel("Task prompt", { exact: true })).toHaveValue("");
  await page
    .getByRole("button", { name: "Sign out and revoke this session" })
    .click();
  await expect(
    page.getByRole("button", { name: "Sign in", exact: true }),
  ).toBeEnabled();
  expect(attempts).toBe(2);
  await page.reload();
  await expect(
    page.getByRole("button", { name: "Sign in", exact: true }),
  ).toBeVisible();
});

test("logout in another tab clears the active session and private draft", async ({
  page,
  context,
}) => {
  await mockAuth(page);
  await page.goto("/");
  await enterKey(page);
  await page
    .getByLabel("Task prompt", { exact: true })
    .fill("Private sales draft");
  const second = await context.newPage();
  await mockAuth(second);
  await second.goto("/");
  await expect(
    second.getByRole("button", { name: "Sign out and revoke this session" }),
  ).toBeVisible();
  await second
    .getByRole("button", { name: "Sign out and revoke this session" })
    .click();
  await expect(page.getByLabel("Task prompt", { exact: true })).toBeDisabled();
  await expect(page.getByLabel("Task prompt", { exact: true })).toHaveValue("");
  expect(await savedSession(page)).toBeNull();
  await second.close();
});

test("blocked storage is reported rather than pretending login is persisted", async ({
  page,
}) => {
  await page.addInitScript(() => {
    Storage.prototype.setItem = () => {
      throw new DOMException("Browser storage blocked.", "SecurityError");
    };
  });
  await mockAuth(page);
  await page.goto("/");
  await page
    .getByRole("button", { name: "Enter access key", exact: true })
    .click();
  await page
    .getByLabel("Access key", { exact: true })
    .fill("test-key-not-saved");
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await expect(page.getByRole("dialog").getByRole("alert")).toContainText(
    "Sign-in could not be saved",
  );
  await expect(page.getByLabel("Task prompt", { exact: true })).toBeDisabled();
  expect(await savedSession(page)).toBeNull();
});
