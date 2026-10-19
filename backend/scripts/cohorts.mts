import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { Pool, PoolClient, QueryResult } from "pg";
import { loadConfig } from "../src/config.js";

/**
 * Reproducible product-cohort runner (PLANS.md 4.3, ticket #12). Executes
 * one of the queries/*.sql reports against PostgreSQL with explicit,
 * validated inputs: a seven-day half-open cohort [start, end), an as-of
 * database timestamp (default: the database clock; fixtures pass an exact
 * timestamp) and the dataset selector (default 'real'; 'demo' is an explicit
 * opt-in). Inputs are always bound parameters — nothing from the command
 * line is ever interpolated into SQL.
 *
 * Usage:
 *   npm run cohorts -- inviter_adoption --start 2026-01-01T00:00:00Z --end 2026-01-08T00:00:00Z \
 *     [--as-of 2026-01-20T00:00:00Z] [--dataset real|demo]
 */

export type CohortQueryName =
  | "inviter_adoption"
  | "invite_conversion"
  | "k_factor_by_rail"
  | "plan_completion_by_arm";

export interface CohortInputs {
  start: string;
  end: string;
  asOf?: string;
  dataset?: string;
}

export interface CohortRun {
  query: CohortQueryName;
  cohort: { start: string; end: string; asOf: string; dataset: string };
  /** True when every included observation window has ended at as-of. */
  mature: boolean;
  /** No eligible people/activities, independently of maturity. */
  empty: boolean;
  /** Hours until the report's widest observation window ends (0 when mature). */
  remainingObservationHours: number;
  /** One row set from the report statement, including its diagnostic rows. */
  results: Array<Record<string, unknown>[]>;
}

const QUERIES_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../../queries");

const SEVEN_DAYS_MS = 7 * 24 * 3600 * 1000;

function requireIso(value: string, name: string): string {
  if (typeof value !== "string" ||
      !/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,3})?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.test(value) ||
      Number.isNaN(Date.parse(value)) ||
      new Date(`${value.slice(0, 10)}T00:00:00Z`).toISOString().slice(0, 10) !== value.slice(0, 10)) {
    throw new Error(`${name} must be an ISO-8601 timestamp, got: ${value}`);
  }
  return new Date(Date.parse(value)).toISOString();
}

/** Validate and normalize cohort inputs; rejects malformed/reversed/non-seven-day intervals. */
export function validateCohortInputs(inputs: CohortInputs): {
  start: string;
  end: string;
  asOf: string | null;
  dataset: string;
} {
  const start = requireIso(inputs.start, "start");
  const end = requireIso(inputs.end, "end");
  if (Date.parse(end) - Date.parse(start) !== SEVEN_DAYS_MS) {
    throw new Error(
      `cohort must be exactly seven days as a half-open [start, end) interval, got ${start}..${end}`,
    );
  }
  if (inputs.dataset !== undefined && inputs.dataset !== "real" && inputs.dataset !== "demo") {
    throw new Error(`dataset must be 'real' or 'demo', got: ${inputs.dataset}`);
  }
  return {
    start,
    end,
    asOf: inputs.asOf === undefined ? null : requireIso(inputs.asOf, "as-of"),
    dataset: inputs.dataset ?? "real",
  };
}

/** Execute one named report in a consistent read-only snapshot. */
export async function runCohortQuery(
  pool: Pool,
  name: CohortQueryName,
  inputs: CohortInputs,
): Promise<CohortRun> {
  const validated = validateCohortInputs(inputs);
  const sql = readFileSync(resolve(QUERIES_DIR, `${name}.sql`), "utf8");
  const client: PoolClient = await pool.connect();
  try {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    let asOf: string;
    if (validated.asOf !== null) {
      asOf = validated.asOf;
    } else {
      // Default as-of is the database clock, so a run is reproducible against
      // one explicit timestamp whenever it is passed.
      const clock = await client.query<{ now: Date }>("SELECT clock_timestamp() AS now");
      asOf = clock.rows[0]!.now.toISOString();
    }
    const cohort = { start: validated.start, end: validated.end, asOf, dataset: validated.dataset };
    const params = [cohort.start, cohort.end, cohort.asOf, cohort.dataset];
    const result: QueryResult = await client.query(sql, params);
    const results = [result.rows as Record<string, unknown>[]];
    await client.query("COMMIT");
    const first = results[0] ?? [];
    const closesAt = Date.parse(cohort.end) + (name === "k_factor_by_rail" ? 0 : 24 * 3600 * 1000);
    const remaining = Math.max(0, (closesAt - Date.parse(asOf)) / 3600000);
    const denominator = {
      inviter_adoption: "bookers", invite_conversion: "opportunities",
      k_factor_by_rail: "cohort_inviters", plan_completion_by_arm: "activities",
    }[name];
    const empty = first.every(row => Number(row[denominator]) === 0);
    return {
      query: name,
      cohort,
      mature: remaining === 0,
      empty,
      remainingObservationHours: remaining,
      results,
    };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

function isCohortQueryName(value: string): value is CohortQueryName {
  return ["inviter_adoption", "invite_conversion", "k_factor_by_rail", "plan_completion_by_arm"].includes(value);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const name = argv[0];
  if (name === undefined || !isCohortQueryName(name)) {
    console.error(
      "usage: npm run cohorts -- <inviter_adoption|invite_conversion|k_factor_by_rail|plan_completion_by_arm> --start <ISO> --end <ISO> [--as-of <ISO>] [--dataset real|demo]",
    );
    process.exit(2);
  }
  const inputs: Partial<CohortInputs> = {};
  for (let i = 1; i < argv.length; i += 2) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (flag === "--start") inputs.start = value ?? "";
    else if (flag === "--end") inputs.end = value ?? "";
    else if (flag === "--as-of") inputs.asOf = value ?? "";
    else if (flag === "--dataset") inputs.dataset = value ?? "";
    else {
      console.error(`unknown flag: ${flag}`);
      process.exit(2);
    }
  }
  const config = loadConfig();
  const { createPool } = await import("../src/db/pool.js");
  const pool = createPool(config.databaseUrl, { max: 2 });
  try {
    const run = await runCohortQuery(pool, name, inputs as CohortInputs);
    console.log(JSON.stringify(run, null, 2));
  } finally {
    await pool.end();
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
