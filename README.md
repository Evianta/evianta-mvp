# Evianta MVP

The repository is a pnpm TypeScript monorepo. It currently provides the build,
test and package boundaries for the implementation roadmap; workflow features
are added in their respective work packages.

## Requirements

- Node.js `24.3.0` (see `.node-version`)
- pnpm `10.18.3` (pinned by the root `package.json`)

Install dependencies and run the repository gates:

```sh
corepack enable
pnpm install --frozen-lockfile
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

`pnpm test` builds workspace packages first so tests also verify imports through
their public package entry points. Tests use local fixtures and do not contact
cloud services or model providers.

## Workspace responsibilities

| Path                 | Current boundary and planned ownership                                |
| -------------------- | --------------------------------------------------------------------- |
| `packages/core`      | Shared domain schemas, ports and synthetic workflow fixtures          |
| `packages/env`       | Server-side environment and storage configuration validation          |
| `packages/store`     | MongoDB repositories and private document storage adapters            |
| `packages/ai`        | Muse/mock provider adapters, structured output and usage boundary     |
| `packages/agents`    | LangGraph planning, specialist execution, review and run recovery     |
| `packages/ingestion` | Document parsing, text-layer and admitted OCR extraction with caching |
| `apps/api`           | Express API, access-key authentication and admin CLI                  |
| `apps/web`           | Web application boundary; UI features come in the web work pack       |

Keep shared types in `core`, environment reads in `env`, persistence in
`store`, and provider access in `ai`. Use `workspace:*` for internal
dependencies. Keep tests deterministic and isolated from real credentials,
cloud resources and model traffic. Add each feature with its own focused tests;
do not add placeholder product behavior to a package boundary.

The AI package defaults to the deterministic mock provider. Live Muse requests
require server-side model credentials, enforced usage limits, an active
versioned price record, and `createAdmittedUsageAccounting` backed by the store
repositories. The accounting adapter reserves a conservative allowance before
dispatch, records each attempt, and settles only when cost can be estimated.
Attempts with unknown provider usage keep their reservation as explicit
exposure; they are not silently treated as free. Streaming calls remain
reserved when the provider does not return usage details.

Set `EVIANTA_USAGE_MODE=enforced` for live use and configure every
`MODEL_MAX_*`, concurrency, spend, and period value in `.env`. The example uses
`test` mode with the mock provider only. `test` and `replay` modes cannot be
combined with Muse. Price records are immutable versions keyed by provider,
model, and the canonical settings hash from `pricingSettingsKey`; rates are in
USD per million tokens, with an optional per-request web-search rate.
`UsageAdminService` exposes bounded, administrator-only attempt summaries.
`runAdmission` provides fenced user/global concurrency admission and retains a
case lock while a run waits for input.

Document ingestion renews its extraction claim during parsing and OCR. Processing
and failure transitions are fenced by the live claim and the document snapshot;
failures before claiming compare the original state before updating it. Saving
the extraction and final document state is conditional on a live claim in one
transaction. After synchronous parsing, an expired lease can be extended only
if its stored holder is unchanged; a replaced or deleted claim cannot be recovered.
Cache identities include the detected format, so renaming text
as TSV triggers table parsing. TIFF decode buffers are released after each frame.
PDF pages with no renderable content within the image limits remain partial
instead of caching a blank OCR result as complete.
ZIP spreadsheets are checked against actual bounded inflation;
row limits reject truncated sheets. Extracted output is limited to 12 MiB of
BSON by default (`maxExtractedBytes`, configurable up to 15 MiB), below MongoDB's
16 MiB record limit. Larger output fails explicitly rather than remaining in
`processing`.

Live Muse image requests remain disabled with `unbounded-usage-capability`
until the provider's image usage can be bounded for spending admission. Scanned
documents therefore remain `partial` with `ocr-unsupported` under Muse; mock
OCR and deterministic parsing are available. Do not remove the spending guard
to enable OCR.

Orchestration publishes each full task plan atomically, including adapted
instructions, and copies retry runs with their tasks in one transaction.
Findings, evidence and deliverable sections are committed under the run's
fencing token. Cancellation and terminal status are resolved together when
admission is released; cancelling a waiting run needs no execution slot.
Workers recover abandoned cancellations and replay pending terminal events.
Recovery rejects changed plan versions, preserves spend-limit stops, and does
not repeat a paid coordinator call whose result was lost. Worker polling advances
past owners at capacity so later eligible runs can start.

Human-input rounds have separate question IDs and durable consumed keys.
Answers accumulate across rounds. Resumed calls count as new attempts and retain
their accepted input through a worker restart, including after output correction.
Interrupted admitted attempts remain unknown-cost exposure.
Case usage includes the complete case ledger, not the administrator's bounded
query page, and refreshes are fenced without replacing other case fields.
Specialist document slices include bounded table text as well as PDF pages and
share the configured input budget with the rest of the request. Reviewers receive
the persisted task instructions.

## Environment and generated files

`.env.example` contains only non-secret local defaults. Copy it to `.env` when
local configuration is needed; `.env` files (except the example) and generated
build/test output are ignored by Git. Local document bytes are stored under
`.data/documents`; production must use a private S3 bucket configured with
`AWS_REGION`, `S3_BUCKET`, `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY`.
S3 download URLs are short-lived and capped at one hour. Add settings to the
example alongside the work package that introduces them. Secrets must be read
through the server-only `@evianta/env/server` entry point and must never be
exposed to the web client.

## API authentication

Configure the required API values in `.env`, including a unique random
`JWT_SIGNING_KEY` of at least 32 bytes, exact `WEB_ORIGIN`, rate limits and
`SESSION_RECHECK_SECONDS`. Keep `TRUST_PROXY_HOPS` at `0` unless the API is
behind a known proxy chain. JWTs last 30 minutes and are checked against the
current user, access key and revocable session on each request.
The API start and admin commands load the repository-root `.env` automatically;
environment variables already exported by the process take precedence.
Clients must hold tokens in memory only and ask users to re-enter their key
after a reload or token expiry; there are no refresh tokens.

Build and run the API with `pnpm --filter @evianta/api build` and
`pnpm --filter @evianta/api start`. The admin CLI supports `create-user`,
`disable-user`, `issue-key` and `revoke-key`; run it with
`pnpm --filter @evianta/api admin -- <command> <arguments>`. An issued key is
printed once and only its SHA-256 verifier is stored. Do not pass keys in
shell history or logs.
