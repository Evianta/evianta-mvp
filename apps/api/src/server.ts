import { pathToFileURL } from "node:url";
import { startApi } from "./index.js";

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
