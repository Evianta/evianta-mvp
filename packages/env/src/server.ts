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
  let parsed: URL;
  try {
    parsed = new URL(uri);
  } catch {
    throw new Error("MONGODB_URI must be a valid MongoDB URI");
  }

  if (parsed.protocol !== "mongodb:" && parsed.protocol !== "mongodb+srv:") {
    throw new Error("MONGODB_URI must use mongodb:// or mongodb+srv://");
  }
  if (!parsed.pathname || parsed.pathname === "/") {
    throw new Error("MONGODB_URI must include a database name");
  }

  return uri;
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
