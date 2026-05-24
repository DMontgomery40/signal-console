import { defaultE2eApiPort, defaultWebPort } from "../../packages/shared/src/ports";

export default {
  webServer: [
    {
      name: "web",
      command: `vite --host 127.0.0.1 --port ${String(defaultWebPort)}`,
      url: `http://127.0.0.1:${String(defaultWebPort)}`,
      env: {
        SIGNAL_CONSOLE_API_TARGET: `http://127.0.0.1:${String(defaultE2eApiPort)}`,
      },
      reuseExistingServer: process.env.CI !== "true",
    },
  ],
  use: {
    baseURL: `http://127.0.0.1:${String(defaultWebPort)}`,
  },
};
