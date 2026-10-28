import { z } from "zod";
import type { z as Zod } from "zod";

import { CaseSchema, DocumentMetadataDtoSchema } from "./domain.js";

const ChecklistItemSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
});

const SeededErrorSchema = z.object({
  id: z.string().min(1),
  description: z.string().min(1),
  expectedCaught: z.boolean(),
});

const commonFixtureFields = {
  case: CaseSchema.refine(
    (record) => record.isSample && record.synthetic && record.ownerId === null,
    { message: "Fixtures must be synthetic, ownerless public samples" },
  ),
  documents: z.array(DocumentMetadataDtoSchema),
  input: z.record(z.string(), z.unknown()),
  checklist: z.array(ChecklistItemSchema).min(1),
  seededErrors: z.array(SeededErrorSchema),
};

const validateFixtureReferences = (
  fixture: {
    case: Zod.infer<typeof CaseSchema>;
    documents: Zod.infer<typeof DocumentMetadataDtoSchema>[];
  },
  context: Zod.RefinementCtx,
) => {
  for (const [index, document] of fixture.documents.entries()) {
    if (document.caseId !== fixture.case.id) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Fixture documents must reference their fixture case",
        path: ["documents", index, "caseId"],
      });
    }
  }
};

export const DataAnalysisFixtureSchema = z
  .object({
    ...commonFixtureFields,
    expected: z.object({
      totalRevenue: z.number().finite(),
      revenueByMonth: z.array(
        z.object({ month: z.string().min(1), revenue: z.number().finite() }),
      ),
      growthPercentByMonth: z.array(z.number().finite()),
      topProduct: z.string().min(1),
      rowCount: z.number().int().nonnegative(),
    }),
  })
  .superRefine((fixture, context) => {
    validateFixtureReferences(fixture, context);
    if (fixture.case.useCase !== "data-analysis") {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Fixture case must use the data-analysis workflow",
        path: ["case", "useCase"],
      });
    }
  });

export const TaxNoticeFixtureSchema = z
  .object({
    ...commonFixtureFields,
    expected: z.object({
      returnedIncome: z.number().finite(),
      noticedIncome: z.number().finite(),
      incomeDifference: z.number().finite(),
      claimedCredit: z.number().finite(),
      availableCredit: z.number().finite(),
      creditDifference: z.number().finite(),
      requiresProfessionalReview: z.boolean(),
    }),
  })
  .superRefine((fixture, context) => {
    validateFixtureReferences(fixture, context);
    if (fixture.case.useCase !== "tax-notice") {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Fixture case must use the tax-notice workflow",
        path: ["case", "useCase"],
      });
    }
  });

export const MsmePaymentFixtureSchema = z
  .object({
    ...commonFixtureFields,
    expected: z.object({
      invoiceTotal: z.number().finite(),
      paymentsTotal: z.number().finite(),
      outstanding: z.number().finite(),
      missingDocuments: z.array(z.string()),
      disputedInvoiceIds: z.array(z.string()),
    }),
  })
  .superRefine((fixture, context) => {
    validateFixtureReferences(fixture, context);
    if (fixture.case.useCase !== "msme-payment") {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Fixture case must use the msme-payment workflow",
        path: ["case", "useCase"],
      });
    }
  });

export const SyntheticWorkflowFixtureSchema = z.union([
  DataAnalysisFixtureSchema,
  TaxNoticeFixtureSchema,
  MsmePaymentFixtureSchema,
]);
