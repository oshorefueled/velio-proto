import "../src/config.ts";
import { spawnSync } from "node:child_process";
import { expect, it } from "vitest";

it("when an idle PostgreSQL connection is terminated, keeps the process alive and serves the next query", () => {
  const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module"], {
    cwd: process.cwd(),
    input: `
      import { Client } from "pg";
      import { createPool } from "./src/db/pool.ts";
      const pool = createPool(process.env.DATABASE_URL);
      const killer = new Client({ connectionString: process.env.DATABASE_URL });
      await killer.connect();
      const { rows } = await pool.query("SELECT pg_backend_pid() AS pid");
      await killer.query("SELECT pg_terminate_backend($1)", [rows[0].pid]);
      await new Promise(resolve => setTimeout(resolve, 100));
      const recovered = await pool.query("SELECT 1 AS value");
      if (recovered.rows[0].value !== 1) process.exitCode = 1;
      await killer.end();
      await pool.end();
    `,
    encoding: "utf8",
    timeout: 10_000,
  });
  expect(result.error).toBeUndefined();
  expect(result.signal).toBeNull();
  expect(result.status).toBe(0);
});
