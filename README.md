# Evianta MVP

The repository is a pnpm TypeScript monorepo with a Next.js web app, an Express
API and a separate background worker.

## Requirements

- Node.js `24.3.0` (see `.node-version`)
- pnpm `10.18.3` (pinned by the root `package.json`)
- MongoDB 7+ running as a replica set for local application use (transactions
  are required). API, worker and admin connections reject standalone MongoDB
  before initializing repositories or background recovery.

## Local development

```sh
corepack enable
pnpm install --frozen-lockfile
```

Copy `.env.example` to `.env` in the repository root (`Copy-Item .env.example .env`
in PowerShell). Generate a signing key and put it in `JWT_SIGNING_KEY`:

```sh
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

Keep the key private. The example supplies local rate limits and uses the mock
model provider, so no model credentials or paid requests are needed. Never use
the local settings or test usage mode for a live deployment.

For a local MongoDB installation, create a dedicated data directory first, then
start a single-node replica set in a separate terminal:

```sh
mongod --replSet rs0 --bind_ip 127.0.0.1 --port 27017 --dbpath <absolute-data-directory>
mongosh --eval "rs.initiate({_id:'rs0',members:[{_id:0,host:'127.0.0.1:27017'}]})"
```

Run the initialization command once, after the server is listening. Set
`MONGODB_URI=mongodb://127.0.0.1:27017/?replicaSet=rs0` in `.env`, or use an
existing transaction-capable development database. Do not initialize or
reconfigure a shared database.

If API or worker output reports `mongodb-transactions-required`, stop
`pnpm dev` and configure the database as above. Adding `replicaSet=rs0` to a
URI alone does not turn a standalone server into a replica set. If an existing
MongoDB service already owns port 27017, do not start a second server on that
port; use a separate development port/data directory and update `MONGODB_URI`.
Restart `pnpm dev` after the replica set is ready.

```sh
pnpm dev
```

This builds the API dependency graph, then starts compiler watchers, the web app
at `http://localhost:3000`, API at `http://127.0.0.1:3001`, and the worker.
App and shared-package edits rebuild/reload automatically. Stop the group with
Ctrl+C. Initial build errors prevent launch; compiler errors during watch are
shown in the terminal and must be fixed before relying on the running app.
Compiler caches live inside each package's generated `dist` directory, so
removing generated output also invalidates its build cache.

The browser connects directly to `NEXT_PUBLIC_API_BASE_URL`, which defaults in
the example to `http://localhost:3001`. The API binds to IPv4 loopback.
`WEB_ORIGIN` must exactly match the web origin, including the hostname and port;
opening the web app with `127.0.0.1` instead of `localhost` also requires updating
`WEB_ORIGIN`. Login is saved per web origin, so switching hostnames uses a
different browser storage area. The API URL can use either loopback hostname;
session persistence does not depend on cookies. API health is available at
`http://127.0.0.1:3001/healthz`.
The web commands and API/worker/admin commands load the root `.env`; exported
environment variables take precedence. Restart development after changing
environment values, and rebuild the web app after changing public values used
in a production build. Web build/start commands explicitly use production mode,
even when the local `.env` sets development mode. Only `NEXT_PUBLIC_*` values
are exposed to the browser.

Create a local user and issue a key, using the user ID printed by the first
command:

```sh
pnpm --filter @evianta/api admin create-user developer@example.test "Local Developer"
pnpm --filter @evianta/api admin issue-key <user-id>
```

The admin command requires the API build (`pnpm dev` prepares it, or run
`pnpm --filter @evianta/api... build`). The issued key is printed only once.
Enter it in the web sign-in dialog; do not put it in a URL, source file or log.
The worker must be running for submitted analyses to complete.

To check the data-analysis flow, open **Start** at `/`, sign in, and choose
the **Data analysis** suggestion or write your own prompt.
Attach a `.csv` or `.xlsx` dataset and choose **Start task**. The prompt stays
editable; the title is derived from its first nonempty line. There is no workflow
dropdown or optional-details form. Local rules use the message, attachment names
and up to 8 KB of CSV header text to detect one of the three supported task types.
Unclear or conflicting intent asks you to choose, without changing your message
or files and without creating a case. No model or upload is used for detection.
PDF/Excel contents are not read for classification; ambiguous filenames/messages
need a choice. Sample-origin entry uses Start at `/?source=<sample-id>`.
Enter submits, Shift+Enter adds a line, and IME composition does not submit.
Starting authorizes private case creation, upload/extraction and execution under
existing model limits. File limits and enabled workflows come from the authenticated
`GET /intake/configuration` endpoint. Tax notice work is available; MSME remains
**Coming next**, and the API rejects live creation, uploads and execution for it.

