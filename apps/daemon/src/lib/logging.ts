/** Structured logger. Operational traces only — never model chain-of-thought (spec §24, §29). */
export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };
let minLevel: LogLevel = (process.env.DEVFLOW_LOG_LEVEL as LogLevel | undefined) ?? "info";

export function setLogLevel(level: LogLevel): void {
  minLevel = level;
}

function emit(level: LogLevel, subsystem: string, message: string, data?: Record<string, unknown>): void {
  if (LEVEL_ORDER[level] < LEVEL_ORDER[minLevel]) return;
  const line = {
    ts: new Date().toISOString(),
    level,
    subsystem,
    message,
    ...(data ? { data } : {}),
  };
  const serialized = JSON.stringify(line);
  if (level === "error") console.error(serialized);
  else if (level === "warn") console.warn(serialized);
  else console.log(serialized);
}

export const createLogger = (subsystem: string) => ({
  debug: (message: string, data?: Record<string, unknown>) => emit("debug", subsystem, message, data),
  info: (message: string, data?: Record<string, unknown>) => emit("info", subsystem, message, data),
  warn: (message: string, data?: Record<string, unknown>) => emit("warn", subsystem, message, data),
  error: (message: string, data?: Record<string, unknown>) => emit("error", subsystem, message, data),
});
