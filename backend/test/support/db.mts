import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "pg";
import { runMigrations } from "../../src/db/migrate.ts";

const migrationsDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../migrations",
);

export function urlFor(envVar: string, dbName: string): string {
  const url = new URL(process.env[envVar] as string);
  url.pathname = `/${dbName}`;
  return url.href;
}

export async function withClient<T>(url: string, fn: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

/** Drop every table (keeping the schema, whose OID the default privileges track) and re-apply the real migrations. */
export async function resetAndMigrate(url: string): Promise<void> {
  await withClient(url, async (client) => {
    await client.query(`
      DO $$
      DECLARE table_name text;
      BEGIN
        FOR table_name IN SELECT tablename FROM pg_tables WHERE schemaname = 'public' LOOP
          EXECUTE format('DROP TABLE IF EXISTS %I CASCADE', table_name);
        END LOOP;
      END
      $$;
    `);
  });
  await runMigrations({ migrationUrl: url, dir: migrationsDir });
}

/** Remove identity data with the migration role (the app role cannot delete). */
export async function clearIdentityData(url: string): Promise<void> {
  await withClient(url, async (client) => {
    await client.query("DELETE FROM demo_sessions");
    await client.query("DELETE FROM events");
    // Links reference users, so they go before the people they correlate.
    await client.query("DELETE FROM visitor_identities");
    await client.query("DELETE FROM users");
  });
}
