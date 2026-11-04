# Business Data Analysis — Synthetic Case Pack

**Purpose:** Test the business data analyst workflow: upload a sales spreadsheet, get exact computed metrics, data-quality findings, a report and a dashboard whose charts and tables can be viewed full screen and downloaded as image or PDF.

**All data is synthetic.** The company, products, regions and every figure are invented for product testing. Amounts are in Indian rupees (INR).

## Case index and expected outcomes

| Case                                     | Input                  | Scenario                                                        | Key expected numbers                                                                |
| ---------------------------------------- | ---------------------- | --------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `case-01-clean-monthly-sales`            | `sales-data.csv`       | Clean FY 2025-26 monthly sales, festive-season peak             | 48 rows, total ₹13,254,400, top product Standing Desk ₹5,973,600, no quality issues |
| `case-02-messy-data-quality`             | `sales-data.csv`       | Missing, non-numeric, duplicate, negative and mixed-format data | 24 rows, total ₹1,570,900, six quality issue types                                  |
| `case-03-regional-concentration`         | `sales-data.csv`       | One region dominates revenue, another declines                  | 96 rows, total ₹11,896,300, North ₹6,958,900 (58.5%)                                |
| `case-04-weekly-spike-and-outage`        | `sales-data.csv`       | Promotional spike in week 11, online outage in week 15          | 60 rows, total ₹16,473,500, W11 +105.2%, W15 −36.3%                                 |
| `case-05-excel-workbook-multiple-sheets` | `quarterly-sales.xlsx` | Workbook with Summary, Sales Data and Targets sheets            | 40 rows from `Sales Data`, total ₹16,432,000, top category Furniture ₹7,962,900     |
| `case-06-unordered-campaign-periods`     | `sales-data.csv`       | Campaign names that cannot be ordered in time                   | 8 rows, total ₹2,880,000, no growth rates, unordered-periods issue                  |
| `case-07-no-sales-column`                | `inventory-counts.csv` | Stock counts only, no sales or amount column                    | Clear error, no invented sales figures                                              |

`case-index.json` holds the machine-readable expectations. `apps/api/test/data-analysis-test-cases.test.ts` runs every input through the real ingestion and deterministic analysis code and fails if a file or an expectation drifts.

## What the system should produce

1. **Report:** executive summary, exact totals and averages, period-over-period change, segment ranking, data-quality checks, assumptions and open questions.
2. **Dashboard:** bar, line and pie charts built from the computed aggregates, each with a "View chart data" table and a source reference (file, sheet, cell range, row range).
3. **Evidence:** every material finding points at columns and row ranges in the uploaded file.
4. **Full-screen view and downloads:** each chart and each data table opens full screen, and can be downloaded as an image (PNG) or a PDF. Table PDFs contain every row; table images show the first 200 rows and say so.

## Important interpretation rules

- The model never does arithmetic. Every number in the report must match the deterministic values in `expected-outcome.md`.
- Findings about causes (for example why week 11 spiked) are hypotheses. The data alone does not prove them, so the report should phrase them as questions for the business.
- Do not invent columns, periods or segments that are not in the file.
- Unknown or unusable values are reported and excluded, not silently repaired.

## Folder contents

Each case folder contains the input file, a `case-facts.md` with the business context and a suggested prompt, and an `expected-outcome.md` with the answer key. Never upload `expected-outcome.md` to the model during a blind test.

## Suggested evaluation rubric (0–2 points each)

- Totals, averages and segment ranking match the answer key exactly (0/1/2).
- Data-quality findings match the documented issues and source rows (0/1/2).
- Trends and anomalies are identified from computed values and not overstated (0/1/2).
- Charts render, and chart/table full-screen and image/PDF downloads work (0/1/2).
- Assumptions and open questions are honest about what the data cannot show (0/1/2).
