import { randomUUID } from "node:crypto";
import { MongoStore } from "@evianta/store";
import { MongoClient } from "mongodb";
import { MongoMemoryReplSet } from "mongodb-memory-server";
import { afterAll, beforeAll, expect, it } from "vitest";
import {
  createMongoCheckpointerAsync,
  type OrchestratorHooks,
} from "../src/index.js";
import {
  CASE_ID,
  Clock,
  LEASE_TTL_SECONDS,
  OWNER,
  ScriptedProvider,
  createHarness,
  planOf,
  seedAsync,
  specialistOutput,
  type Repositories,
} from "./harness.js";

let replSet: MongoMemoryReplSet | undefined;
let client: MongoClient | undefined;

beforeAll(async () => {
  replSet = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  client = new MongoClient(
    replSet.getUri(`evianta_test_${randomUUID().replaceAll("-", "")}`),
  );
  await client.connect();
}, 300_000);

afterAll(async () => {
  await client?.db().dropDatabase();
  await client?.close();
  await replSet?.stop();
});

it("recovers a crashed run from MongoDB checkpoints without repeating paid work", async () => {
  const dbName = client!.db().databaseName;
  const store = new MongoStore({ client: client!, db: client!.db(dbName) });
  await store.initialize();
  const repositories = store.repositories as unknown as Repositories;
  await seedAsync(repositories);
  const clock = new Clock();
  const provider = new ScriptedProvider({
    a: () => specialistOutput("a"),
    b: () => specialistOutput("b"),
  });
  const plan = planOf([{ key: "a" }, { key: "b", dependsOn: ["a"] }]);
  let crashed = false;
  const hooks: OrchestratorHooks = {
    afterTaskCommit: (task) => {
      if (!crashed && task.id.endsWith(":a")) {
        crashed = true;
        throw new Error("worker died");
      }
    },
  };

  const first = createHarness({
    repositories,
    provider,
    plan,
    clock,
    reviewer: false,
    hooks,
    checkpointer: await createMongoCheckpointerAsync({
      client: client!,
      dbName,
    }),
  });
  const run = await first.orchestrator.createRunAsync({
    ownerId: OWNER,
    caseId: CASE_ID,
  });
  await expect(first.worker.runOnceAsync()).rejects.toThrow("worker died");

  clock.advance(LEASE_TTL_SECONDS + 1);
  const second = createHarness({
    repositories,
    provider,
    plan,
    clock,
    reviewer: false,
    checkpointer: await createMongoCheckpointerAsync({
      client: client!,
      dbName,
    }),
  });
  const recovered = await second.worker.runOnceAsync();

  expect(recovered?.run).toMatchObject({ id: run.id, status: "completed" });
  expect(provider.calls).toEqual(["a", "b"]);
  const scope = { ownerId: OWNER, caseId: CASE_ID };
  const tasks = await repositories.tasks.listForRun(run.id, scope);
  expect(tasks.map((task) => task.status)).toEqual(["completed", "completed"]);
  expect(await repositories.findings.listForCase(scope)).toHaveLength(2);
  const db = client!.db(dbName);
  expect(
    await db.collection("langgraphCheckpoints").countDocuments({
      thread_id: run.threadId,
    }),
  ).toBeGreaterThan(0);
  expect(
    await db.collection("langgraphCheckpointWrites").countDocuments(),
  ).toBeGreaterThan(0);
}, 120_000);
