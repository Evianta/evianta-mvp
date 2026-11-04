# Expected outcome — Case 04

**Disposition:** `ANOMALIES_PRESENT — one spike and one drop to surface`

## Ground-truth calculations

- Rows analyzed: **60**. Value column: `revenue` (`orders` is not a sales amount). Period column: `week`. Segment column: `channel`.
- Total revenue: **₹16,473,500**.
- Channel ranking: Wholesale ₹6,619,500, Online ₹5,877,800, Retail ₹3,976,200.
- Weekly totals around the anomalies: W10 ₹797,500; **W11 ₹1,636,700 (+105.2%)**; W12 ₹810,000 (−50.5%); W14 ₹823,400; **W15 ₹524,700 (−36.3%)**; W16 ₹837,300 (+59.6%).
- Data-quality issues: none.

## Supporting values from the file (for evaluators)

- Online revenue: W10 ₹268,000; W11 ₹1,102,200; W12 ₹263,000.
- Online revenue in W15 is ₹22,700 while Retail (₹188,900) and Wholesale (₹313,100) stay near normal.

## Expected findings

1. Week 11 is a one-week spike, driven by the Online channel.
2. Week 15 is a sharp drop, driven almost entirely by the Online channel.
3. Outside those weeks revenue grows slowly and steadily (about 1–2% a week).
4. The weeks after each anomaly are reported as a return to the trend, not as growth or decline in their own right.

## Dashboard checks

- Weekly line chart with 20 points showing both anomalies clearly, full screen and downloadable as image and PDF.

## Must-not-do assertions

- Do not state causes such as a flash sale or a website outage as fact. Ask what happened in W11 and W15.
- Do not include W12 and W16 as separate anomalies.
