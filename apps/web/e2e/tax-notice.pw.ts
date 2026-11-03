import AxeBuilder from "@axe-core/playwright";
import { readFile } from "node:fs/promises";
import { readPdf } from "../test/support/pdf";
import { syntheticWorkflowFixtures, type Finding } from "@evianta/core";
import { expect, test, type Page } from "@playwright/test";
import type { CaseWorkspace } from "../src/api/client";

const record = {
  ...syntheticWorkflowFixtures.taxNotice.case,
  id: "private-tax-case",
  ownerId: "owner-1",
  isSample: false,
  synthetic: false,
};
const finding: Finding = {
  id: "income-difference",
  caseId: record.id,
  title: "Income reconciliation",
  description:
    "Return income is 1,200,000 and notice income is 1,350,000. The difference is 150,000.",
  severity: "medium",
  confidence: 0.8,
  evidenceIds: ["notice-evidence", "guidance-evidence"],
  assumptions: ["The return values are in INR."],
  openQuestions: [
    {
      id: "deadline-question",
      text: "Verify the response deadline against the original notice.",
      severity: "high",
      status: "open",
      resolutionNote: null,
      actorId: null,
      updatedAt: null,
    },
    {
      id: "year-question",
      text: "Confirm the assessment year.",
      severity: "medium",
      status: "resolved",
      resolutionNote: "Matched to the supplied return.",
      actorId: record.ownerId,
      updatedAt: record.updatedAt,
    },
  ],
  createdAt: record.createdAt,
};

function workspaceOf(): CaseWorkspace {
  return {
    case: record,
    documents: [
      {
        id: "notice-document",
        caseId: record.id,
        name: "notice.md",
        mimeType: "text/markdown",
        sizeBytes: 40,
        state: "ready",
        uploadedAt: record.createdAt,
        processedAt: record.updatedAt,
      },
    ],
    findings: [
      finding,
      { ...finding, id: "old-finding", title: "Stale previous-run finding" },
    ],
    evidence: [
      {
        id: "notice-evidence",
        kind: "document",
        caseId: record.id,
        documentId: "notice-document",
        sourceRef: "notice-document#page=2",
        confidence: "high",
        location: { page: 2, textQuote: "Notice income: 1,350,000" },
      },
      {
        id: "guidance-evidence",
        kind: "research",
        caseId: record.id,
        sourceRef: "https://www.incometax.gov.in/",
        confidence: "medium",
        citation: {
          title: "Official tax guidance",
          url: "https://www.incometax.gov.in/",
          claim: "Applicability requires professional verification.",
          span: "Official guidance excerpt for the professional reviewer.",
          retrievedAt: record.updatedAt,
        },
      },
    ],
    deliverables: [
      {
        id: "tax-deliverable",
        caseId: record.id,
        runId: "tax-run",
        version: 1,
        format: "document",
        title: "Tax notice response pack",
        summary: "Ready for professional review.",
        sections: [
          {
            id: "response-section",
            title: "Response draft and schedules",
            kind: "text",
            content: {
              summary: "Draft response for professional verification.",
              findings: [],
            },
            reviewerContent: null,
            reviewerId: null,
            reviewedAt: null,
            producingRole: "tax-notice-response-drafter",
            routingTier: "mid",
            provider: "mock",
            model: "mock-spark",
            findingIds: [finding.id],
            evidenceIds: finding.evidenceIds,
            reviewStatus: "pending",
            reviewComment: null,
          },
        ],
        createdAt: record.createdAt,
        updatedAt: record.updatedAt,
      },
    ],
    approvals: [],
  };
}

async function openWorkspace(page: Page, workspace: CaseWorkspace) {
  await page.route("**/intake/configuration", (route) =>
    route.fulfill({
      json: {
        workflows: ["data-analysis", "tax-notice"],
        uploadMaxBytes: 25 * 1024 * 1024,
        uploadMaxFiles: 5,
        documentMaxPages: 80,
      },
    }),
  );
  await page.route("**/auth/token", (route) =>
    route.fulfill({
      json: {
        accessToken: "tax-session",
        expiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
      },
    }),
  );
  await page.route("**/cases/**", async (route) => {
    if (new URL(route.request().url()).pathname.endsWith("/download")) {
      await route.fulfill({
        contentType: "text/plain",
        body: "Original private notice: income 1,350,000.",
      });
      return;
    }
    if (route.request().headers().accept !== "application/json") {
      await route.continue();
      return;
    }
    if (new URL(route.request().url()).pathname.endsWith("/runs/latest")) {
      await route.fulfill({ json: { run: null } });
      return;
    }
    await route.fulfill({ json: workspace });
  });
  await page.goto(`/cases/${record.id}`);
  await page.getByRole("button", { name: "Enter access key" }).click();
  await page.getByLabel("Access key").fill("test-key");
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
}

