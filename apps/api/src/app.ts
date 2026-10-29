import type { CaseRepository } from "@evianta/core";
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
        "Authorization, Content-Type",
      );
      response.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
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
  app.use(express.json({ limit: "8kb", strict: true }));

  app.get("/healthz", (_request, response) => {
    response.status(200).json({ status: "ok" });
  });

  const authenticated = createAuthenticationMiddleware(service, configuration);
  app.post(
    "/auth/logout",
    authenticated,
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
    const status =
      typeof error === "object" &&
      error !== null &&
      "status" in error &&
      (error.status === 400 || error.status === 413)
        ? error.status
        : 500;
    if (status === 500) {
      const errorName = error instanceof Error ? error.name : "UnknownError";
      console.error("API request failed", {
        method: request.method,
        errorName,
      });
    }
    const code =
      status === 413
        ? "limit-reached"
        : status === 400
          ? "validation-failed"
          : error instanceof AuthenticationError
            ? "unauthenticated"
            : "internal-error";
    const message =
      status === 413
        ? "Request body is too large"
        : status === 400
          ? "Request body is invalid"
          : error instanceof AuthenticationError
            ? "Authentication required"
            : "An unexpected error occurred";
    sendApiError(response, status, code, message);
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
