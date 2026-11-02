import { pathToFileURL } from "node:url";
import { getErrorLogDetails } from "./error-logging.js";
import { startApi } from "./index.js";

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  void startApi().catch((error: unknown) => {
    console.error("API startup failed", getErrorLogDetails(error));
    process.exitCode = 1;
  });
}
