import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

// The dev server forwards /api to the local backend so the backend needs no
// CORS redesign; production builds read VITE_API_BASE (documented in
// docs/client-contract.md) and are not deployed in this prototype.
export default defineConfig({
  plugins: [react()],
  server: {
    host: "127.0.0.1",
    port: 5174,
    proxy: {
      "/api": {
        target: "http://127.0.0.1:3001",
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
