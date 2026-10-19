import { readFileSync } from "node:fs";
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

// The dev server forwards /api to the local backend so the backend needs no
// CORS redesign; production builds read VITE_API_BASE (documented in
// docs/client-contract.md) and are not deployed in this prototype.
const cert = process.env.VELIO_HTTPS_CERT;
const key = process.env.VELIO_HTTPS_KEY;
if (Boolean(cert) !== Boolean(key)) throw new Error("Set both VELIO_HTTPS_CERT and VELIO_HTTPS_KEY");

export default defineConfig({
  plugins: [react()],
  server: {
    host: process.env.VELIO_WEB_HOST ?? "127.0.0.1",
    port: Number(process.env.VELIO_WEB_PORT ?? 5174),
    https: cert && key ? { cert: readFileSync(cert), key: readFileSync(key) } : undefined,
    proxy: {
      "/api": {
        target: process.env.VELIO_API_PROXY ?? "http://127.0.0.1:3001",
        changeOrigin: false,
        rewrite: (path) => path.replace(/^\/api/, ""),
        // GET /live is a websocket; upgrades must forward like the HTTP API.
        ws: true,
      },
    },
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
