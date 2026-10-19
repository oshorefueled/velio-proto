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
try {
  await operator.connect();
  const host = await request("POST", "/demo/sessions", { email: "host@demo.velio.test", displayName: "Ada · Demo host" });
  const booker = await request("POST", "/demo/sessions", { email: "booker@demo.velio.test", displayName: "Tunde · Demo booker" });
  await operator.query("UPDATE users SET dataset='demo', summary=$2 WHERE id=$1", [host.user.id, "Lagos local, paddler and weekend explorer. I bring people together for small adventures by the water."]);
  await operator.query("UPDATE users SET dataset='demo' WHERE id=$1", [booker.user.id]);
  for (const [index, title] of ["Lagoon sunset paddle · Demo", "Lagos food walk · Demo", "Coastal morning · Demo"].entries()) {
    let activity = (await operator.query("SELECT id FROM activities WHERE host_id=$1 AND title=$2 AND dataset='demo'", [host.user.id, title])).rows[0];
    if (!activity) {
      const publication = await request("POST", "/activities", {
        title, description: index === 1 ? "Taste the neighbourhood with a local guide." : "A relaxed outing by the water, with time to meet the group.",
        itinerary: "Meet your host. Get to know the group. Explore together. Finish with refreshments.",
        startsAt: new Date(Date.now() + (index + 2) * 86400000).toISOString(), timezone: "Africa/Lagos", priceMinorUnits: 1250000, currency: "NGN", spots: 8,
      }, host.session.token);
      activity = publication.activity;
      await operator.query("UPDATE activities SET dataset='demo' WHERE id=$1", [activity.id]);
      await request("POST", `/activities/${activity.id}/bookings`, { operationId: randomUUID() }, booker.session.token);
      if (index === 2) await operator.query("UPDATE activities SET starts_at=clock_timestamp()-interval '7 days' WHERE id=$1", [activity.id]);
    }
  }
  console.log("Synthetic demo ready: Host has multiple activities; Booker has saved bookings. Run again to reuse these fixtures.");
} finally { await app.close(); await operator.end(); }
