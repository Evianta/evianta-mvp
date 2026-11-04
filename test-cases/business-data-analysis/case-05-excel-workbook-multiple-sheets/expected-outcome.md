# Expected outcome — Case 05

**Disposition:** `CLEAN_DATA — correct sheet selected, steady growth`

## Ground-truth calculations

- Sheet analyzed: **`Sales Data`**, cells `A2:C41`, source rows 2–41. The `Summary` and `Targets` sheets must not feed the totals.
- Rows analyzed: **40**. Value column: `revenue`. Period column: `quarter`. Segment column: `category`.
- Total revenue: **₹16,432,000**. Average per row: **₹410,800**.
- Quarterly revenue: 2024-Q1 ₹1,820,400; Q2 ₹1,897,800 (+4.3%); Q3 ₹1,962,400 (+3.4%); Q4 ₹2,019,000 (+2.9%); 2025-Q1 ₹2,080,800 (+3.1%); Q2 ₹2,164,500 (+4.0%); Q3 ₹2,216,500 (+2.4%); Q4 ₹2,270,600 (+2.4%).
- Category ranking: Furniture ₹7,962,900 (48.5%), Storage ₹3,075,400, Lighting ₹2,347,100, Accessories ₹1,697,300, Software ₹1,349,300.
- Data-quality issues: none.

## Expected findings

1. Revenue grows every quarter, with growth between 2.4% and 4.3%.
2. Furniture accounts for roughly half of all revenue.
3. Evidence cites `quarterly-sales.xlsx`, sheet `Sales Data`, and the cell range above.

## Must-not-do assertions

- Do not mix target values into revenue or compare to targets. The targets sheet is not part of the analysis.
- Do not cite the wrong sheet in evidence.
