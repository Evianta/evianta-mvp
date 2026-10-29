import { randomUUID } from "node:crypto";
import type { ApiError } from "@evianta/core";
import type { Response } from "express";

export function sendApiError(
  response: Response,
  status: number,
  code: ApiError["error"]["code"],
  message: string,
  details: ApiError["error"]["details"] = [],
): void {
  const requestId =
    typeof response.locals.requestId === "string"
      ? response.locals.requestId
      : randomUUID();
  const body: ApiError = {
    error: {
      code,
      message,
      requestId,
      details,
    },
  };
  response.setHeader("x-request-id", requestId);
  response.status(status).json(body);
}
