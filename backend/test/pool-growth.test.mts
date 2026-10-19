import "../src/config.ts";
import { describe, expect, it } from "vitest";
import { createPool } from "../src/db/pool.ts";
import { urlFor } from "./support/db.mts";

describe("pool growth", () => {
  // The concurrency proof depends on the pool actually growing under
  // parallel load rather than serializing every query on one client.
  it("serves 30 concurrent queries with 30 distinct backends", async () => {
    const pool = createPool(urlFor("DATABASE_URL", "velio_test"), { max: 30, connectionTimeoutMillis: 10000 });
    const pids = await Promise.all(
      Array.from({ length: 30 }, () =>
        pool
          .query("SELECT pg_backend_pid() AS pid, pg_sleep(0.15) IS NULL AS ok")
          .then((r) => r.rows[0].pid as number),
      ),
    );
    await pool.end();
    expect(new Set(pids).size).toBe(30);
  }, 30_000);
});
