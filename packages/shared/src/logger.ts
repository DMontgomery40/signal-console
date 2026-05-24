import pino from "pino";

function shouldPrettyPrint() {
  if (process.env.LOG_PRETTY === "0") {
    return false;
  }

  if (process.env.LOG_PRETTY === "1") {
    return true;
  }

  return process.env.NODE_ENV !== "production" && process.env.CI !== "true";
}

const rootLogger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  base: {
    app: "signal-console",
    env: process.env.NODE_ENV ?? "development",
  },
  timestamp: pino.stdTimeFunctions.isoTime,
  transport: shouldPrettyPrint()
    ? {
        target: "pino-pretty",
        options: {
          ignore: "pid,hostname",
          translateTime: "HH:MM:ss",
        },
      }
    : undefined,
});

export type AppLogger = typeof rootLogger;

export function createAppLogger(bindings?: Record<string, unknown>) {
  return bindings ? rootLogger.child(bindings) : rootLogger;
}
