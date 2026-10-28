import process from "node:process";

export function getRequiredEnv(
  name: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const value = env[name];

  if (value === undefined || value.trim() === "") {
    throw new Error(`Required environment variable "${name}" is not set`);
  }

  return value;
}

export function getMongoDbUri(env: NodeJS.ProcessEnv = process.env): string {
  const uri = getRequiredEnv("MONGODB_URI", env);
  getMongoDatabaseName(uri);
  return uri;
}

export function getMongoDatabaseName(uri: string): string {
  const scheme = /^([a-z][a-z\d+.-]*):\/\//i.exec(uri);
  if (!scheme) {
    throw new Error("MONGODB_URI must be a valid MongoDB URI");
  }
  if (
    scheme[1]?.toLowerCase() !== "mongodb" &&
    scheme[1]?.toLowerCase() !== "mongodb+srv"
  ) {
    throw new Error("MONGODB_URI must use mongodb:// or mongodb+srv://");
  }

  const remainder = uri.slice(scheme[0].length);
  const match = /^([^/?#]+)(?:\/([^/?#]*))?(?:\?[^#]*)?$/.exec(remainder);
  if (!match) {
    throw new Error("MONGODB_URI must be a valid MongoDB URI");
  }
  validateMongoAuthority(match[1]!, scheme[1]!.toLowerCase() === "mongodb+srv");
  if (!match[2]) {
    throw new Error("MONGODB_URI must include a database name");
  }

  let databaseName: string;
  try {
    databaseName = decodeURIComponent(match[2]);
  } catch {
    throw new Error("MONGODB_URI must be a valid MongoDB URI");
  }
  if (!databaseName || /[/\\. "$*<>:|?\0]/.test(databaseName)) {
    throw new Error("MONGODB_URI must include a valid database name");
  }
  return databaseName;
}

function validateMongoAuthority(authority: string, srv: boolean): void {
  const invalid = new Error("MONGODB_URI must be a valid MongoDB URI");
  const at = authority.lastIndexOf("@");
  const hosts = (at === -1 ? authority : authority.slice(at + 1)).split(",");
  if (srv && hosts.length !== 1) throw invalid;
  for (const host of hosts) {
    const parts = /^(?:\[[0-9a-f:.]+\]|[^\s:/?#@[\]]+)(?::(\d{1,5}))?$/i.exec(
      host,
    );
    if (!parts) throw invalid;
    const port = parts[1];
    if (port !== undefined) {
      if (srv || Number(port) < 1 || Number(port) > 65535) throw invalid;
    }
  }
}

export interface AiEnvironment {
  provider: "muse" | "mock";
  modelApiKey?: string;
  museBaseUrl?: string;
  museSparkModel?: string;
  museWonderModel?: string;
}

export function getAiEnvironment(
  env: NodeJS.ProcessEnv = process.env,
): AiEnvironment {
  const provider = env.EVIANTA_AI_PROVIDER ?? "mock";
  if (provider !== "muse" && provider !== "mock") {
    throw new Error('EVIANTA_AI_PROVIDER must be "muse" or "mock"');
  }

  if (provider === "mock") return { provider };

  return {
    provider,
    modelApiKey: getRequiredEnv("MODEL_API_KEY", env),
    museBaseUrl: env.MUSE_BASE_URL ?? "https://api.meta.ai/v1",
    museSparkModel: getRequiredEnv("MUSE_SPARK_MODEL", env),
    museWonderModel: getRequiredEnv("MUSE_WONDER_MODEL", env),
  };
}
