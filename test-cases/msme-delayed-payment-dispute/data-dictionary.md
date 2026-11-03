# Data dictionary

- `case-facts.md`: narrative case intake and snapshot date.
- `purchase_order*.md`: written commercial terms, quantity, price and due-date terms.
- `invoice*.md`: invoice line totals, tax shown, gross total and any recorded due date.
- `delivery-acceptance.md`: delivery, goods receipt, acceptance or rejection evidence.
- `payment-ledger.csv` / `payments.csv`: confirmed payment records and allocation evidence.
- `supplier-registration.md`: fictional enterprise classification and registration timing.
- `buyer-communications.md` and other email files: relevant acknowledgments, disputes and assertions.
- `credit-note.md`: supported adjustment document when applicable.
- `expected-outcome.md`: ground truth and qualitative output tests.
- `case-index.json`: machine-readable summary for test harnesses.

Expected numeric values are in INR and are integer rupee amounts. Keep legal status separate from arithmetic status: a reconciled balance does not by itself establish statutory eligibility, entitlement to interest, admissibility, or eventual outcome.
