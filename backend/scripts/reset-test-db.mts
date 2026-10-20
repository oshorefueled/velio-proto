import "../src/config.ts"; // loads the repo-root .env into process.env
import { resetAndMigrate, urlFor } from "../test/support/db.mts";

/**
 * Recreate the velio_test schema with the real migrations — the same reset
 * every backend test file performs. Use it when an interrupted run leaves
 * velio_test partly migrated before `npm run acceptance:load`.
 */
await resetAndMigrate(urlFor("MIGRATION_DATABASE_URL", "velio_test"));
console.log("velio_test reset and migrated");
