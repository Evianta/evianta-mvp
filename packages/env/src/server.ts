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

export type DocumentStoreConfig =
  | {
      driver: "filesystem";
      localStorageDir: string;
    }
  | {
      driver: "s3";
      region: string;
      bucket: string;
      signedUrlTtlSeconds: number;
    };

export function getDocumentStoreConfig(
  env: NodeJS.ProcessEnv = process.env,
): DocumentStoreConfig {
  const driver = getRequiredEnv("DOCUMENT_STORE", env);
  if (driver !== "filesystem" && driver !== "s3") {
    throw new Error('DOCUMENT_STORE must be either "filesystem" or "s3"');
  }
  if (env.NODE_ENV === "production" && driver !== "s3") {
    throw new Error('DOCUMENT_STORE must be "s3" in production');
  }

  if (driver === "filesystem") {
    return {
      driver,
      localStorageDir: getRequiredEnv("LOCAL_STORAGE_DIR", env),
    };
  }

  const ttlValue = env.S3_DOWNLOAD_TTL_SECONDS ?? "300";
  if (!/^[1-9]\d*$/.test(ttlValue)) {
    throw new Error("S3_DOWNLOAD_TTL_SECONDS must be a positive integer");
  }
  const signedUrlTtlSeconds = Number(ttlValue);
  if (signedUrlTtlSeconds > 3600) {
    throw new Error("S3_DOWNLOAD_TTL_SECONDS must not exceed 3600");
  }

  getRequiredEnv("AWS_ACCESS_KEY_ID", env);
  getRequiredEnv("AWS_SECRET_ACCESS_KEY", env);
  return {
    driver,
    region: getRequiredEnv("AWS_REGION", env),
    bucket: getRequiredEnv("S3_BUCKET", env),
    signedUrlTtlSeconds,
  };
}

export interface MongoConfig {
  uri: string;
  dbName: string;
}

export function getMongoConfig(
  env: NodeJS.ProcessEnv = process.env,
): MongoConfig {
  const uri = getRequiredEnv("MONGODB_URI", env).trim();
  if (!/^mongodb(?:\+srv)?:\/\//i.test(uri)) {
    throw new Error("MONGODB_URI must use mongodb:// or mongodb+srv://");
  }

  const dbName = getRequiredEnv("MONGODB_DB", env).trim();
  if (
    /[/\\. "$*<>:|?\0]/.test(dbName) ||
    Buffer.byteLength(dbName, "utf8") > 63
  ) {
    throw new Error("MONGODB_DB must be a valid MongoDB database name");
  }
  return { uri, dbName };
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
