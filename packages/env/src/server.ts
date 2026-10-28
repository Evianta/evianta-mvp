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
  if (!match[2]) {
    throw new Error("MONGODB_URI must include a database name");
  }

  try {
    const databaseName = decodeURIComponent(match[2]);
    if (!databaseName) {
      throw new Error();
    }
    return databaseName;
  } catch {
    throw new Error("MONGODB_URI must be a valid MongoDB URI");
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
