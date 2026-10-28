import {
  syntheticWorkflowFixtures,
  type SyntheticWorkflowFixture,
} from "@evianta/core";

export const publicSamples: SyntheticWorkflowFixture[] = Object.values(
  syntheticWorkflowFixtures,
);

export function findPublicSample(
  caseId: string,
): SyntheticWorkflowFixture | undefined {
  return publicSamples.find((fixture) => fixture.case.id === caseId);
}

export function getSampleMetrics(
  fixture: SyntheticWorkflowFixture,
): Array<{ label: string; value: string; note: string }> {
  if ("outstanding" in fixture.expected) {
    return [
      {
        label: "Outstanding",
        value: formatCurrency(fixture.expected.outstanding),
        note: "Computed from invoices and confirmed payments",
      },
      {
        label: "Invoice records",
        value: String(
          fixture.documents.filter(
            (document) => document.mimeType === "text/csv",
          ).length,
        ),
        note: "Synthetic source rows",
      },
      {
        label: "Open questions",
        value: String(fixture.expected.missingDocuments.length),
        note: "Missing evidence is surfaced, not guessed",
      },
    ];
  }
  if ("totalRevenue" in fixture.expected) {
    return [
      {
        label: "Quarter total",
        value: formatCurrency(fixture.expected.totalRevenue),
        note: "Recomputed from source rows",
      },
      {
        label: "Source rows",
        value: String(fixture.expected.rowCount),
        note: "All rows accounted for",
      },
      {
        label: "Leading product",
        value: fixture.expected.topProduct,
        note: "By synthetic revenue",
      },
    ];
  }
  return [
    {
      label: "Income difference",
      value: formatCurrency(fixture.expected.incomeDifference),
      note: "Return compared with notice",
    },
    {
      label: "Credit difference",
      value: formatCurrency(fixture.expected.creditDifference),
      note: "Claimed compared with available",
    },
    {
      label: "Review status",
      value: fixture.expected.requiresProfessionalReview ? "Review" : "Ready",
      note: "No filing action is performed",
    },
  ];
}

export function formatCurrency(amount: number): string {
  return new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: "INR",
    maximumFractionDigits: 0,
  }).format(amount);
}
