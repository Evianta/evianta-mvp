import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

test("public task starter is accessible in both themes and on mobile", async ({
  page,
}) => {
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "What would you like to work on?" }),
  ).toBeVisible();
  await expect(
    page.getByText(
      "Read-only synthetic previews. No model calls or live records.",
    ),
  ).toBeVisible();
  await expect(page.getByLabel("Task prompt", { exact: true })).toBeDisabled();
  await expect(
    page.getByLabel("Attach records", { exact: true }),
  ).toBeDisabled();

  const lightViolations = await new AxeBuilder({ page }).analyze();
  expect(lightViolations.violations).toEqual([]);

  await page.getByRole("button", { name: "Switch to dark theme" }).click();
  await expect(page.locator("html")).toHaveClass(/dark/);
  const darkViolations = await new AxeBuilder({ page }).analyze();
  expect(darkViolations.violations).toEqual([]);

  await page.setViewportSize({ width: 700, height: 900 });
  await expect(page.locator(".command-trigger")).toHaveAccessibleName(
    "Search workspace K shortcut",
  );
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});

test("sample pages are read-only and copying asks for a key", async ({
  page,
}) => {
  await page.goto("/samples/sample-msme-overdue");
  await expect(
    page.getByRole("heading", { name: "Synthetic delayed-payment case" }),
  ).toBeVisible();
  await expect(page.getByText("Synthetic replay").first()).toBeVisible();
  await page.getByRole("button", { name: "Copy to a private case" }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await expect(page.getByLabel("Access key")).toHaveAttribute(
    "type",
    "password",
  );
  await expect(
    page.getByText("Your key is never saved.", { exact: false }),
  ).toBeVisible();
});

test("copying asks for a session and admin access is checked by the server", async ({
  page,
}) => {
  let submittedKey = "";
  await page.route("**/auth/token", async (route) => {
    submittedKey = route.request().postDataJSON().accessKey;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        accessToken: "fixture-session-token",
        expiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
      }),
    });
  });
  await page.route("**/admin/usage", async (route) => {
    if (route.request().resourceType() !== "fetch") {
      await route.continue();
      return;
    }
    await route.fulfill({
      status: 403,
      contentType: "text/plain",
      body: "Administrator access required.",
    });
  });

  await page.goto("/samples/sample-msme-overdue");
  await page.getByRole("button", { name: "Copy to a private case" }).click();
  await page.getByLabel("Access key").fill("fixture-test-key");
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page).toHaveURL(/\/\?source=sample-msme-overdue/);
  await expect(
    page.getByRole("heading", { name: "What would you like to work on?" }),
  ).toBeVisible();
  expect(submittedKey).toBe("fixture-test-key");
  expect(
    await page.evaluate(() =>
      Object.keys(localStorage).some((key) => /token|access.?key/i.test(key)),
    ),
  ).toBe(false);

  await page.getByRole("link", { name: "Usage overview" }).click();
  await expect(page).toHaveURL(/\/admin\/usage$/, { timeout: 15000 });
  await expect(
    page.getByRole("heading", { name: "Administrator access required" }),
  ).toBeVisible();
});
