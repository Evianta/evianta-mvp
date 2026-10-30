import { getApiEnvironment } from "@evianta/env/server";
import { pathToFileURL } from "node:url";
import { createApiApp } from "./app.js";
import { registerCaseApiRoutes } from "./routes.js";
import { createApiRuntime } from "./runtime.js";

export async function startApi(): Promise<void> {
  let environment: ReturnType<typeof getApiEnvironment>;
  try {
    environment = getApiEnvironment();
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Invalid API configuration";
    console.error("API configuration invalid", { message });
    throw error;
  }
  const runtime = await createApiRuntime();
  const { app } = createApiApp({
    repositories: runtime.repositories,
    configuration: environment,
    registerRoutes: (context) =>
      registerCaseApiRoutes(context, runtime.services),
  });
  const server = app.listen(environment.apiPort, "127.0.0.1");
  server.on("listening", () => {
    console.info(`Evianta API listening on port ${environment.apiPort}`);
  });
  server.on("error", async (error: Error) => {
    console.error("API server failed", { errorName: error.name });
    try {
      await runtime.close();
    } catch (closeError) {
      const errorName =
        closeError instanceof Error ? closeError.name : "UnknownError";
      console.error("API store shutdown failed", { errorName });
    }
    process.exitCode = 1;
  });

  const shutdown = (): void => {
    server.close((error) => {
      if (error) {
        console.error("API shutdown failed", { errorName: error.name });
        process.exitCode = 1;
      }
      void runtime.close().catch((closeError: unknown) => {
        const errorName =
          closeError instanceof Error ? closeError.name : "UnknownError";
        console.error("API store shutdown failed", { errorName });
        process.exitCode = 1;
      });
    });
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  void startApi().catch((error: unknown) => {
    const errorName = error instanceof Error ? error.name : "UnknownError";
    console.error("API startup failed", { errorName });
    process.exitCode = 1;
  });
}
