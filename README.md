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

| Path              | Current boundary and planned ownership                            |
| ----------------- | ----------------------------------------------------------------- |
| `packages/core`   | Shared domain schemas, ports and synthetic workflow fixtures      |
| `packages/env`    | Server-side environment validation                                |
| `packages/store`  | MongoDB repositories and matching in-memory repository contracts  |
| `packages/ai`     | Muse/mock provider adapters, structured output and usage boundary |
| `packages/agents` | Agent boundary; orchestration comes later                         |
| `apps/api`        | API application boundary; HTTP features come later                |
| `apps/web`        | Web application boundary; UI features come in the web work pack   |

Keep shared types in `core`, environment reads in `env`, persistence in
`store`, and provider access in `ai`. Use `workspace:*` for internal
dependencies. Keep tests deterministic and isolated from real credentials,
cloud resources and model traffic. Add each feature with its own focused tests;
do not add placeholder product behavior to a package boundary.

The AI package defaults to the deterministic mock provider. Live Muse requests
require server-side configuration and an injected usage-admission/recording
port; tests do not call a model provider.

## Environment and generated files

`.env.example` contains only non-secret local defaults. Copy it to `.env` when
local configuration is needed; `.env` files (except the example) and generated
build/test output are ignored by Git. Add settings to the example alongside
the work package that introduces them. Secrets must be read through the
server-only `@evianta/env/server` entry point and must never be exposed to the
web client.
