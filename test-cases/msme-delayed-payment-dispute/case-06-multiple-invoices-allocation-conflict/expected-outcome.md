# Expected outcome — Case 06

**Disposition:** `AGGREGATE_BALANCE_RECONCILED — INVOICE_ALLOCATION_AND_PENALTY_UNRESOLVED`

## Ground-truth calculations

- Invoice A: ₹118,000.
- Invoice B: ₹59,000.
- Combined gross: ₹177,000.
- Confirmed payments: ₹50,000 + ₹25,000 = ₹75,000.
- Supported credit notes: ₹0.
- **Aggregate candidate principal outstanding: ₹102,000.**
- Separate asserted penalty: ₹25,000, unsupported by the supplied PO and not acknowledged by supplier. Do not net it off.

## Expected findings

1. The total remaining principal is unambiguous: ₹177,000 − ₹75,000 = ₹102,000.
2. Invoice-level allocation is ambiguous because the supplier and buyer ledgers allocate the ₹50,000 payment differently and no remittance advice is included.
3. Per-invoice remaining balance, invoice-specific overdue days and any interest calculation should remain provisional until payment allocation is confirmed.
4. The ₹25,000 penalty is a dispute to investigate, not an established adjustment.

## Recommended next step

Request remittance advices for both payments and ask the buyer to confirm allocation in writing. Request the contractual basis and evidence supporting the ₹25,000 penalty. Provide an aggregate reconciliation now and a provisional invoice-level table clearly labelled “allocation unconfirmed.”

## Must-not-do assertions

- Do not allocate the ₹50,000 payment silently to whichever invoice maximizes interest.
- Do not subtract the unsupported ₹25,000 penalty.
- Do not produce precise interest figures while allocation and legal inputs remain unresolved.
