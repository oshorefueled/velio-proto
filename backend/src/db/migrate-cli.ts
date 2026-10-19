import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../config.js";
import { runMigrations } from "./migrate.js";

const thisDir = path.dirname(fileURLToPath(import.meta.url));
const migrationsDir = path.resolve(thisDir, "../../migrations");

const config = loadConfig();
try {
  const { applied, skipped } = await runMigrations({
    migrationUrl: config.migrationDatabaseUrl,
    dir: migrationsDir,
  });
  for (const name of applied) console.log(`applied  ${name}`);
  for (const name of skipped) console.log(`skipped  ${name} (already recorded)`);
  console.log(`migrations complete: ${applied.length} applied, ${skipped.length} skipped`);
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
}
