import "../src/config.ts";
import { afterAll, beforeAll, expect, it } from "vitest";
import { buildApp } from "../src/app.ts";
import { loadConfig } from "../src/config.ts";
import { resetAndMigrate, urlFor, withClient } from "./support/db.mts";

const migrationUrl = urlFor("MIGRATION_DATABASE_URL", "velio_test");
// Quota override disclosure: the suite's booking workloads share one loopback
// IP fixed window, so this app runs with booking quotas far above the
// documented defaults — saved and sold-out outcomes must never be disguised as
// 429s. The dedicated quota boundary lives in booking-routes.test.mts with a
// tiny limit instead.
const app = buildApp({
  ...loadConfig(process.env),
  databaseUrl: urlFor("DATABASE_URL", "velio_test"),
  bookingRateLimitPerIdentity: 500,
  bookingRateLimitPerIp: 10000,
  logLevel: "silent",
});
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

it("when a returning booker lists saved bookings, only that account's activity and plan references are returned", async () => {
  const account = async (email: string) => (await app.inject({ method: "POST", url: "/demo/sessions", payload: { email } })).json();
  const host = await account("host-list@example.test");
  const booker = await account("booker-list@example.test");
  const outsider = await account("other-list@example.test");
  const published = (await app.inject({ method: "POST", url: "/activities", headers: { authorization: `Bearer ${host.session.token}` }, payload: {
    title: "Saved outing", description: "A relaxed walk.", itinerary: "Meet and walk.", startsAt: "2030-11-20T16:00:00Z", timezone: "Africa/Lagos", priceMinorUnits: 1000, currency: "NGN", spots: 5,
  } })).json();
  const booked = await app.inject({ method: "POST", url: `/activities/${published.activity.id}/bookings`, headers: { authorization: `Bearer ${booker.session.token}` }, payload: { operationId: "saved-list-booking" } });
  expect(booked.statusCode).toBe(201);
  const list = await app.inject({ method: "GET", url: "/my/bookings", headers: { authorization: `Bearer ${booker.session.token}` } });
  expect(list.json().bookings).toEqual([expect.objectContaining({ id: booked.json().booking.id, activityId: published.activity.id, planId: published.plan.id, activity: expect.objectContaining({ title: "Saved outing" }) })]);
  const other = await app.inject({ method: "GET", url: "/my/bookings", headers: { authorization: `Bearer ${outsider.session.token}` } });
  expect(other.json().bookings).toEqual([]);
  expect((await app.inject({ method: "GET", url: "/my/bookings" })).statusCode).toBe(401);
});
