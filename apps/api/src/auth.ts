import {
  createHash,
  createHmac,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import {
  PrincipalSchema,
  type AccessKeyRecord,
  type CaseRepository,
  type Principal,
  type RateLimitRepository,
  type SessionRecord,
  type UserRepository,
  type AccessKeyRepository,
} from "@evianta/core";
import type { NextFunction, Request, Response } from "express";
import { z } from "zod";

const TokenClaimsSchema = z
  .object({
    sub: z.string().min(1),
    jti: z.string().min(1),
    iss: z.string().min(1),
    aud: z.string().min(1),
    iat: z.number().int().safe().nonnegative(),
    exp: z.number().int().safe().positive(),
  })
  .strict();

const TokenHeaderSchema = z
  .object({
    alg: z.literal("HS256"),
    typ: z.literal("JWT"),
  })
  .strict();

const AccessKeyInputSchema = z
  .string()
  .regex(/^evk_[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{40,}$/);
const TimestampSchema = z.string().datetime({ offset: true });

export interface AuthConfiguration {
  jwtSigningKey: string;
  jwtIssuer: string;
  jwtAudience: string;
  jwtTtlSeconds: 1800;
  authRateLimitPerMinute: number;
  apiRateLimitPerMinute: number;
}

export interface AuthenticationRepositories {
  users: UserRepository;
  accessKeys: AccessKeyRepository;
  sessions: {
    findActiveById(id: string, at: string): Promise<SessionRecord | null>;
    insert(record: SessionRecord): Promise<void>;
    revoke(id: string, revokedAt: string): Promise<boolean>;
  };
  rateLimits: RateLimitRepository;
}

export interface AuthContext {
  principal: Principal;
  userEmail: string;
  userDisplayName: string;
  session: SessionRecord;
  accessKey: AccessKeyRecord;
}

export class AuthenticationError extends Error {
  constructor() {
    super("Authentication required");
    this.name = "AuthenticationError";
  }
}

function hashAccessKey(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function secureEqualHex(left: string, right: string): boolean {
  if (!/^[\da-f]{64}$/i.test(left) || !/^[\da-f]{64}$/i.test(right)) {
    return false;
  }
  return timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
}

function encodeJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function signJwt(
  claims: z.infer<typeof TokenClaimsSchema>,
  signingKey: string,
): string {
  const content = `${encodeJson({ alg: "HS256", typ: "JWT" })}.${encodeJson(claims)}`;
  const signature = createHmac("sha256", signingKey)
    .update(content)
    .digest("base64url");
  return `${content}.${signature}`;
}

function parseJsonSegment(segment: string): unknown {
  if (!/^[A-Za-z0-9_-]+$/.test(segment)) throw new AuthenticationError();
  try {
    return JSON.parse(Buffer.from(segment, "base64url").toString("utf8"));
  } catch {
    throw new AuthenticationError();
  }
}

function verifyJwt(
  token: string,
  configuration: AuthConfiguration,
  now: number,
): z.infer<typeof TokenClaimsSchema> {
  if (token.length > 4096) throw new AuthenticationError();
  const segments = token.split(".");
  if (segments.length !== 3 || segments.some((segment) => segment === "")) {
    throw new AuthenticationError();
  }
  const [encodedHeader, encodedClaims, providedSignature] = segments;
  if (!encodedHeader || !encodedClaims || !providedSignature) {
    throw new AuthenticationError();
  }
  const header = TokenHeaderSchema.safeParse(parseJsonSegment(encodedHeader));
  if (!header.success) throw new AuthenticationError();
  const expected = createHmac("sha256", configuration.jwtSigningKey)
    .update(`${encodedHeader}.${encodedClaims}`)
    .digest();
  if (!/^[A-Za-z0-9_-]+$/.test(providedSignature)) {
    throw new AuthenticationError();
  }
  const actual = Buffer.from(providedSignature, "base64url");
  if (
    actual.length !== expected.length ||
    actual.toString("base64url") !== providedSignature ||
    !timingSafeEqual(actual, expected)
  ) {
    throw new AuthenticationError();
  }

  const claimsResult = TokenClaimsSchema.safeParse(
    parseJsonSegment(encodedClaims),
  );
  if (!claimsResult.success) throw new AuthenticationError();
  const claims = claimsResult.data;
  if (
    claims.iss !== configuration.jwtIssuer ||
    claims.aud !== configuration.jwtAudience ||
    claims.iat > now ||
    claims.exp <= now ||
    claims.exp - claims.iat !== configuration.jwtTtlSeconds
  ) {
    throw new AuthenticationError();
  }
  return claims;
}

export function createUserAccessKey(
  userId: string,
  expiresAt: string | null = null,
  now = new Date(),
): { record: AccessKeyRecord; plaintext: string } {
  if (expiresAt !== null) {
    TimestampSchema.parse(expiresAt);
    if (Date.parse(expiresAt) <= now.getTime()) {
      throw new Error("Access-key expiry must be in the future");
    }
  }
  const id = randomBytes(18).toString("base64url");
  const plaintext = `evk_${id}.${randomBytes(32).toString("base64url")}`;
  return {
    record: {
      id,
      userId,
      keyHash: hashAccessKey(plaintext),
      keyPrefix: `evk_${id}`,
      expiresAt,
      lastUsedAt: null,
      revokedAt: null,
      createdAt: now.toISOString(),
    },
    plaintext,
  };
}

export class AuthenticationService {
  constructor(
    private readonly repositories: AuthenticationRepositories,
    private readonly configuration: AuthConfiguration,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async exchangeAccessKey(plaintext: unknown): Promise<{
    accessToken: string;
    tokenType: "Bearer";
    expiresIn: 1800;
  } | null> {
    const parsedInput = AccessKeyInputSchema.safeParse(plaintext);
    if (!parsedInput.success) return null;
    const keyMatch = /^evk_([A-Za-z0-9_-]+)\./.exec(parsedInput.data);
    const keyId = keyMatch?.[1];
    if (!keyId) return null;

    const now = this.now();
    const timestamp = now.toISOString();
    const accessKey = await this.repositories.accessKeys.findActiveById(
      keyId,
      timestamp,
    );
    if (
      !accessKey ||
      !secureEqualHex(accessKey.keyHash, hashAccessKey(parsedInput.data))
    ) {
      return null;
    }
    const user = await this.repositories.users.findById(accessKey.userId);
    if (!user || user.disabledAt !== null) return null;

    const issuedAt = Math.floor(now.getTime() / 1000);
    const expiresAt = new Date(
      (issuedAt + this.configuration.jwtTtlSeconds) * 1000,
    ).toISOString();
    const sessionId = randomUUID();
    const session: SessionRecord = {
      id: sessionId,
      userId: user.id,
      accessKeyId: accessKey.id,
      issuedAt: new Date(issuedAt * 1000).toISOString(),
      expiresAt,
      revokedAt: null,
      createdAt: timestamp,
    };
    await this.repositories.sessions.insert(session);
    await this.repositories.accessKeys.markUsed(accessKey.id, timestamp);

    const accessToken = signJwt(
      {
        sub: user.id,
        jti: sessionId,
        iss: this.configuration.jwtIssuer,
        aud: this.configuration.jwtAudience,
        iat: issuedAt,
        exp: issuedAt + this.configuration.jwtTtlSeconds,
      },
      this.configuration.jwtSigningKey,
    );
    return { accessToken, tokenType: "Bearer", expiresIn: 1800 };
  }

  async authenticate(token: string): Promise<AuthContext> {
    const now = this.now();
    const claims = verifyJwt(
      token,
      this.configuration,
      Math.floor(now.getTime() / 1000),
    );
    const at = now.toISOString();
    const session = await this.repositories.sessions.findActiveById(
      claims.jti,
      at,
    );
    if (
      !session ||
      session.userId !== claims.sub ||
      session.accessKeyId === null ||
      Math.floor(Date.parse(session.issuedAt) / 1000) !== claims.iat ||
      Math.floor(Date.parse(session.expiresAt) / 1000) !== claims.exp
    ) {
      throw new AuthenticationError();
    }
    const [accessKey, user] = await Promise.all([
      this.repositories.accessKeys.findActiveById(session.accessKeyId, at),
      this.repositories.users.findById(session.userId),
    ]);
    if (
      !accessKey ||
      accessKey.userId !== session.userId ||
      !user ||
      user.disabledAt !== null
    ) {
      throw new AuthenticationError();
    }
    return {
      principal: PrincipalSchema.parse({ userId: user.id, role: user.role }),
      userEmail: user.email,
      userDisplayName: user.displayName,
      session,
      accessKey,
    };
  }

  async logout(
    sessionId: string,
    at = this.now().toISOString(),
  ): Promise<void> {
    await this.repositories.sessions.revoke(sessionId, at);
  }

  async checkRateLimit(
    key: string,
    limit: number,
    at = this.now().toISOString(),
  ): Promise<{ allowed: boolean; resetAt: string }> {
    const result = await this.repositories.rateLimits.consume({
      key,
      limit,
      windowSeconds: 60,
      at,
    });
    return { allowed: result.allowed, resetAt: result.resetAt };
  }
}

export function createRateLimitKey(
  secret: string,
  category: "auth-source" | "api-user",
  subject: string,
): string {
  return createHmac("sha256", secret)
    .update(`${category}:${subject}`)
    .digest("hex");
}

type RequestWithAuth = Request & { authContext?: AuthContext };

function authFailure(response: Response): void {
  response.status(401).json({
    error: { code: "unauthorized", message: "Authentication required" },
  });
}

export function requirePrincipal(
  request: Request,
  response: Response,
  next: NextFunction,
): void {
  if (!(request as RequestWithAuth).authContext) {
    authFailure(response);
    return;
  }
  next();
}

export function requireAdmin(
  request: Request,
  response: Response,
  next: NextFunction,
): void {
  const context = (request as RequestWithAuth).authContext;
  if (!context) {
    authFailure(response);
    return;
  }
  if (context.principal.role !== "admin") {
    response.status(403).json({
      error: { code: "forbidden", message: "Administrator access required" },
    });
    return;
  }
  next();
}

export function requireCaseOwner(
  cases: CaseRepository,
  caseId: (request: Request) => string | undefined = (request) =>
    typeof request.params.caseId === "string"
      ? request.params.caseId
      : undefined,
): (request: Request, response: Response, next: NextFunction) => void {
  return (request, response, next) => {
    const context = (request as RequestWithAuth).authContext;
    const id = caseId(request);
    if (!context) {
      authFailure(response);
      return;
    }
    if (!id) {
      response.status(404).json({
        error: { code: "not_found", message: "Resource not found" },
      });
      return;
    }
    void cases
      .findOwnedById(id, context.principal.userId)
      .then((record) => {
        if (!record) {
          response.status(404).json({
            error: { code: "not_found", message: "Resource not found" },
          });
          return;
        }
        next();
      })
      .catch(next);
  };
}

export function bearerToken(request: Request): string | null {
  const value = request.get("authorization");
  const match = value ? /^Bearer ([^\s]+)$/i.exec(value) : null;
  return match?.[1] ?? null;
}
