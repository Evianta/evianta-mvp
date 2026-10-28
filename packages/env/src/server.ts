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
