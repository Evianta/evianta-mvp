import {
  DataAnalysisFixtureSchema,
  MsmePaymentFixtureSchema,
  SyntheticWorkflowFixtureSchema,
  TaxNoticeFixtureSchema,
} from "./fixture-schemas.js";
import { CaseSchema, DocumentMetadataDtoSchema } from "./domain.js";
import type { z } from "zod";

const createdAt = "2026-01-15T00:00:00.000Z";
const emptyUsage = {
  inputUnits: 0,
  outputUnits: 0,
  totalUnits: 0,
  costUsd: 0,
  costStatus: "estimated" as const,
  reservedUsd: 0,
};

const baseDocument = {
  caseId: "",
  sizeBytes: 1200,
  state: "ready" as const,
  uploadedAt: createdAt,
  processedAt: createdAt,
};

const sampleCase = (input: {
  id: string;
  title: string;
  description: string;
  useCase: "data-analysis" | "tax-notice" | "msme-payment";
}) =>
  CaseSchema.parse({
    ...input,
    ownerId: null,
    isSample: true,
    synthetic: true,
    sourceCaseId: null,
    status: "active",
    usage: emptyUsage,
    createdAt,
    updatedAt: createdAt,
  });

const document = (input: {
  id: string;
  caseId: string;
  name: string;
  mimeType: "text/csv" | "application/pdf";
}) =>
  DocumentMetadataDtoSchema.parse({
    ...baseDocument,
    ...input,
  });

export const syntheticWorkflowFixtures = {
  dataAnalysis: DataAnalysisFixtureSchema.parse({
    case: sampleCase({
      id: "sample-sales-quarter",
      title: "Quarterly sales review",
      description: "Synthetic sales rows for deterministic metric checks.",
      useCase: "data-analysis",
    }),
    documents: [
      document({
        id: "sales-transactions",
        caseId: "sample-sales-quarter",
        name: "quarterly-sales.csv",
        mimeType: "text/csv",
      }),
    ],
    input: {
      columns: ["month", "product", "revenue"],
      rows: [
        { month: "Jan", product: "A", revenue: 100 },
        { month: "Jan", product: "B", revenue: 150 },
        { month: "Feb", product: "A", revenue: 120 },
        { month: "Feb", product: "B", revenue: 180 },
        { month: "Mar", product: "A", revenue: 200 },
        { month: "Mar", product: "B", revenue: 250 },
      ],
    },
    expected: {
      totalRevenue: 1000,
      revenueByMonth: [
        { month: "Jan", revenue: 250 },
        { month: "Feb", revenue: 300 },
        { month: "Mar", revenue: 450 },
      ],
      growthPercentByMonth: [20, 50],
      topProduct: "B",
      rowCount: 6,
    },
    checklist: [
      { id: "revenue-total", title: "Revenue total matches source rows" },
      { id: "monthly-trend", title: "Monthly totals and growth are exact" },
      { id: "claim-evidence", title: "Material claims link to source rows" },
    ],
    seededErrors: [
      {
        id: "wrong-quarter-total",
        description:
          "A generated report total differs from the computed total.",
        expectedCaught: true,
      },
    ],
  }),
  taxNotice: TaxNoticeFixtureSchema.parse({
    case: sampleCase({
      id: "sample-tax-notice",
      title: "Synthetic income-tax notice",
      description: "Synthetic notice and return figures for reconciliation.",
      useCase: "tax-notice",
    }),
    documents: [
      document({
        id: "notice-document",
        caseId: "sample-tax-notice",
        name: "notice-summary.pdf",
        mimeType: "application/pdf",
      }),
      document({
        id: "return-document",
        caseId: "sample-tax-notice",
        name: "return-and-credit-summary.csv",
        mimeType: "text/csv",
      }),
    ],
    input: {
      returnedIncome: 1_200_000,
      noticedIncome: 1_350_000,
      claimedCredit: 80_000,
      availableCredit: 75_000,
      records: [
        { source: "return", figure: 1_200_000 },
        { source: "notice", figure: 1_350_000 },
      ],
    },
    expected: {
      returnedIncome: 1_200_000,
      noticedIncome: 1_350_000,
      incomeDifference: 150_000,
      claimedCredit: 80_000,
      availableCredit: 75_000,
      creditDifference: 5_000,
      requiresProfessionalReview: true,
    },
    checklist: [
      {
        id: "income-reconciliation",
        title: "Income difference cites both records",
      },
      { id: "credit-reconciliation", title: "Credit difference is surfaced" },
      {
        id: "research-verification",
        title: "Legal research is marked for verification",
      },
      { id: "no-filing", title: "No filing action is performed" },
    ],
    seededErrors: [
      {
        id: "wrong-income-difference",
        description:
          "A response schedule contains an incorrect income difference.",
        expectedCaught: true,
      },
    ],
  }),
  msmePayment: MsmePaymentFixtureSchema.parse({
    case: sampleCase({
      id: "sample-msme-overdue",
      title: "Synthetic delayed-payment case",
      description: "Synthetic invoices and payments with one partial payment.",
      useCase: "msme-payment",
    }),
    documents: [
      document({
        id: "invoice-records",
        caseId: "sample-msme-overdue",
        name: "invoices.csv",
        mimeType: "text/csv",
      }),
      document({
        id: "payment-records",
        caseId: "sample-msme-overdue",
        name: "payments.csv",
        mimeType: "text/csv",
      }),
      document({
        id: "correspondence-record",
        caseId: "sample-msme-overdue",
        name: "correspondence.pdf",
        mimeType: "application/pdf",
      }),
    ],
    input: {
      invoices: [
        { id: "INV-001", amount: 100_000, date: "2025-11-01" },
        { id: "INV-002", amount: 50_000, date: "2025-11-15" },
      ],
      payments: [
        { id: "PAY-001", invoiceId: "INV-001", amount: 40_000 },
        { id: "PAY-002", invoiceId: "INV-002", amount: 20_000 },
      ],
      correspondenceDates: ["2025-11-20", "2025-12-01"],
    },
    expected: {
      invoiceTotal: 150_000,
      paymentsTotal: 60_000,
      outstanding: 90_000,
      missingDocuments: ["delivery-confirmation"],
      disputedInvoiceIds: [],
    },
    checklist: [
      {
        id: "balance",
        title: "Outstanding amount is computed from confirmed records",
      },
      {
        id: "chronology",
        title: "Chronology links entries to source documents",
      },
      {
        id: "missing-evidence",
        title: "Missing delivery confirmation is surfaced",
      },
      { id: "no-escalation", title: "No escalation action is performed" },
    ],
    seededErrors: [
      {
        id: "omitted-partial-payment",
        description:
          "A balance omits the partial payment on the first invoice.",
        expectedCaught: true,
      },
    ],
  }),
} as const satisfies Record<
  string,
  z.infer<typeof SyntheticWorkflowFixtureSchema>
>;

export { SyntheticWorkflowFixtureSchema } from "./fixture-schemas.js";
export type SyntheticWorkflowFixture = z.infer<
  typeof SyntheticWorkflowFixtureSchema
>;