test("renders tax details and opens document and research evidence", async ({
  page,
}) => {
  await openWorkspace(page, workspaceOf());
  const findings = page.locator("section").filter({
    has: page.getByRole("heading", {
      name: "Findings and evidence",
      exact: true,
    }),
  });
  await expect(
    findings.getByRole("heading", { name: "Income reconciliation" }),
  ).toBeVisible();
  await expect(findings).toContainText(finding.description);
  await expect(findings).toContainText("80% confidence");
  await expect(findings).toContainText("The return values are in INR.");
  await expect(findings).toContainText(finding.openQuestions[0]!.text);
  await expect(findings).toContainText("high severity / open");
  await expect(findings).toContainText("medium severity / resolved");
  await expect(findings).toContainText("Matched to the supplied return.");
  await expect(
    page.getByText("Stale previous-run finding", { exact: true }),
  ).toHaveCount(0);
  await expect(page.getByLabel("Reviewer draft")).toHaveValue(
    "Draft response for professional verification.",
  );
  await findings
    .getByRole("button", { name: "Evidence: notice.md (page 2)" })
    .click();
  const evidence = page.getByRole("region", {
    name: "Review and evidence workspace",
  });
  await expect(
    evidence.getByText("Original private notice: income 1,350,000."),
  ).toBeVisible();
  await expect(
    evidence.locator("blockquote").filter({ hasText: "Notice income" }),
  ).toContainText("1,350,000");
  await findings
    .getByRole("button", { name: /^Evidence: Official tax guidance/ })
    .click();
  await expect(
    evidence.getByText("Applicability requires professional verification."),
  ).toBeVisible();
  await expect(
    evidence.getByText(
      "Official guidance excerpt for the professional reviewer.",
    ),
  ).toBeVisible();
  await expect(
    evidence.getByRole("link", { name: "Open cited source" }),
  ).toHaveAttribute("href", "https://www.incometax.gov.in/");
  await expect(evidence.getByText("Original private notice:")).toHaveCount(0);
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
});

test("shows empty and missing-evidence states without inventing results", async ({
  page,
}) => {
  const workspace = workspaceOf();
  workspace.findings = [];
  await openWorkspace(page, workspace);
  await expect(
    page.getByText("No findings are available for this deliverable yet."),
  ).toBeVisible();
  workspace.findings = [finding];
  workspace.evidence = [];
  await page.reload();
  await expect(
    page.getByRole("heading", { name: finding.title }),
  ).toBeVisible();
  await expect(
    page.getByText("Evidence unavailable: notice-evidence"),
  ).toBeVisible();
  await expect(
    page.getByText("Evidence unavailable: guidance-evidence"),
  ).toBeVisible();
});

test("exports the actual saved notice reply rather than the result summary", async ({
  page,
}) => {
  const workspace = workspaceOf();
  workspace.deliverables[0]!.sections[0]!.reviewerContent =
    "To the assessing officer: please verify the enclosed credit schedule.";
  await openWorkspace(page, workspace);
  const review = page.getByRole("region", {
    name: "Review and evidence workspace",
  });
  await review.getByLabel(/Export .*for Tax notice response pack/).click();
  await expect(
    review.getByRole("button", { name: /Download JSON/ }),
  ).toHaveCount(0);
  await expect(
    review.getByRole("button", { name: /Download Excel/ }),
  ).toHaveCount(0);
  const download = page.waitForEvent("download");
  await review.getByRole("button", { name: "Download PDF (.pdf)" }).click();
  const draft = await download;
  expect(draft.suggestedFilename()).toBe("tax-notice-response-pack-v1.pdf");
  const pdf = await readPdf(await readFile((await draft.path())!));
  expect(pdf.text).toContain(
    "To the assessing officer: please verify the enclosed credit schedule.",
  );
});
