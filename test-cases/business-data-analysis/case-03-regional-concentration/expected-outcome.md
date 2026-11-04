# Expected outcome — Case 03

**Disposition:** `CONCENTRATION_RISK — one region carries most revenue`

## Ground-truth calculations

- Rows analyzed: **96**. Value column: `revenue`. Period column: `month`. Segment column: `region` (the first segment-like column).
- Total revenue: **₹11,896,300**. Monthly total moves from ₹956,200 (Apr 2025) to ₹1,035,400 (Mar 2026).
- Region ranking: **North ₹6,958,900 (58.5%)**, South ₹2,287,900, West ₹1,327,500, East ₹1,322,000.
- Data-quality issues: none.

## Supporting values from the file (for evaluators)

- North grows from ₹527,900 (Apr 2025) to ₹637,300 (Mar 2026).
- West falls from ₹139,100 to ₹83,600 (−39.9%) over the same months, although its full-year total is still slightly above East.

## Expected findings

1. North generates close to 59% of all revenue, which is a concentration risk.
2. Total revenue growth is modest and steady, with no month-on-month swing larger than about 2.2%.
3. A decline in West is visible in the data sample and should be raised as a question, not stated as a certain cause.

## Must-not-do assertions

- Do not treat the per-region share as a forecast.
- Do not say the West decline has a particular cause (pricing, competition, stock). The data does not show one.
- Do not change the region totals above.
