import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { buildApp } from "../src/app.ts";
import { loadConfig } from "../src/config.ts";

const config = loadConfig();
const operator = new Client({ connectionString: config.migrationDatabaseUrl });
const app = buildApp(config);
async function request(method: "POST" | "GET", url: string, payload?: object, token?: string) {
  const response = await app.inject({ method, url, payload, headers: token ? { authorization: `Bearer ${token}` } : {} });
  if (response.statusCode >= 400) throw new Error(`${url}: ${response.body}`);
  return response.json();
}
function londonInstant(days: number, time: string): string {
  const day = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/London" }).format(new Date(Date.now() + days * 86400000));
  const offset = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", timeZoneName: "longOffset" })
    .formatToParts(new Date(`${day}T${time}:00Z`)).find(part => part.type === "timeZoneName")!.value;
  return new Date(`${day}T${time}:00${offset === "GMT" ? "Z" : offset.slice(3)}`).toISOString();
}

try {
  await operator.connect();
  const host = await request("POST", "/demo/sessions", { email: "host@velio.test", displayName: "Ada" });
  const booker = await request("POST", "/demo/sessions", { email: "booker@velio.test", displayName: "Tunde" });
  await operator.query("UPDATE users SET dataset='demo', summary=$2 WHERE id=$1", [host.user.id, "Outdoors lover and conversation starter. I bring small groups together for evenings and mornings worth remembering."]);
  await operator.query("UPDATE users SET dataset='demo' WHERE id=$1", [booker.user.id]);
  const fixtures = [
    { title: "Sunset Kayaking", description: "Paddle out at golden hour with a small group, then warm up together on shore.",
      itinerary: "Safety briefing at the launch point. Paddle out together at golden hour. Pause on the water for the sunset. Warm drinks on shore to finish.",
      day: 2, start: "18:30", end: "20:30", priceMinorUnits: 3500, spots: 8 },
    { title: "Secret Speakeasy Tour", description: "An evening of hidden bars and good stories, shared with people worth meeting.",
      itinerary: "Meet your host at the first bar. Visit three hidden bars, one drink at each. Finish somewhere quieter to talk.",
      day: 3, start: "20:00", end: "23:00", priceMinorUnits: 4500, spots: 10 },
    { title: "Morning Coastal Walk", description: "An easy walk along the coast, with coffee and conversation along the way.",
      itinerary: "Meet your host at the trailhead. Walk the coast path at an easy pace. Coffee together at the end.",
      day: -7, start: "08:00", end: "10:00", priceMinorUnits: 1200, spots: 12 },
  ];
  for (const fixture of fixtures) {
    let activity = (await operator.query("SELECT id FROM activities WHERE host_id=$1 AND title=$2 AND dataset='demo'", [host.user.id, fixture.title])).rows[0];
    if (!activity) {
      const ahead = Math.max(fixture.day, 2);
      const publication = await request("POST", "/activities", {
        title: fixture.title, description: fixture.description, itinerary: fixture.itinerary,
        startsAt: londonInstant(ahead, fixture.start), endsAt: londonInstant(ahead, fixture.end),
        timezone: "Europe/London", country: "GB", priceMinorUnits: fixture.priceMinorUnits, currency: "GBP", spots: fixture.spots,
      }, host.session.token);
      activity = publication.activity;
      await operator.query("UPDATE activities SET dataset='demo' WHERE id=$1", [activity.id]);
      await request("POST", `/activities/${activity.id}/bookings`, { operationId: randomUUID() }, booker.session.token);
      if (fixture.day !== ahead) {
        await operator.query("UPDATE activities SET starts_at=$2, ends_at=$3 WHERE id=$1",
          [activity.id, londonInstant(fixture.day, fixture.start), londonInstant(fixture.day, fixture.end)]);
      }
    }
  }
  console.log("Synthetic demo ready: Host has multiple activities; Booker has saved bookings. Run again to reuse these fixtures.");
} finally { await app.close(); await operator.end(); }
