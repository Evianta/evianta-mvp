# MSME Delayed-Payment Dispute — Synthetic Case Pack

**Purpose:** Test a professional-workflow assistant that examines invoices, purchase orders, delivery/acceptance evidence, payment records and communications; reconciles the claim; identifies gaps; and prepares a review-ready case summary.

**All data is synthetic.** All businesses, people, identifiers, transactions, emails and document numbers are invented for product testing. IDs starting with `SYNTH-` are placeholders, not valid government identifiers. Do not file these examples or represent them as real cases.

## Case index and expected outcomes

| Case                                            | Scenario                                                                     | Expected disposition                                                                              |                                     Principal reconciliation |
| ----------------------------------------------- | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- | -----------------------------------------------------------: |
| `case-01-clear-overdue`                         | Accepted goods, clear terms, no payment                                      | Strong evidence of overdue invoice; prepare demand/case pack for professional review              |                                         ₹236,000 outstanding |
| `case-02-partial-payment-credit-note`           | Partial payments, valid credit note, unsupported penalty                     | Reconcile supported credit note and payments; flag penalty as disputed/unsubstantiated            | ₹174,800 outstanding before any separately proven adjustment |
| `case-03-quality-dispute`                       | 20% goods rejected and supplier promised a credit note                       | Do not present full balance as an uncontested overdue debt; resolve credit-note/replacement issue |                                            ₹70,800 contested |
| `case-04-delivery-proof-missing`                | Invoice and dispatch records, but no proof of delivery or acceptance         | Evidence gap; do not assert that contractual/Section 15 due date is established                   |                        ₹212,400 claimed, acceptance unproven |
| `case-05-registration-after-supply`             | Work accepted and unpaid, but Udyam registration post-dates supply           | Contract debt can be reconciled; MSMED-specific eligibility is a legal-review blocker             |                                             ₹118,000 claimed |
| `case-06-multiple-invoices-allocation-conflict` | Two invoices, two payments with conflicting allocations, unsupported set-off | Reconcile aggregate principal; request remittance advice before invoice-level aging/interest      |       ₹102,000 aggregate outstanding before disputed penalty |

Snapshot date used in these cases: **18 October 2026**. Amounts are in Indian rupees (INR). Monetary arithmetic is the expected ground truth for this dataset; legal eligibility, limitation, jurisdiction and statutory interest require a qualified review against the facts and current law.

## What the system should produce for each case

1. **Case summary:** supplier, buyer, transaction, snapshot date, claim amount and current status.
2. **Evidence inventory:** PO/contract, invoice(s), delivery/acceptance proof, payment ledger, credit/debit notes and communications.
3. **Reconciliation:** invoice gross amount − supported credit notes − confirmed payments = candidate principal outstanding. Keep disputed amounts and unsupported offsets separate.
4. **Timeline:** order, supply, acceptance or disputed acceptance, invoice, due date if determinable, payments, dispute notices and snapshot date.
5. **Eligibility/evidence checks:** enterprise type and registration timing; proof of supply/acceptance; written payment terms; buyer identity; payment allocation; dispute/credit-note documents.
6. **Expected disposition:** strong / needs reconciliation / contested / evidence incomplete / legal eligibility review required.
7. **Next actions:** specific document requests and a draft factual demand or escalation pack only where appropriate. Never submit externally without user authorization.
8. **Interest:** do not invent a fixed interest rate. If computing MSMED Act interest, first verify eligibility, applicable dates, RBI bank-rate inputs for relevant periods, payment allocation and governing law; clearly label assumptions and calculation method.

## Important interpretation rules

- Section 15 of the Micro, Small and Medium Enterprises Development Act, 2006 caps a written payment period at 45 days from acceptance/deemed acceptance. Section 16 addresses compound interest with monthly rests at three times the RBI-notified bank rate, subject to the Act and case facts. Read the Act and obtain professional review; the dataset does not calculate statutory interest.
- An invoice by itself is not always enough to prove delivery or acceptance. Do not infer acceptance from dispatch alone.
- An unsupported unilateral penalty or set-off is not automatically a valid reduction of the invoice. Surface the assertion and ask for the contractual basis and supporting records.
- A genuine credit note and confirmed payments must reduce the candidate principal balance.
- For post-supply registration or unclear enterprise classification, do not promise MSMED-specific relief. Mark the issue for legal review. An ordinary contractual recovery question is separate from statutory eligibility.
- “Expected outcome” means the intended output of the software on this synthetic evidence pack, not a prediction of a tribunal/council decision.

## Folder contents

Each case folder contains a `case-facts.md`, source-style documents, one or more CSV/JSON records where helpful, and an `expected-outcome.md` with test assertions. Files intentionally include realistic ambiguity in Cases 3–6.

## Suggested evaluation rubric (0–2 points each)

- Principal reconciliation is arithmetically correct (0/1/2).
- Timeline and due-date reasoning is grounded in written evidence (0/1/2).
- Distinguishes accepted, disputed and unproven amounts (0/1/2).
- Identifies registration/eligibility or legal-review flags (0/1/2).
- Requests the right missing evidence (0/1/2).
- Avoids unsupported legal certainty, fabricated interest and unauthorized filing (0/1/2).

Maximum: 12 points per case. A strong result should explain the evidence behind the result, not merely output a number.

## Legal/reference sources for demo context

These links are references for designing the screening checklist, not case-specific legal opinions:

- **India Code — Micro, Small and Medium Enterprises Development Act, 2006 (official Act PDF):** https://www.indiacode.nic.in/bitstream/123456789/5872/1/a2006-27.pdf
- **Government of India — MSME Delayed Payment / ODR portal:** https://odr.msme.gov.in/seller/
- **Ministry of MSME — MSME Samadhaan overview:** https://ramp.msme.gov.in/ramp/RAMP-initiative/msme-samadhaan/msme-samadhaan
- **Government Services Portal — MSME Samadhaan:** https://services.india.gov.in/service/detail/msme-samadhaan-delayed-payment-monitoring-system

This pack is a software test fixture, not legal, tax or accounting advice. Verify current legislation, notifications, case law, eligibility, limitation, territorial jurisdiction and interest inputs with a qualified professional before real-world use.
