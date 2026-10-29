import { createHash } from "node:crypto";
import type {
  RateLimitRepository,
  RateLimitRequest,
  RateLimitResult,
} from "@evianta/core";
import {
  type Collection,
  type Document,
  type UpdateFilter,
  MongoServerError,
} from "mongodb";
import { z } from "zod";

export type MongoRateLimitCounter = Document & {
  _id: string;
  count: number;
  expiresAt: Date;
};

const TimestampSchema = z.string().datetime({ offset: true });

export class MongoRateLimitRepository implements RateLimitRepository {
  constructor(
    private readonly counters: Collection<MongoRateLimitCounter>,
    private readonly createStoreError: (message: string, code: string) => Error,
  ) {}

  async initialize(): Promise<void> {
    await this.counters.createIndex(
      { expiresAt: 1 },
      { expireAfterSeconds: 0 },
    );
  }

  async consume(request: RateLimitRequest): Promise<RateLimitResult> {
    const at = Date.parse(TimestampSchema.parse(request.at));
    if (
      !Number.isSafeInteger(request.limit) ||
      request.limit < 1 ||
      !Number.isSafeInteger(request.windowSeconds) ||
      request.windowSeconds < 1 ||
      !request.key
    ) {
      throw this.createStoreError(
        "Rate-limit request is invalid",
        "invalid-rate-limit",
      );
    }

    const windowMs = request.windowSeconds * 1000;
    const windowStart = Math.floor(at / windowMs) * windowMs;
    const resetMs = windowStart + windowMs;
    const keyHash = createHash("sha256").update(request.key).digest("hex");
    const id = `${keyHash}:${windowStart}`;
    const update: UpdateFilter<MongoRateLimitCounter> = {
      $setOnInsert: { expiresAt: new Date(resetMs + windowMs) },
      $inc: { count: 1 },
    };
    let counter: MongoRateLimitCounter | null;
    try {
      counter = await this.counters.findOneAndUpdate({ _id: id }, update, {
        upsert: true,
        returnDocument: "after",
      });
    } catch (error) {
      if (!(error instanceof MongoServerError) || error.code !== 11000) {
        throw error;
      }
      counter = await this.counters.findOneAndUpdate(
        { _id: id },
        { $inc: { count: 1 } },
        { returnDocument: "after" },
      );
    }
    if (!counter || typeof counter.count !== "number") {
      throw this.createStoreError(
        "Rate-limit counter was not updated",
        "rate-limit-storage",
      );
    }
    return {
      allowed: counter.count <= request.limit,
      count: counter.count,
      resetAt: new Date(resetMs).toISOString(),
    };
  }
}
