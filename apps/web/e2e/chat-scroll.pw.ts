import { expect, test } from "@playwright/test";
import { mockApi } from "./support/mock-api";

for (const width of [1280, 390]) {
  test(`Evianta replies leave trailing space at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 844 });
    await mockApi(page, { seedCase: true });
    await page.goto("/?case=case-1#access=jury-amber-falcon-47");
    await expect(page.getByText("Work finished")).toBeVisible();
    const bodies = page.locator(".msg-evianta .msg-body");
    await expect(page.locator(".msg-body-wide").first()).toBeVisible();
    expect(await bodies.count()).toBeGreaterThan(0);
    for (const body of await bodies.all()) {
      const gap = await body.evaluate((element) => {
        const message = element.closest(".msg")!.getBoundingClientRect();
        return message.right - element.getBoundingClientRect().right;
      });
      expect(gap).toBeGreaterThanOrEqual(16);
    }
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    const user = await page.locator(".msg-user-bubble").first().boundingBox();
    const thread = await page.getByRole("log").boundingBox();
    expect(user).not.toBeNull();
    expect(thread).not.toBeNull();
    expect(
      Math.abs(user!.x + user!.width - thread!.x - thread!.width),
    ).toBeLessThan(1);
  });

  test(`chat follows streaming and keeps its input anchored at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 844 });
    await mockApi(page);
    await page.goto("/#access=jury-amber-falcon-47");
    await expect(
      page.getByRole("button", { name: "Sign out and revoke this session" }),
    ).toBeVisible();
    await page.evaluate(() => {
      const observer = new MutationObserver(() => {
        if (document.querySelector(".jump-latest")) {
          document.documentElement.dataset.jumpShown = "true";
        }
      });
      observer.observe(document.body, { childList: true, subtree: true });
    });
    await page
      .getByLabel("Message to Evianta")
      .fill("Please help me with this.\n".repeat(60));
    await page.getByRole("button", { name: "Send message" }).click();
    await expect(
      page.getByRole("button", {
        name: "Business data analysis",
        exact: false,
      }),
    ).toBeVisible();
    await page.clock.install();
    await page.clock.pauseAt(new Date(Date.now() + 1000));
    await page.getByLabel("Message to Evianta").fill("Still unsure");
    await page.getByRole("button", { name: "Send message" }).click();

    const thread = page.getByRole("log");
    const input = page.getByLabel("Message to Evianta");
    const jump = page.getByRole("button", { name: "Jump to latest" });
    await expect(thread).toBeVisible();
    await expect(page.locator("[data-streaming]")).toBeVisible();
    await expect
      .poll(() =>
        page.evaluate(
          () => document.documentElement.scrollHeight - innerHeight - scrollY,
        ),
      )
      .toBeLessThan(2);
    expect(
      await page.evaluate(() => document.documentElement.dataset.jumpShown),
    ).toBeUndefined();
    const initialInput = await input.boundingBox();
    expect(initialInput).not.toBeNull();
    expect(initialInput!.y + initialInput!.height).toBeLessThan(844);

    const latestScrollTop = await page.evaluate(() => scrollY);
    await page.mouse.move(width - 80, 350);
    await page.mouse.wheel(0, -600);
    await expect(jump).toBeVisible();
    await expect
      .poll(() => page.evaluate(() => scrollY))
      .toBeLessThanOrEqual(latestScrollTop - 599);
    const scrolledInput = await input.boundingBox();
    expect(Math.abs(scrolledInput!.y - initialInput!.y)).toBeLessThanOrEqual(1);
    expect(await thread.evaluate((element) => element.scrollTop)).toBe(0);
    expect(
      await thread.evaluate((element) => getComputedStyle(element).overflowY),
    ).toBe("visible");

    const scrollTop = await page.evaluate(() => scrollY);
    await page.clock.runFor(2000);
    await expect(page.locator("[data-streaming]")).toHaveCount(0);
    expect(await page.evaluate(() => scrollY)).toBeCloseTo(scrollTop, 0);
    await expect(jump).toBeVisible();
    await page.clock.resume();
    await jump.click();
    await expect(jump).toHaveCount(0);
    await expect
      .poll(() =>
        page.evaluate(
          () => document.documentElement.scrollHeight - innerHeight - scrollY,
        ),
      )
      .toBeLessThan(2);
    const latestInput = await input.boundingBox();
    expect(Math.abs(latestInput!.y - initialInput!.y)).toBeLessThanOrEqual(1);

    await input.fill("I am still unsure");
    await page.getByRole("button", { name: "Send message" }).click();
    await expect(page.locator("[data-streaming]")).toHaveCount(0);
    await expect(jump).toHaveCount(0);
    await input.fill("Another question\n".repeat(8));
    await expect
      .poll(() =>
        page.evaluate(
          () => document.documentElement.scrollHeight - innerHeight - scrollY,
        ),
      )
      .toBeLessThan(2);
    await expect(jump).toHaveCount(0);
    await page.setViewportSize({ width, height: 700 });
    await expect
      .poll(async () => {
        const box = await input.boundingBox();
        return box!.y + box!.height;
      })
      .toBeLessThan(700);
    await expect
      .poll(() =>
        page.evaluate(
          () => document.documentElement.scrollHeight - innerHeight - scrollY,
        ),
      )
      .toBeLessThan(2);
    expect(await thread.evaluate((element) => element.scrollTop)).toBe(0);
    await expect(jump).toHaveCount(0);
  });
}
