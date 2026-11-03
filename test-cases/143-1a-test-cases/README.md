# Evianta Test Pack — Proposed Adjustment Notice under Section 143(1)(a)

**Dataset purpose:** synthetic test material for evaluating an AI workflow that reviews a proposed income-tax return adjustment, reconciles source documents, recommends Agree/Disagree/Partially Agree, drafts a cautious response, and identifies evidence gaps.

## What's included

- `input-cases/`: six case folders containing only the evidence the agent should read first.
- `expected-outcomes/`: evaluator answer keys. Keep this folder hidden from the model during a blind test; reveal it only after the run.
- `case-index.csv`: quick map of the six scenarios.
- `reference-notes.md`: official public references and scope notes.
- `evaluation-rubric.json`: repeatable scoring rubric.
- `agent-run-template.md`: prompt template for testing the same workflow consistently.

## Important dataset assumptions

- **Every taxpayer, employer, transaction, amount, notice, document and identifier in this pack is fictional.** Nothing here is a real tax notice or tax advice.
- Cases are framed for **AY 2025–26 / FY 2024–25** and use the legacy Income-tax Act, 1961 label **Section 143(1)(a)**. This keeps the examples aligned with the requested notice type; actual notices and current portal terminology must be checked against the applicable tax year and the notice actually issued.
- Synthetic notice issue date: **15 October 2026**. The generated notice states a response date of **14 November 2026** using the general 30-day period described in the Income Tax Department's help page. For a real matter, use the deadline and status displayed on the official portal and consult a qualified tax professional.
- The expected outcomes are benchmark answers, not legal opinions. In particular, the tax-audit case flags possible statutory conditions and evidence that need professional verification.
- Do not upload these sample files to the Income Tax Department or use them to submit a real response.

## Suggested evaluation method

1. Copy **only one** folder from `input-cases/` into the agent's case workspace.
2. Ask the agent to summarize the proposed adjustment, reconcile every relevant figure, identify missing evidence, recommend a response option, and draft a concise response for professional review.
3. Record the output before opening `expected-outcomes/`.
4. Score it using `evaluation-rubric.json`.

The key test is not whether the agent sounds confident. It is whether the recommendation follows the evidence, distinguishes a correct adjustment from a false positive, and avoids inventing facts or tax consequences.
