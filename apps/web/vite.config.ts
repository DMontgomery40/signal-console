import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  envPrefix: ["VITE_", "SIGNAL_CONSOLE_"],
  plugins: [react()],
  server: {
    host: "localhost",
    port: 5173,
    strictPort: false,
    proxy: {
      "/v1": {
        target: "http://localhost:4100",
        changeOrigin: true,
      },
    },
  },
  preview: {
    host: "localhost",
    port: 5173,
  },
});
