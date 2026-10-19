import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";

const config = loadConfig();
const app = buildApp(config);

// Bind all interfaces so the Flutter emulator can reach the API over LAN
// (PLANS.md section 5.2 documents the emulator/LAN URL requirement).
await app.listen({ port: config.port, host: "0.0.0.0" });
