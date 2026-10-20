import { describe, expect, it } from "vitest";
import { loadConfig, MissingConfigError } from "../src/config.ts";

const baseEnv = {
  DATABASE_URL: "postgres://velio_app:pw@localhost:5432/velio",
  MIGRATION_DATABASE_URL: "postgres://velio_migrator:pw@localhost:5432/velio",
  REDIS_URL: "redis://localhost:6379",
};

describe("loadConfig", () => {
  it("throws naming every missing required variable", () => {
    try {
      loadConfig({});
      expect.unreachable("loadConfig should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(MissingConfigError);
      const message = err instanceof Error ? err.message : String(err);
      expect(message).toContain("DATABASE_URL");
      expect(message).toContain("MIGRATION_DATABASE_URL");
      expect(message).toContain("REDIS_URL");
    }
  });

  it("applies documented defaults for optional settings", () => {
    const config = loadConfig(baseEnv);
    expect(config.port).toBe(3000);
    expect(config.readyCheckTimeoutMs).toBe(2000);
    expect(config.demoSessionTtlHours).toBe(12);
    expect(config.experimentVersion).toBe("rollout-1");
    expect(config.experimentTreatmentAllocationPercent).toBe(10);
    expect(config.experimentInviteCreationEnabled).toBe(true);
    expect(config.inviteExpiryHours).toBe(336);
    expect(config.logLevel).toBe("info");
  });

  it("keeps the required connection settings verbatim", () => {
    const config = loadConfig(baseEnv);
    expect(config.databaseUrl).toBe(baseEnv.DATABASE_URL);
    expect(config.migrationDatabaseUrl).toBe(baseEnv.MIGRATION_DATABASE_URL);
    expect(config.redisUrl).toBe(baseEnv.REDIS_URL);
  });

  it("rejects non-positive timeouts and ports", () => {
    expect(() => loadConfig({ ...baseEnv, READY_CHECK_TIMEOUT_MS: "0" })).toThrow(
      /READY_CHECK_TIMEOUT_MS/,
    );
    expect(() => loadConfig({ ...baseEnv, PORT: "not-a-number" })).toThrow(/PORT/);
    expect(() => loadConfig({ ...baseEnv, DEMO_SESSION_TTL_HOURS: "0" })).toThrow(
      /DEMO_SESSION_TTL_HOURS/,
    );
  });

  it("rejects a malformed invite expiry", () => {
    for (const [key, value] of [
      ["INVITE_EXPIRY_HOURS", "0"],
      ["INVITE_EXPIRY_HOURS", "14.5"],
    ] as const) {
      expect(() => loadConfig({ ...baseEnv, [key]: value })).toThrow(new RegExp(key));
    }
  });

  it("rejects malformed allocations before they can change the rollout", () => {
    for (const value of ["10.5", "10percent", "1e2", "", "Infinity"]) {
      expect(() => loadConfig({ ...baseEnv, EXPERIMENT_TREATMENT_ALLOCATION_PERCENT: value }))
        .toThrow(/EXPERIMENT_TREATMENT_ALLOCATION_PERCENT/);
    }
  });

  it("rejects an experiment version that cannot be saved with an activity", () => {
    expect(() => loadConfig({ ...baseEnv, EXPERIMENT_VERSION: "v".repeat(65) }))
      .toThrow(/EXPERIMENT_VERSION/);
    expect(loadConfig({ ...baseEnv, EXPERIMENT_VERSION: "v".repeat(64) }).experimentVersion)
      .toBe("v".repeat(64));
  });

  it("rejects out-of-range allocation and malformed switch values", () => {
    expect(() =>
      loadConfig({ ...baseEnv, EXPERIMENT_TREATMENT_ALLOCATION_PERCENT: "101" }),
    ).toThrow(/EXPERIMENT_TREATMENT_ALLOCATION_PERCENT/);
    expect(() =>
      loadConfig({ ...baseEnv, EXPERIMENT_TREATMENT_ALLOCATION_PERCENT: "-1" }),
    ).toThrow(/EXPERIMENT_TREATMENT_ALLOCATION_PERCENT/);
    expect(() =>
      loadConfig({ ...baseEnv, EXPERIMENT_INVITE_CREATION_ENABLED: "yes" }),
    ).toThrow(/EXPERIMENT_INVITE_CREATION_ENABLED/);
    expect(() => loadConfig({ ...baseEnv, EXPERIMENT_VERSION: "   " })).toThrow(/EXPERIMENT_VERSION/);
    expect(loadConfig({ ...baseEnv, EXPERIMENT_TREATMENT_ALLOCATION_PERCENT: "0" })
      .experimentTreatmentAllocationPercent).toBe(0);
    expect(loadConfig({ ...baseEnv, EXPERIMENT_TREATMENT_ALLOCATION_PERCENT: "100" })
      .experimentTreatmentAllocationPercent).toBe(100);
  });
});
