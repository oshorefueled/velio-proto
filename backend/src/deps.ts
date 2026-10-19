import { Redis } from "ioredis";
import type { Config } from "./config.js";
import { createPool } from "./db/pool.js";

export interface Dependencies {
  /** Application-role pool: DML only, used by every API path. */
  pool: ReturnType<typeof createPool>;
  redis: Redis;
}

export function createDependencies(config: Config): Dependencies {
  const pool = createPool(config.databaseUrl, {
    max: config.databasePoolMax,
    connectionTimeoutMillis: config.databaseConnectTimeoutMs,
    // Pool-wide statement budget, split from the readiness budget (ticket #4).
    statement_timeout: config.databaseStatementTimeoutMs,
  });
  const redis = new Redis(config.redisUrl, {
    // Readiness must fail within the configured budget, never hang: bound
    // every command, refuse offline queuing, and cap reconnect attempts per
    // command so a dead Redis surfaces as an error instead of a stall.
    commandTimeout: config.readyCheckTimeoutMs,
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
  });
  // ioredis emits connection errors on its own schedule (reconnect attempts);
  // the readiness check reports them. Swallow the event so the process lives.
  redis.on("error", () => {});
  return { pool, redis };
}
