import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

import { defaultApiPort, defaultWebPort } from "../../packages/shared/src/ports";

function resolvePort(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 65535) {
    throw new Error(`invalid ${name}: ${raw}`);
  }
  return parsed;
}

const webPort = resolvePort("SIGNAL_CONSOLE_WEB_PORT", defaultWebPort);
const apiTarget =
  process.env["SIGNAL_CONSOLE_API_TARGET"] ?? `http://localhost:${String(defaultApiPort)}`;

export default defineConfig({
  envPrefix: ["VITE_", "SIGNAL_CONSOLE_"],
  plugins: [react()],
  server: {
    host: "localhost",
    port: webPort,
    strictPort: false,
    proxy: {
      "/v1": {
        target: apiTarget,
        changeOrigin: true,
      },
    },
  },
  preview: {
    host: "localhost",
    port: webPort,
  },
});