Tax notice work analyzes the supplied records, reconciles income and credits,
researches general official guidance, prepares a response draft and runs an
independent review. Drafting receives the original notice findings, source
references, assumptions and unresolved questions. Reconciliation requires
traceable document evidence for each figure and does not calculate a difference
when extraction has unresolved high-severity questions. Each figure must have
its own finding and reliable source locations; grouped figures remain incomplete
because their citations cannot be assigned to individual claims. Confidence
cannot exceed the least reliable supporting document. Distinct source locations
are retained even when they share a source reference, including when document
slices are omitted from later tasks to fit model limits.
Unreadable amended figures also block reconciliation, even when grouped with
other readable claims; a readable older figure does not override an unknown
replacement. Persisted extraction confidence,
page reliability and warnings accompany slices and prior source evidence.
These are compact summaries: page count, minimum page confidence, handwriting
presence, warning count and distinct warning codes. Complete per-page metadata
and warning messages remain in the stored extraction; repeated citations do not
copy those arrays into model inputs.
Reconciliation requires confidence of at least 0.75 for the extraction and every
page, no extraction warnings, and no handwritten pages. Model-generated
confidence cannot override these checks.
Model-based specialists and independent review shorten source excerpts when
needed to fit their input budgets,
mark them as partial, and retain all findings, claims, evidence IDs and source
positions. Stored evidence remains unchanged. If the required findings and
source identities still cannot fit, the task fails explicitly rather than dropping
them. Specialist excerpts are budgeted before adding document slices. Deterministic
reconciliation retains complete source excerpts.
Short excerpts stay intact when marking them as partial would increase the
serialized input size.
Independent review also receives the complete task draft summaries, including
assertions not repeated in findings. These drafts are never shortened to fit a
model limit; an oversized required draft fails explicitly before model dispatch.
The tax workspace shows the latest deliverable's detailed findings, assumptions,
question status and evidence links alongside the editable draft summaries.
Search citations without a claim retain a source
discovery note, not an inferred legal conclusion; excerpts stay as quotes.
Unavailable search raises a
professional-verification question. All response materials require professional
review; the workflow does not approve or submit filings.
Mock mode supplies schema-valid planning and review responses so the full tax
workflow can run without a paid provider.

Ready sources start a run automatically. Sources still being read open in the case
workspace with preparation status and **Start analysis** when ready. Completed
reports retain computed metrics, data-quality checks and source-linked charts.
Workbook analysis uses underlying numeric cell values, not rounded currency or
percentage display strings. Date cells use canonical ISO dates or timestamps
regardless of their display format; source row references are preserved.
Periods are sorted chronologically when their labels can be ordered reliably.
Otherwise, period totals retain source order, growth rates and the trend chart
are omitted, and the report includes a data-quality warning.
Amounts support decimal points, scientific notation, Western comma grouping
(`1,234.56`) and Indian comma grouping (`12,34,567.89`). Decimal-comma and malformed
amounts are excluded with a data-quality warning when valid amounts remain.
If the highest-ranked measure has no valid amounts, the analysis fails explicitly
instead of using years, identifiers or a lower-ranked measure as sales.
Categorical sales columns such as sales representatives, teams and channels are
not treated as measures. Revenue ranks above sales, generic amounts, values,
prices and quantities.
Reopen saved work through **Cases**, without resubmitting. Upload failures retain
the created case and successful files; rejected uploads can be retried in
the composer. Ambiguous create/upload/run responses are checked against persisted
state and never blindly resubmitted: follow the recovery link to inspect the case
or register. The create/upload APIs have no idempotency key, so an unconfirmed
outcome requires inspection rather than an automatic retry.

Private drafts/files stay in memory and clear with the session. Signed-out
visitors can select a static suggestion but cannot enter private data or files.
Public replay remains read-only. Sample-origin intake copies only the workflow
setup, not synthetic files or results. Case-grounded Ask remains later work.
The supplied Evianta logo is bundled locally from `https://evianta.com/logo.svg`;
opening private work does not request the logo from a third-party host.

From `apps/api`, the equivalent command is `pnpm admin issue-key <user-id>`.
`issue-key` requires an existing user ID, not an email address. An optional
second argument sets the key expiry as an ISO timestamp. Without one, the key
remains valid until revoked. Missing arguments are rejected before connecting
to MongoDB.

| Command             | Purpose                                      |
| ------------------- | -------------------------------------------- |
| `pnpm dev`          | Web, API, worker and shared-package watchers |
| `pnpm dev:web`      | Web and core watcher only                    |
| `pnpm dev:api`      | API and dependency watchers only             |
| `pnpm dev:worker`   | Worker and dependency watchers only          |
| `pnpm build`        | Production workspace builds                  |
| `pnpm typecheck`    | Application, test and tooling types          |
| `pnpm lint`         | ESLint plus formatting check                 |
| `pnpm lint:fix`     | Apply ESLint fixes                           |
| `pnpm format:check` | Check formatting without writing             |
| `pnpm format`       | Apply Prettier formatting                    |
| `pnpm test`         | Build all workspaces, then run Vitest        |
| `pnpm test:e2e`     | Run mocked Playwright browser tests          |

