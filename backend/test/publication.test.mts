import "../src/config.ts";
import { afterAll, beforeAll, expect, it } from "vitest";
import { buildApp } from "../src/app.ts";
import { loadConfig } from "../src/config.ts";
import { resetAndMigrate, urlFor, withClient } from "./support/db.mts";

const migrationUrl = urlFor("MIGRATION_DATABASE_URL", "velio_test");
const app = buildApp({ ...loadConfig(process.env), databaseUrl: urlFor("DATABASE_URL", "velio_test"), logLevel: "silent" });
beforeAll(() => resetAndMigrate(migrationUrl));
afterAll(() => app.close());

it("when a host publishes complete information, signed-out visitors can inspect its single itinerary and all initial spots", async () => {
  const signed = await app.inject({ method: "POST", url: "/demo/sessions", payload: { email: "  Ada+Kayak@Example.test " } });
  expect(signed.statusCode).toBe(200);
  const { user, session } = signed.json();
  expect(user).toMatchObject({ email: "ada+kayak@example.test", signupSource: "direct", signupGeneration: 0 });
  const returned = await app.inject({ method: "POST", url: "/demo/sessions", payload: { email: "ada+kayak@example.test" } });
  expect(returned.json()).toMatchObject({ user: { id: user.id }, created: false });
  const published = await app.inject({ method: "POST", url: "/activities", headers: { authorization: `Bearer ${session.token}` }, payload: {
    title: "Lagoon at sunset", description: "A calm paddle with a local guide.", itinerary: "Meet at the jetty. Paddle the lagoon. Return for tea.",
    startsAt: "2030-11-20T16:00:00Z", timezone: "Africa/Lagos", priceMinorUnits: 1250000, currency: "NGN", spots: 6,
  } });
  expect(published.statusCode).toBe(201);
  const saved = published.json();
  const detail = await app.inject({ method: "GET", url: `/activities/${saved.activity.id}` });
  expect(detail.json()).toMatchObject({ activity: { description: "A calm paddle with a local guide.", remainingSpots: 6, bookedCount: 0, bookingState: "available" }, plan: { id: saved.plan.id, activityId: saved.activity.id, itinerary: "Meet at the jetty. Paddle the lagoon. Return for tea." }, host: { id: user.id, previousActivities: [] }, invites: { experimentVersion: expect.any(String) } });
  const rows = await withClient(migrationUrl, c => c.query("SELECT count(*)::int AS n FROM plans WHERE activity_id=$1", [saved.activity.id]));
  expect(rows.rows[0].n).toBe(1);
});
