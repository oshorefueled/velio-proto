import { Pool, type PoolConfig } from "pg";

/**
 * Create a connection pool. Every pool gets a finite connection timeout so a
 * dead database surfaces as a failed check instead of a hanging request.
 */
export function createPool(connectionString: string, overrides: PoolConfig = {}): Pool {
  const pool = new Pool({
    connectionString,
    connectionTimeoutMillis: 5000,
    ...overrides,
  });
  // pg removes failed idle clients; handle its error event so the API survives.
  pool.on("error", () => {});
  return pool;
}
