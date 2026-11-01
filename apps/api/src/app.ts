import type { CaseRepository } from "@evianta/core";
import { randomUUID } from "node:crypto";
import express, {
  type ErrorRequestHandler,
  type Express,
  type Request,
  type RequestHandler,
  type Response,
} from "express";
import {
  AuthenticationError,
  AuthenticationService,
  bearerToken,
  createRateLimitKey,
  requireAdmin,
  requireCaseOwner,
  requirePrincipal,
  type AuthConfiguration,
  type AuthenticationRepositories,
} from "./auth.js";
import { sendApiError } from "./errors.js";

export interface ApiAppConfiguration extends AuthConfiguration {
  webOrigin: string;
  trustProxyHops: number;
  sessionRecheckSeconds: number;
}

export interface ApiAppRepositories extends AuthenticationRepositories {
  cases: CaseRepository;
}

export interface ApiAppOptions {
  repositories: ApiAppRepositories;
  configuration: ApiAppConfiguration;
  now?: () => Date;
  registerRoutes?: (context: {
    app: Express;
    authenticate: RequestHandler;
    service: AuthenticationService;
    configuration: ApiAppConfiguration;
    repositories: ApiAppRepositories;
  }) => void;
}

export interface ApiApp {
  app: Express;
  service: AuthenticationService;
  guards: {
    requireAdmin: typeof requireAdmin;
    requireCaseOwner: (
      caseId?: (request: Request) => string | undefined,
    ) => ReturnType<typeof requireCaseOwner>;
  };
}

type RequestWithAuth = Request & {
  authContext?: Awaited<ReturnType<AuthenticationService["authenticate"]>>;
};

function sendRateLimitError(response: Response, resetAt: string): void {
  response.setHeader(
    "Retry-After",
    String(Math.max(1, Math.ceil((Date.parse(resetAt) - Date.now()) / 1000))),
  );
  sendApiError(response, 429, "limit-reached", "Too many requests");
}

export function createAuthenticationMiddleware(
  service: AuthenticationService,
  configuration: ApiAppConfiguration,
  options: { enforceRateLimit?: boolean } = {},
): RequestHandler {
  return (request, response, next) => {
    const token = bearerToken(request);
    if (!token) {
      sendApiError(response, 401, "unauthenticated", "Authentication required");
      return;
    }

    void service
      .authenticate(token)
      .then(async (context) => {
        const requestWithAuth = request as RequestWithAuth;
        requestWithAuth.authContext = context;
        if (options.enforceRateLimit === false) {
          next();
          return;
        }
        const key = createRateLimitKey(
          configuration.jwtSigningKey,
          "api-user",
          context.principal.userId,
        );
        const result = await service.checkRateLimit(
          key,
          configuration.apiRateLimitPerMinute,
        );
        if (!result.allowed) {
          sendRateLimitError(response, result.resetAt);
          return;
        }
        next();
      })
      .catch((error: unknown) => {
        if (error instanceof AuthenticationError) {
          sendApiError(
            response,
            401,
            "unauthenticated",
            "Authentication required",
          );
          return;
        }
        next(error);
      });
  };
}

