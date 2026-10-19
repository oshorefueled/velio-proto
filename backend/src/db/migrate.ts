import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { Client } from "pg";

export interface MigrationResult {
  applied: string[];
  skipped: string[];
}

const MIGRATIONS_LOCK_KEY = "velio:schema-migrations";

/**
 * Apply pending `*.sql` migrations from `dir` in lexicographic order, each in
 * its own transaction guarded by an advisory lock so concurrent runners
 * serialize. Applied names are recorded in `schema_migrations`; recorded
 * migrations are skipped on later runs.
 */
export async function runMigrations(options: {
  migrationUrl: string;
  dir: string;
}): Promise<MigrationResult> {
  const files = readdirSync(options.dir)
    .filter((name) => name.endsWith(".sql"))
    .sort();

  const client = new Client({ connectionString: options.migrationUrl });
  await client.connect();
  const applied: string[] = [];
  const skipped: string[] = [];

  try {
    // Bootstrap under the same advisory lock the migrations use: concurrent
    // CREATE TABLE IF NOT EXISTS attempts otherwise race in PostgreSQL's
    // type catalog (duplicate pg_type key) before any migration lock is held.
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [MIGRATIONS_LOCK_KEY]);
    await client.query(
      `CREATE TABLE IF NOT EXISTS schema_migrations (
         name text PRIMARY KEY,
         applied_at timestamptz NOT NULL DEFAULT now()
       )`,
    );
    await client.query("COMMIT");
    const existing = new Set(
      (await client.query<{ name: string }>("SELECT name FROM schema_migrations")).rows.map(
        (row) => row.name,
      ),
    );

    for (const file of files) {
      if (existing.has(file)) {
        skipped.push(file);
        continue;
      }
      const sql = readFileSync(path.join(options.dir, file), "utf8");
      await client.query("BEGIN");
      try {
        await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [MIGRATIONS_LOCK_KEY]);
        // Re-check under the lock: a concurrent runner may have applied this
        // migration after the pre-lock snapshot was taken.
        const alreadyApplied = await client.query("SELECT 1 FROM schema_migrations WHERE name = $1", [file]);
        if ((alreadyApplied.rowCount ?? 0) > 0) {
          await client.query("ROLLBACK");
          skipped.push(file);
          continue;
        }
        await client.query(sql);
        await client.query("INSERT INTO schema_migrations (name) VALUES ($1)", [file]);
        await client.query("COMMIT");
        applied.push(file);
      } catch (err) {
        await client.query("ROLLBACK");
        const message = err instanceof Error ? err.message : String(err);
        throw new Error(`Migration ${file} failed: ${message}`);
      }
    }
  } finally {
    await client.end();
  }

  return { applied, skipped };
}
