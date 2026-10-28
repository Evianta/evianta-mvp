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

| Path              | Current boundary and planned ownership                               |
| ----------------- | -------------------------------------------------------------------- |
| `packages/core`   | Shared domain schemas, ports and synthetic workflow fixtures         |
| `packages/env`    | Server-side environment and storage configuration validation         |
| `packages/store`  | MongoDB repositories and private document storage adapters           |
| `packages/ai`     | Provider boundary; adapters come later                               |
| `packages/agents` | Agent boundary; orchestration comes later                            |
| `apps/api`        | API application boundary; HTTP features come later                   |
| `apps/web`        | Next.js shell, design system, synthetic samples and typed API client |

Keep shared types in `core`, environment reads in `env`, persistence in
`store`, and provider access in `ai`. Use `workspace:*` for internal
dependencies. Keep tests deterministic and isolated from real credentials,
cloud resources and model traffic. Add each feature with its own focused tests;
do not add placeholder product behavior to a package boundary.

The web app runs with `pnpm --filter @evianta/web dev`. Its public sample pages
use deterministic core fixtures. Private views require an access key exchanged
through `/auth/token`; JWTs remain in memory, and private requests use
`cache: "no-store"`. Set `NEXT_PUBLIC_API_BASE_URL` only when the API is served
from a different origin. Run browser and axe checks with
`pnpm --filter @evianta/web test:e2e`.

For production, run `pnpm --filter @evianta/web build`, then
`pnpm --filter @evianta/web start`. This uses the regular Next server; deploy the
complete `.next` build and runtime dependencies, not a standalone server bundle.
Next serves the generated client scripts, styles and fonts from that build.

The private workspace requires `GET /cases/:caseId/runs/latest` to return
`{ "run": RunDto | null }`, validated by `LatestRunResponseSchema`. The API must
authorize ownership of the case, return its active run or most recent run, and
return `null` only when the case has no runs. Authorization and lookup failures
must remain errors. The workspace reloads this run on navigation and replays its
event stream from the beginning. As with the other private endpoints, the HTTP
handler belongs to the upcoming API implementation; the API app is currently a
placeholder.

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
