#!/usr/bin/env node
// Automated startup check for ticket #1. Verifies the documented fresh-setup
// path against the real dependencies: stack up and healthy, migrations applied
// through the migration role, API readiness with PostgreSQL and Redis
// reachable, honest unavailability while Redis is down, and recovery after it
// returns. Exits non-zero on the first failed expectation.
import { spawn, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const backendDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = path.resolve(backendDir, "..");

function configuredPort() {
  if (process.env.PORT) return Number(process.env.PORT);
  try {
    const match = readFileSync(path.join(repoRoot, ".env"), "utf8").match(/^PORT=(\d+)/m);
    if (match) return Number(match[1]);
  } catch {
    // fall through to the documented default
  }
  return 3000;
}

const readyUrl = `http://localhost:${configuredPort()}/readyz`;

let server = null;
let serverLog = "";
let stoppingServer = false;

function fail(message) {
  console.error(`\nFAIL: ${message}`);
  if (serverLog.trim()) console.error(`--- server output ---\n${serverLog}`);
  stoppingServer = true;
  if (server) server.kill("SIGTERM");
  process.exit(1);
}

function run(name, cmd, args, opts = {}) {
  process.stdout.write(`==> ${name}\n`);
  const result = spawnSync(cmd, args, { stdio: "inherit", ...opts });
  if (result.status !== 0) fail(`${name} exited with status ${result.status}`);
}

async function pollReady(expect, label) {
  const deadline = Date.now() + 30_000;
  let last = "no response";
  while (Date.now() < deadline) {
    try {
      const response = await fetch(readyUrl);
      const raw = await response.text();
      let body;
      try {
        body = JSON.parse(raw);
      } catch {
        body = { raw };
      }
      if (expect(response.status, body)) return body;
      last = `HTTP ${response.status} ${raw}`;
    } catch (err) {
      last = err instanceof Error ? err.message : String(err);
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  fail(`readiness never met expectation (${label}): ${last}`);
}

run("start stack (wait until healthy)", "docker", ["compose", "up", "-d", "--wait"], {
  cwd: repoRoot,
});
run("apply migrations as the migration role", "npm", ["run", "migrate"], { cwd: backendDir });

server = spawn("npx", ["tsx", "src/server.ts"], {
  cwd: backendDir,
  stdio: ["ignore", "pipe", "pipe"],
});
server.stdout.on("data", (chunk) => (serverLog += chunk));
server.stderr.on("data", (chunk) => (serverLog += chunk));
server.on("exit", (code) => {
  // 143 is our own SIGTERM during cleanup; only an unsolicited exit is a failure.
  if (!stoppingServer && code !== null && code !== 0 && process.exitCode === undefined) {
    fail(`API server exited unexpectedly with code ${code}`);
  }
});

try {
  await pollReady(
    (status, body) =>
      status === 200 &&
      body.status === "ok" &&
      body.checks.postgres.status === "ok" &&
      body.checks.redis.status === "ok",
    "API ready with PostgreSQL and Redis reachable",
  );
  console.log(`PASS API is ready with PostgreSQL and Redis reachable (${readyUrl})`);

  run("failure drill: stop redis", "docker", ["compose", "stop", "redis"], { cwd: repoRoot });
  const degraded = await pollReady(
    (status, body) =>
      status === 503 &&
      body.status === "unavailable" &&
      body.checks.redis.status === "error" &&
      body.checks.postgres.status === "ok",
    "readiness reports unavailable without masking PostgreSQL",
  );
  console.log(
    `PASS readiness reports unavailable without masking PostgreSQL ` +
      `(redis check: ${degraded.checks.redis.error})`,
  );

  run("recovery: restart redis", "docker", ["compose", "start", "redis"], { cwd: repoRoot });
  await pollReady((status, body) => status === 200 && body.status === "ok", "readiness recovers");
  console.log("PASS readiness recovers after redis returns");

  console.log("\nSTARTUP CHECK PASSED");
} catch (err) {
  fail(err instanceof Error ? err.stack : String(err));
} finally {
  stoppingServer = true;
  server.kill("SIGTERM");
}
