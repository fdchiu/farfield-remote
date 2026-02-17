import pino from "pino";

const level = process.env["LOG_LEVEL"] ?? "info";

export const logger = pino({
  name: "codex-monitor-server",
  level
});

