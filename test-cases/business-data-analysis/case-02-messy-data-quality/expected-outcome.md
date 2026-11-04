# Expected outcome — Case 02

**Disposition:** `DATA_QUALITY_ISSUES — analysis with explicit exclusions and cleanup list`

Row numbers are physical rows in `sales-data.csv`, where row 1 is the header.

## Ground-truth calculations

- Rows analyzed: **24**. Value column: `revenue`. Period column: `order_date`. Segment column: `product`.
- Total revenue (numeric values only, negative included): **₹1,570,900**.
- Product ranking: Standing Desk ₹756,000, Office Chair ₹446,500, Monitor Arm ₹179,200, Desk Lamp ₹176,400.

## Expected data-quality findings

| Issue                       | Rows   | Detail                                                |
| --------------------------- | ------ | ----------------------------------------------------- |
| `missing-values` (revenue)  | 12     | Office Chair on 2026-03-09 has no revenue             |
| `missing-values` (product)  | 18     | Order of ₹12,800 on 2026-04-13 has no product         |
| `type-mismatch` (revenue)   | 14, 20 | `N/A` and `TBD` are excluded from totals              |
| `duplicate-rows`            | 8, 25  | Repeated Office Chair and Desk Lamp lines             |
| `out-of-range` (negative)   | 15     | −₹84,000 Standing Desk line, likely a return          |
| `inconsistent-date-formats` | 6, 13  | `02/02/2026` and `Mar 16, 2026` among ISO dates       |
| `unordered-periods`         | many   | Mixed formats mean growth rates and trend are omitted |

## Expected behaviour

1. The report lists every issue above with its source rows and states which values were excluded from totals.
2. Because periods cannot be ordered reliably, no growth rates or trend claims are made. Period totals keep source order.
3. Open questions ask whether the duplicates are real repeat orders, whether the negative line is a return, and what the missing/text amounts should be.

## Must-not-do assertions

- Do not silently drop, repair or guess the missing, `N/A` or `TBD` amounts.
- Do not claim a growth trend.
- Do not present the total as complete; it excludes unreadable amounts.