Use the full `pnpm dev` group when running API and worker together; do not run
both focused backend commands simultaneously, since each owns compiler
watchers. The focused commands also prepare their dependencies from a fresh
checkout.

## Quality checks

Install dependencies and run the repository gates:

```sh
corepack enable
pnpm install --frozen-lockfile
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

`pnpm test` includes `pnpm build`, so a separate build is optional when running
all gates. Tests use local fixtures and do not contact cloud services or model
providers. MongoDB tests download a local test binary on first use; no
application database is required. ESLint includes Next.js and React Hooks
rules. Prettier and EditorConfig use two-space indentation and LF line endings;
Git preserves LF on checkout, including Windows. CSV byte fixtures retain their
original bytes. Vitest and Playwright each use at most two workers to avoid
oversubscribing local databases and the browser test server. There are
no Git hooks.

Install Chromium once before running browser tests:

```sh
pnpm --filter @evianta/web exec playwright install chromium
pnpm test:e2e
```

Browser tests use a separate `.next-e2e` build directory so they do not overwrite
an active development server's `.next` output. They build and start a production
server before running assertions, keeping cold compilation out of navigation
checks.

The browser suite owns port 3100 and starts a dedicated fixture-backed web server;
it never reuses a running development server. Free that port before testing.
Next.js commands still share generated TypeScript entry files; avoid concurrent
Next.js commands when validating types or production builds.
CI runs the same quality gates and a separate Chromium browser job, retaining
browser reports and traces on failure.

## Reviewing deliverables

The case workspace lets reviewers edit plain-text sections, accept sections,
request changes with a comment, and approve a saved deliverable version.
Section decisions save the current draft and comment together. Saving one
section preserves unsaved work in other sections; save all edits and comments
before approving the deliverable. Editing accepted content resets its section
to pending unless the same request includes a new review decision.

Reviewer edits replace the executive summary text in the data-analysis report,
not its computed metrics, narrative interpretation, or charts. Any saved review
changes increment the deliverable version and invalidate its previous approval.
A deliverable cannot be approved while any section has requested changes.
Concurrent edits or approvals against an older version return a conflict;
reload before retrying.

## Workspace responsibilities

| Path                 | Current boundary and planned ownership                                |
| -------------------- | --------------------------------------------------------------------- |
| `packages/core`      | Shared domain schemas, ports and synthetic workflow fixtures          |
| `packages/env`       | Server-side environment and storage configuration validation          |
| `packages/store`     | MongoDB repositories and private document storage adapters            |
| `packages/ai`        | Muse/mock provider adapters, structured output and usage boundary     |
| `packages/agents`    | LangGraph planning, specialist execution, review and run recovery     |
| `packages/ingestion` | Document parsing, text-layer and admitted OCR extraction with caching |
| `apps/api`           | Express case API, access-key authentication, worker and admin CLI     |
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
`apps/api/.data/documents` when using the example with the API package commands
(relative paths resolve from `apps/api`). API, worker and admin share that
working directory. Use an absolute `LOCAL_STORAGE_DIR` to choose another
location. Production must use a private S3 bucket configured with
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
The API, worker and admin commands load the repository-root `.env` automatically;
environment variables already exported by the process take precedence.
Access keys are never saved in the browser. For this demo, `localStorage` under
`evianta.session` holds only the JWT and its absolute expiry. Reload restores an
unexpired session without renewing it. API/SSE requests use bearer authorization;
there is no authentication cookie or cookie restoration endpoint. The server
still checks user, access-key and session revocation on every protected request.
Logout, expiry and authentication rejection remove the saved token and clear
private state. Logout also revokes the server session; a failed revocation is
reported with a retry action even though the local login is already removed.
Tabs follow changes to the saved session so signing out in one clears the others.
Invalid saved data is removed and reported; unavailable browser storage is an
explicit error, not a successful persistent sign-in. There are no refresh tokens.

This is a demo trade-off: scripts running on the web origin, including injected
scripts from an XSS flaw, can read localStorage tokens. Keep HTTPS and XSS
prevention for deployment. Server rate limits, revocation and spending limits
remain enforced independently of browser persistence. CORS still permits only
the exact `WEB_ORIGIN`; credentialed cookie CORS is not enabled.

Build and run the API with `pnpm --filter @evianta/api build` and
`pnpm --filter @evianta/api start`. Run durable case execution in a separate
process with `pnpm --filter @evianta/api start:worker`. Configure
`UPLOAD_MAX_BYTES`, `UPLOAD_MAX_FILES` and `DOCUMENT_MAX_PAGES` to bound file
admission and extraction. The API serves owned case lifecycle routes, public
synthetic samples and authenticated persisted-event streams; sample sources
contain synthetic data only. The admin CLI supports `create-user`,
`disable-user`, `issue-key` and `revoke-key`; run it with
`pnpm --filter @evianta/api admin -- <command> <arguments>`. An issued key is
printed once and only its SHA-256 verifier is stored. Do not pass keys in
shell history or logs.
