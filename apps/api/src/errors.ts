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
  const body: ApiError = {
    error: {
      code,
      message,
      requestId: randomUUID(),
      details,
    },
  };
  response.status(status).json(body);
}
