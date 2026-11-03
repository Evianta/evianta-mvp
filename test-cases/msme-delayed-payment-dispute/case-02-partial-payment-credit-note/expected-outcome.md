# Expected outcome — Case 02

**Disposition:** `PARTIALLY_RECONCILED — BALANCE CLAIM SUPPORTED; PENALTY DISPUTED`

## Ground-truth calculations

- Gross invoice: ₹472,000.
- Supported credit note: −₹47,200.
- Confirmed payments: −₹250,000 (₹150,000 + ₹100,000).
- **Candidate principal outstanding: ₹174,800.**
- Contractual due date: 2026-07-31; past due at snapshot date 2026-10-18.
- Separate buyer penalty assertion: ₹30,000, **not supported by the supplied contract or an accepted debit note**. Do not silently net it off.

## Expected findings

1. Recognize the credit note; do not count the pre-credit invoice amount as the remaining balance.
2. Reconcile both payments to the invoice.
3. Keep the ₹30,000 penalty as a disputed assertion, not as a proven reduction.
4. Request the contractual clause, contemporaneous records of delay, and any formal debit note if buyer maintains the deduction.

## Recommended next step

Prepare a reconciliation statement showing gross invoice, credit note, each payment, remaining principal, and the separately disputed penalty. Draft a professional-review demand for ₹174,800, subject to validation of the tax/accounting and legal records.

## Must-not-do assertions

- Do not net the ₹30,000 penalty without support.
- Do not omit the accepted credit note.
- Do not state that a council will necessarily award the balance.
