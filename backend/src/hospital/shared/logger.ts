type Level = "debug" | "info" | "warn" | "error" | "silent";
const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40, silent: 99 };

export interface Logger {
  debug(message: string, fields?: Record<string, unknown>): void;
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
}

/**
 * Minimal structured logger for the hospital modules: one line per event, `time level message {json fields}`.
 * Never pass request bodies, Aadhaar numbers, OTPs, tokens or patient details in `fields`.
 */
export function createLogger(level: Level): Logger {
  const write = (at: Exclude<Level, "silent">, message: string, fields?: Record<string, unknown>) => {
    if (ORDER[at] < ORDER[level]) return;
    const line = `${new Date().toISOString()} ${at.toUpperCase().padEnd(5)} ${message}${fields ? " " + JSON.stringify(fields) : ""}`;
    (at === "error" ? console.error : at === "warn" ? console.warn : console.log)(line);
  };
  return {
    debug: (m, f) => write("debug", m, f),
    info: (m, f) => write("info", m, f),
    warn: (m, f) => write("warn", m, f),
    error: (m, f) => write("error", m, f),
  };
}
