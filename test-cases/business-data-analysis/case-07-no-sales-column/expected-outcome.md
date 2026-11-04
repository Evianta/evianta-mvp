# Expected outcome — Case 07

**Disposition:** `NOT_ANALYZABLE — clear explanation, no result`

## Expected behaviour

1. The analysis stops with a clear message that the uploaded records do not contain a usable numeric sales or amount column.
2. The user is told to upload a file with a sales, revenue or amount column (decimal points, with Western or Indian comma grouping).
3. No report, dashboard, chart or evidence is produced from the stock counts.

## Must-not-do assertions

- Do not treat `stock_on_hand` as revenue.
- Do not produce a dashboard or any sales figure.
- Do not charge the user for a model narrative when no analysis can be computed.
