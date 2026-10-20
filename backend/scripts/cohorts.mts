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
  | "holdout_comparison"
  | "acquisition_audit";

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
  /** Whether this run can be read against its target, and the review trigger. */
  assessment: Assessment;
}

export interface Assessment {
  target: number | null;
  observed: number | null;
  /**
   * meets/below only for a mature, non-empty real cohort with a target;
   * not_assessable lists why; descriptive reports have no target.
   */
  status: "meets" | "below" | "not_assessable" | "descriptive";
  reasons: string[];
  trigger: string | null;
  note: string | null;
}

/** Observation window after cohort end, and the column that counts the sample. */
const REPORTS: Record<CohortQueryName, { windowHours: number; sample: string | null }> = {
  inviter_adoption: { windowHours: 24, sample: "bookers" },
  invite_conversion: { windowHours: 24, sample: "opportunities" },
  k_factor_by_rail: { windowHours: 0, sample: "cohort_inviters" },
  holdout_comparison: { windowHours: 0, sample: "activities" },
  acquisition_audit: { windowHours: 0, sample: null },
};

/** Wilson 95% score interval for a binomial proportion; null for an empty sample. */
export function wilsonInterval(successes: number, trials: number): [number | null, number | null] {
  if (trials === 0) return [null, null];
  const z = 1.96;
  const p = successes / trials;
  const denominator = 1 + (z * z) / trials;
  const centre = p + (z * z) / (2 * trials);
  const margin = z * Math.sqrt((p * (1 - p)) / trials + (z * z) / (4 * trials * trials));
  return [Math.max(0, (centre - margin) / denominator), Math.min(1, (centre + margin) / denominator)];
}

/** Rate intervals beside each row's numerator and denominator. */
function withUncertainty(name: CohortQueryName, row: Record<string, unknown>): Record<string, unknown> {
  if (name === "inviter_adoption") {
    const [low, high] = wilsonInterval(Number(row.inviters), Number(row.bookers));
    return { ...row, adoption_rate_ci_low: low, adoption_rate_ci_high: high };
  }
  if (name === "invite_conversion") {
    const [low, high] = wilsonInterval(Number(row.converted_opportunities), Number(row.opportunities));
    return { ...row, conversion_rate_ci_low: low, conversion_rate_ci_high: high };
  }
  if (name === "k_factor_by_rail") {
    const inviters = Number(row.cohort_inviters);
    if (inviters === 0) return { ...row, k_factor_ci_low: null, k_factor_ci_high: null };
    const [low, high] = poissonInterval(Number(row.acquired_users));
    return { ...row, k_factor_ci_low: low / inviters, k_factor_ci_high: high / inviters };
  }
  return row;
}

/** P(X <= k) for X ~ Poisson(lambda). */
function poissonCdf(k: number, lambda: number): number {
  let term = Math.exp(-lambda);
  let sum = term;
  for (let i = 1; i <= k; i++) {
    term *= lambda / i;
    sum += term;
  }
  return sum;
}

/** Exact (Garwood) 95% interval for a Poisson count, by bisection on the CDF. */
export function poissonInterval(count: number): [number, number] {
  const solve = (target: (lambda: number) => number): number => {
    let low = 0;
    let high = count + 10 * Math.sqrt(count + 1) + 10;
    for (let i = 0; i < 100; i++) {
      const mid = (low + high) / 2;
      if (target(mid) > 0) low = mid;
      else high = mid;
    }
    return (low + high) / 2;
  };
  const upper = solve((lambda) => poissonCdf(count, lambda) - 0.025);
  const lower = count === 0 ? 0 : solve((lambda) => poissonCdf(count - 1, lambda) - 0.975);
  return [lower, upper];
}

const TARGETS: Partial<Record<CohortQueryName, { target: number; rate: string; trigger: string }>> = {
  inviter_adoption: {
    target: 0.3,
    rate: "adoption_rate",
    trigger: "Mature inviter adoption is below 30%: review the post-booking invitation prompt and share flow.",
  },
  invite_conversion: {
    target: 0.25,
    rate: "conversion_rate",
    trigger: "Mature invite conversion is below 25%: review the landing-to-checkout drop-off by rail, channel and landing state.",
  },
};

const DESCRIPTIVE_NOTES: Partial<Record<CohortQueryName, string>> = {
  k_factor_by_rail:
    "No numerical K-factor target. Review when K declines across cohorts or acquired accounts do not progress to booking (acquired_booked_share). Vouch/public comparison is descriptive because users choose the rail.",
  holdout_comparison:
    "Booked participants per assigned activity is an intermediate outcome; actual occurrence is unmeasured. Arms are compared only within an experiment version.",
  acquisition_audit:
    "Signup acquisition is immutable; booking sources are per booking. Unlinked cross-device identity is not inferred.",
};

export function assess(run: Omit<CohortRun, "assessment">): Assessment {
  const reasons: string[] = [];
  if (run.cohort.dataset === "demo") reasons.push("demo_dataset: synthetic fixtures establish arithmetic and event plumbing only");
  if (!run.mature) reasons.push("incomplete_window");
  if (run.empty) reasons.push("empty_sample");
  const target = TARGETS[run.query];
  if (target === undefined) {
    return { target: null, observed: null, status: "descriptive", reasons, trigger: null, note: DESCRIPTIVE_NOTES[run.query] ?? null };
  }
  const rows = run.results[0] ?? [];
  const row = run.query === "invite_conversion" ? rows.find((r) => r.segment === "total") : rows[0];
  const raw = row?.[target.rate];
  const observed = raw === null || raw === undefined ? null : Number(raw);
  if (reasons.length > 0 || observed === null) {
    return { target: target.target, observed, status: "not_assessable", reasons, trigger: null, note: null };
  }
  const meets = observed >= target.target;
  return {
    target: target.target,
    observed,
    status: meets ? "meets" : "below",
    reasons,
    trigger: meets ? null : target.trigger,
    note: null,
  };
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
    const report = REPORTS[name];
    const first = (results[0] ?? []).map((row) => withUncertainty(name, row));
    const closesAt = Date.parse(cohort.end) + report.windowHours * 3600 * 1000;
    const remaining = Math.max(0, (closesAt - Date.parse(asOf)) / 3600000);
    const sample = report.sample;
    const empty = sample === null ? first.length === 0 : first.every(row => Number(row[sample]) === 0);
    const run = {
      query: name,
      cohort,
      mature: remaining === 0,
      empty,
      remainingObservationHours: remaining,
      results: [first],
    };
    return { ...run, assessment: assess(run) };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

function isCohortQueryName(value: string): value is CohortQueryName {
  return Object.hasOwn(REPORTS, value);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const name = argv[0];
  if (name === undefined || !isCohortQueryName(name)) {
    console.error(
      `usage: npm run cohorts -- <${Object.keys(REPORTS).join("|")}> --start <ISO> --end <ISO> [--as-of <ISO>] [--dataset real|demo]`,
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