export function createApiApp(options: ApiAppOptions): ApiApp {
  const { configuration, repositories } = options;
  const service = new AuthenticationService(
    repositories,
    configuration,
    options.now,
  );
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", configuration.trustProxyHops);
  app.use((request, response, next) => {
    const requestId = randomUUID();
    response.locals.requestId = requestId;
    response.setHeader("x-request-id", requestId);
    response.setHeader("Cache-Control", "no-store");
    response.vary("Origin");
    const origin = request.get("origin");
    if (origin && origin !== configuration.webOrigin) {
      sendApiError(response, 403, "forbidden", "Origin not allowed");
      return;
    }
    if (origin) {
      response.setHeader(
        "Access-Control-Allow-Origin",
        configuration.webOrigin,
      );
      response.setHeader(
        "Access-Control-Allow-Headers",
        "Authorization, Content-Type, Last-Event-ID",
      );
      response.setHeader(
        "Access-Control-Allow-Methods",
        "GET, POST, DELETE, OPTIONS",
      );
    }
    if (request.method === "OPTIONS") {
      response.status(204).end();
      return;
    }
    next();
  });
  const authSourceLimit: RequestHandler = (request, response, next) => {
    const source = request.ip ?? request.socket.remoteAddress ?? "unknown";
    const rateLimitKey = createRateLimitKey(
      configuration.jwtSigningKey,
      "auth-source",
      source,
    );
    void service
      .checkRateLimit(rateLimitKey, configuration.authRateLimitPerMinute)
      .then((limit) => {
        if (!limit.allowed) {
          sendRateLimitError(response, limit.resetAt);
          return;
        }
        next();
      })
      .catch(next);
  };
  app.post(
    "/auth/token",
    authSourceLimit,
    express.json({ limit: "8kb", strict: true }),
    (request, response, next) => {
      void service
        .exchangeAccessKey(request.body?.accessKey)
        .then((result) => {
          if (!result) {
            sendApiError(
              response,
              401,
              "unauthenticated",
              "Access key is invalid",
            );
            return;
          }
          response.status(200).json(result);
        })
        .catch(next);
    },
  );
  app.patch(
    "/cases/:caseId/deliverables/:deliverableId/sections/:sectionId",
    express.json({ limit: "512kb", strict: true }),
  );
  app.use(express.json({ limit: "8kb", strict: true }));

  app.get("/healthz", (_request, response) => {
    response.status(200).json({ status: "ok" });
  });

  const authenticated = createAuthenticationMiddleware(service, configuration);
  app.post(
    "/auth/logout",
    createAuthenticationMiddleware(service, configuration, {
      enforceRateLimit: false,
    }),
    requirePrincipal,
    (request, response, next) => {
      const context = (request as RequestWithAuth).authContext;
      if (!context) {
        sendApiError(
          response,
          401,
          "unauthenticated",
          "Authentication required",
        );
        return;
      }
      void service
        .logout(context.session.id)
        .then(() => response.status(204).end())
        .catch(next);
    },
  );
  app.get("/auth/me", authenticated, requirePrincipal, (request, response) => {
    const context = (request as RequestWithAuth).authContext;
    if (!context) {
      sendApiError(response, 401, "unauthenticated", "Authentication required");
      return;
    }
    response.status(200).json({
      user: {
        id: context.principal.userId,
        email: context.userEmail,
        displayName: context.userDisplayName,
        role: context.principal.role,
      },
      session: { expiresAt: context.session.expiresAt },
    });
  });

  options.registerRoutes?.({
    app,
    authenticate: authenticated,
    service,
    configuration,
    repositories,
  });

  app.use((_request, response) => {
    sendApiError(response, 404, "not-found", "Resource not found");
  });

  const errorHandler: ErrorRequestHandler = (
    error: unknown,
    request,
    response,
    _next,
  ) => {
    void _next;
    const errorCode =
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      typeof error.code === "string"
        ? error.code
        : undefined;
    const declaredStatus =
      typeof error === "object" &&
      error !== null &&
      "status" in error &&
      typeof error.status === "number"
        ? error.status
        : undefined;
    const status =
      error instanceof AuthenticationError
        ? 401
        : declaredStatus &&
            [400, 403, 404, 409, 413, 415, 429].includes(declaredStatus)
          ? declaredStatus
          : errorCode === "not-found"
            ? 404
            : errorCode === "admin-required"
              ? 403
              : errorCode === "invalid-cursor"
                ? 400
                : errorCode === "run-conflict" ||
                    errorCode === "duplicate-record" ||
                    errorCode === "run-case-active" ||
                    errorCode === "case-not-active" ||
                    errorCode === "invalid-run-admission" ||
                    errorCode === "run-admission-counter-conflict"
                  ? 409
                  : errorCode === "run-concurrency-limit" ||
                      errorCode === "spend-limit-exceeded" ||
                      errorCode === "usage-admission-rejected"
                    ? 429
                    : 500;
    if (status === 500) {
      const errorName = error instanceof Error ? error.name : "UnknownError";
      console.error("API request failed", {
        method: request.method,
        errorName,
      });
    }
    const code =
      status === 401
        ? "unauthenticated"
        : status === 403
          ? "forbidden"
          : status === 404
            ? "not-found"
            : status === 409
              ? "conflict"
              : status === 429 || status === 413
                ? "limit-reached"
                : status === 500
                  ? "internal-error"
                  : "validation-failed";
    const message =
      status === 401
        ? "Authentication required"
        : status === 403
          ? "Access is forbidden"
          : status === 404
            ? "Resource not found"
            : status === 409
              ? "The request conflicts with current state"
              : status === 429
                ? "A request or usage limit was reached"
                : status === 413
                  ? "Request body is too large"
                  : status === 415
                    ? "Request content type or encoding is not supported"
                    : status === 400
                      ? "Request body is invalid"
                      : "An unexpected error occurred";
    if (status === 429) response.setHeader("Retry-After", "60");
    const reason =
      status === 429
        ? errorCode === "run-concurrency-limit"
          ? "run-concurrency-limit"
          : errorCode === "spend-limit-exceeded"
            ? "spend-limit-exceeded"
            : "usage-admission-rejected"
        : status === 409
          ? errorCode === "run-case-active"
            ? "run-case-active"
            : "request-conflict"
          : undefined;
    sendApiError(
      response,
      status,
      code,
      message,
      reason ? [{ path: ["reason"], message: reason }] : [],
    );
  };
  app.use(errorHandler);

  return {
    app,
    service,
    guards: {
      requireAdmin,
      requireCaseOwner: (caseId?: (request: Request) => string | undefined) =>
        requireCaseOwner(repositories.cases, caseId),
    },
  };
}
