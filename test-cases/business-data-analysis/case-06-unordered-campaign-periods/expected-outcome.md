# Expected outcome — Case 06

**Disposition:** `UNORDERED_PERIODS — totals reported, no trend or growth`

## Ground-truth calculations

- Rows analyzed: **8**. Value column: `revenue`. Period column: `campaign_period`. Segment column: `channel`.
- Total revenue: **₹2,880,000**. Average per row: **₹360,000**.
- Campaign totals (source order): Summer Sale ₹670,000; Monsoon Clearance ₹420,000; Festive Launch ₹1,160,000; Year-End Offer ₹630,000.
- Channel ranking: Online ₹1,630,000, Retail ₹1,250,000.
- Data-quality issue: `unordered-periods` on rows 2–9.

## Expected behaviour

1. The report says period labels cannot be ordered, so growth rates and a trend line are omitted.
2. Festive Launch is described as the strongest campaign by total revenue, which is a ranking, not a trend.
3. Online leads Retail overall.

## Must-not-do assertions

- Do not compute period-over-period growth between campaigns.
- Do not assume the campaigns happened in the order listed in the file.
