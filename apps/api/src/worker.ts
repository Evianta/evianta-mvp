import { pathToFileURL } from "node:url";
import { createApiRuntime } from "./runtime.js";

export async function startWorker(): Promise<void> {
  const runtime = await createApiRuntime();
  runtime.worker.start();
  console.info(`Evianta worker started (${runtime.worker.workerId})`);

  let stopping = false;
  const shutdown = (): void => {
    if (stopping) return;
    stopping = true;
    void runtime.worker
      .stopAsync()
      .then(() => runtime.close())
      .then(() => {
        console.info("Evianta worker stopped");
      })
      .catch((error: unknown) => {
        const errorName = error instanceof Error ? error.name : "UnknownError";
        console.error("Worker shutdown failed", { errorName });
        process.exitCode = 1;
      });
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  void startWorker().catch((error: unknown) => {
    const errorName = error instanceof Error ? error.name : "UnknownError";
    console.error("Worker startup failed", { errorName });
    process.exitCode = 1;
  });
}
