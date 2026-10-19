import type { Pool } from "pg";
import type { Redis } from "ioredis";
import type { FastifyInstance } from "fastify";
import type { Dependencies } from "../deps.js";

export type CheckResult = { status: "ok" } | { status: "error"; error: string };

function failure(err: unknown): { status: "error"; error: string } {
  const message = err instanceof Error ? err.message : String(err);
  // Never publish an empty reason: a check must say why it is unavailable.
  return { status: "error", error: message.trim().length > 0 ? message : "dependency unavailable" };
}

/**
 * Resolve the check within the budget no matter what the dependency does.
 * Server-side timeouts cannot bound a dependency that has stopped answering
 * (a paused container, a partitioned connection), so every check carries a
 * client-side deadline.
 */
function withDeadline(check: Promise<CheckResult>, timeoutMs: number, dependency: string): Promise<CheckResult> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<CheckResult>((resolve) => {
    timer = setTimeout(
      () => resolve({ status: "error", error: `${dependency} did not answer within ${timeoutMs}ms` }),
      timeoutMs,
    );
  });
  return Promise.race([check, deadline]).finally(() => clearTimeout(timer));
}

export async function checkPostgres(pool: Pool, timeoutMs: number): Promise<CheckResult> {
  const check = pool
    .query("SELECT 1")
    .then((): CheckResult => ({ status: "ok" }))
    .catch(failure);
  return withDeadline(check, timeoutMs, "PostgreSQL");
}

/**
 * Resolve when the client reports `ready`, or reject within the budget.
 * Required because the offline queue is disabled: commands issued while the
 * socket is still connecting (or reconnecting) fail immediately.
 */
function onceReady(redis: Redis, timeoutMs: number): Promise<void> {
  if (redis.status === "ready") return Promise.resolve();
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      redis.removeListener("ready", onReady);
      redis.removeListener("error", onError);
    };
    const onReady = () => {
      cleanup();
      resolve();
    };
    const onError = (err: Error) => {
      cleanup();
      reject(err);
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`Redis not ready within ${timeoutMs}ms`));
    }, timeoutMs);
    redis.once("ready", onReady);
    redis.once("error", onError);
  });
}

export async function checkRedis(redis: Redis, timeoutMs: number): Promise<CheckResult> {
  try {
    await onceReady(redis, timeoutMs);
    // commandTimeout bounds the round trip, so a stalled connection also
    // resolves within the readiness budget instead of hanging.
    await redis.ping();
    return { status: "ok" };
  } catch (err) {
    return failure(err);
  }
}

type ReadyBody = {
  status: "ok" | "unavailable";
  checks: { postgres: CheckResult; redis: CheckResult };
};

export function registerReadyz(
  app: FastifyInstance,
  options: { deps: Dependencies; readyCheckTimeoutMs: number },
): void {
  const { deps, readyCheckTimeoutMs } = options;
  app.get("/readyz", async (_request, reply): Promise<ReadyBody> => {
    const [postgres, redis] = await Promise.all([
      checkPostgres(deps.pool, readyCheckTimeoutMs),
      checkRedis(deps.redis, readyCheckTimeoutMs),
    ]);
    const ready = postgres.status === "ok" && redis.status === "ok";
    void reply.code(ready ? 200 : 503);
    return {
      status: ready ? "ok" : "unavailable",
      checks: { postgres, redis },
    };
  });
}
