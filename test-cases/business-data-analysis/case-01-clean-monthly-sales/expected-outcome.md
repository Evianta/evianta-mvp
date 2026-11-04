# Expected outcome — Case 01

**Disposition:** `CLEAN_DATA — report and dashboard with no data-quality findings`

## Ground-truth calculations

- Rows analyzed: **48**. Value column: `revenue`. Period column: `month`. Segment column: `product`.
- Total revenue: **₹13,254,400**. Average per row: **₹276,133.33**.
- Product ranking: Standing Desk ₹5,973,600 (45.1%), Office Chair ₹4,421,800, Monitor Arm ₹1,711,000, Desk Lamp ₹1,148,000.
- Monthly revenue: Apr ₹926,700; May ₹919,200 (−0.8%); Jun ₹962,200 (+4.7%); Jul ₹1,022,800 (+6.3%); Aug ₹1,044,700 (+2.1%); Sep ₹1,119,500 (+7.2%); **Oct ₹1,348,800 (+20.5%)**; Nov ₹1,331,900 (−1.3%); **Dec ₹1,134,700 (−14.8%)**; Jan ₹1,107,300 (−2.4%); Feb ₹1,095,800 (−1.0%); Mar ₹1,240,800 (+13.2%).
- Data-quality issues: none.

## Expected findings

1. Revenue peaks in October and stays high in November, then falls sharply in December.
2. Standing Desk is the largest product by revenue, with Office Chair second.
3. Revenue recovers in March.
4. Evidence cites `sales-data.csv`, columns `month, product, units, revenue`, rows 2–49.

## Dashboard checks

- A monthly bar and line chart with 12 points, and a product pie chart with 4 slices.
- Each chart opens full screen; image and PDF downloads work; "View chart data" tables match the numbers above.

## Must-not-do assertions

- Do not report any data-quality issue.
- Do not state why October peaked as a fact. The data does not contain the reason.
- Do not change any figure above.
