# Evianta MVP

Evianta is a TypeScript monorepo with a Next.js web app, an Express API, and a
background worker. This guide covers local development.

## Requirements

- Node.js `24.3.0` (see `.node-version`)
- pnpm `10.18.3`
- MongoDB 7+ configured as a replica set (transactions are required)

## Set up locally

Install dependencies and copy the local environment defaults:

```powershell
pnpm install --frozen-lockfile
Copy-Item .env.example .env
```

The example uses the mock AI provider, so no Meta API key is needed to develop
locally. Its signing key is for local development only; never use it in a
deployment. To use Meta models, set `EVIANTA_AI_PROVIDER=muse` and configure
`MODEL_API_KEY` and the required usage limits in `.env`.

Start a local MongoDB replica set. Create a data directory, then run `mongod`
in one terminal:

```powershell
New-Item -ItemType Directory -Force C:\data\evianta
mongod --replSet rs0 --bind_ip 127.0.0.1 --port 27017 --dbpath C:\data\evianta
```

Initialize the replica set once, after MongoDB is listening:

```powershell
mongosh --eval "rs.initiate({_id:'rs0',members:[{_id:0,host:'127.0.0.1:27017'}]})"
```

The example `.env` already points to this replica set. If you use another
MongoDB instance or port, update `MONGODB_URI` to match.

Start the web app, API, worker, and package watchers:

```sh
pnpm dev
```

Open [http://localhost:3000](http://localhost:3000). The API listens on
`http://127.0.0.1:3001`; its health endpoint is `/healthz`. Stop all processes
with Ctrl+C.

Create a local user and access key in another terminal:

```sh
pnpm --filter @evianta/api admin create-user developer@example.test "Local Developer"
pnpm --filter @evianta/api admin issue-key <user-id>
```

Use the printed key to sign in. It is shown only once. The worker must be
running for analyses to finish.

## Development commands

| Command           | Purpose                                        |
| ----------------- | ---------------------------------------------- |
| `pnpm dev`        | Run web, API, worker, and package watchers     |
| `pnpm dev:web`    | Run the web app and core package watcher       |
| `pnpm dev:api`    | Run the API and its dependencies               |
| `pnpm dev:worker` | Run the worker and its dependencies            |
| `pnpm lint`       | Run ESLint and check formatting                |
| `pnpm typecheck`  | Type-check applications, packages, and tooling |
| `pnpm test`       | Build packages and run Vitest                  |
| `pnpm test:e2e`   | Run Playwright browser tests                   |
| `pnpm build`      | Build all workspaces                           |

Install Chromium before the first browser test run:

```sh
pnpm --filter @evianta/web exec playwright install chromium
```

## Repository layout

| Path                 | Responsibility                            |
| -------------------- | ----------------------------------------- |
| `apps/web`           | Next.js user interface                    |
| `apps/api`           | API server, worker, and admin CLI         |
| `packages/core`      | Shared domain types and schemas           |
| `packages/env`       | Server-side environment validation        |
| `packages/store`     | MongoDB repositories and document storage |
| `packages/ai`        | Mock and Meta model providers             |
| `packages/agents`    | Workflow planning and execution           |
| `packages/ingestion` | Document extraction                       |

Copy `.env.example` whenever you need a fresh local configuration. Keep secrets
in the ignored root `.env`; do not commit them or expose server values through
`NEXT_PUBLIC_*`.
