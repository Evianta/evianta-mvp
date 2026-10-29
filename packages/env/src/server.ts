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

export interface ApiEnvironment {
  jwtSigningKey: string;
  jwtIssuer: string;
  jwtAudience: string;
  jwtTtlSeconds: 1800;
  webOrigin: string;
  apiPort: number;
  authRateLimitPerMinute: number;
  apiRateLimitPerMinute: number;
  sessionRecheckSeconds: number;
  trustProxyHops: number;
}

function getPositiveInteger(
  name: string,
  env: NodeJS.ProcessEnv,
  defaultValue?: number,
): number {
  const raw =
    env[name] ??
    (defaultValue === undefined ? undefined : String(defaultValue));
  if (raw === undefined || !/^[1-9]\d*$/.test(raw)) {
    throw new Error(`"${name}" must be a positive integer`);
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) {
    throw new Error(`"${name}" must be a safe integer`);
  }
  return value;
}

export function getApiEnvironment(
  env: NodeJS.ProcessEnv = process.env,
): ApiEnvironment {
  const jwtSigningKey = getRequiredEnv("JWT_SIGNING_KEY", env);
  if (Buffer.byteLength(jwtSigningKey, "utf8") < 32) {
    throw new Error("JWT_SIGNING_KEY must be at least 32 bytes");
  }

  const webOrigin = getRequiredEnv("WEB_ORIGIN", env).trim();
  let originUrl: URL;
  try {
    originUrl = new URL(webOrigin);
  } catch (error) {
    throw new Error("WEB_ORIGIN must be an exact http(s) origin", {
      cause: error,
    });
  }
  if (
    originUrl.origin !== webOrigin ||
    (originUrl.protocol !== "https:" &&
      !(
        originUrl.protocol === "http:" &&
        ["localhost", "127.0.0.1", "[::1]"].includes(originUrl.hostname)
      ))
  ) {
    throw new Error("WEB_ORIGIN must be an exact http(s) origin");
  }

  const ttl = Number(env.JWT_TTL_SECONDS ?? "1800");
  if (ttl !== 1800) {
    throw new Error("JWT_TTL_SECONDS must be 1800");
  }

  const apiPort = getPositiveInteger("API_PORT", env, 3001);
  if (apiPort > 65535) {
    throw new Error("API_PORT must be between 1 and 65535");
  }
  const sessionRecheckSeconds = getPositiveInteger(
    "SESSION_RECHECK_SECONDS",
    env,
  );
  if (sessionRecheckSeconds > 1800) {
    throw new Error("SESSION_RECHECK_SECONDS must not exceed 1800");
  }
  const trustProxyHops = Number(env.TRUST_PROXY_HOPS ?? "0");
  if (!Number.isSafeInteger(trustProxyHops) || trustProxyHops < 0) {
    throw new Error("TRUST_PROXY_HOPS must be a non-negative integer");
  }

  return {
    jwtSigningKey,
    jwtIssuer: getRequiredEnv("JWT_ISSUER", env),
    jwtAudience: getRequiredEnv("JWT_AUDIENCE", env),
    jwtTtlSeconds: 1800,
    webOrigin,
    apiPort,
    authRateLimitPerMinute: getPositiveInteger(
      "AUTH_RATE_LIMIT_PER_MINUTE",
      env,
    ),
    apiRateLimitPerMinute: getPositiveInteger("API_RATE_LIMIT_PER_MINUTE", env),
    sessionRecheckSeconds,
    trustProxyHops,
  };
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
