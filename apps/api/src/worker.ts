import { pathToFileURL } from "node:url";
import { getErrorLogDetails } from "./error-logging.js";
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
        console.error("Worker shutdown failed", getErrorLogDetails(error));
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
    console.error("Worker startup failed", getErrorLogDetails(error));
    process.exitCode = 1;
  });
}
