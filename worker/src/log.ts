/**
 * Structured JSON logging to stdout. journald on the VPS captures stdout,
 * so one JSON object per line is the whole logging strategy (06 §6).
 */

type Level = "debug" | "info" | "warn" | "error";

const LEVELS: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

const minLevel: number =
  LEVELS[(process.env.LOG_LEVEL as Level | undefined) ?? "info"] ?? LEVELS.info;

export interface LogFields {
  [key: string]: unknown;
}

export interface Logger {
  debug(msg: string, fields?: LogFields): void;
  info(msg: string, fields?: LogFields): void;
  warn(msg: string, fields?: LogFields): void;
  error(msg: string, fields?: LogFields): void;
  /** Returns a logger that stamps `base` fields onto every record. */
  child(base: LogFields): Logger;
}

function emit(level: Level, msg: string, fields?: LogFields): void {
  if (LEVELS[level] < minLevel) return;
  const record: Record<string, unknown> = {
    ts: new Date().toISOString(),
    level,
    msg,
    ...fields,
  };
  process.stdout.write(`${JSON.stringify(record, jsonSafe)}\n`);
}

// Errors serialize to {} by default; flatten them so stack traces reach journald.
function jsonSafe(_key: string, value: unknown): unknown {
  if (value instanceof Error) {
    return { name: value.name, message: value.message, stack: value.stack };
  }
  return value;
}

function makeLogger(base: LogFields): Logger {
  return {
    debug: (msg, fields) => emit("debug", msg, { ...base, ...fields }),
    info: (msg, fields) => emit("info", msg, { ...base, ...fields }),
    warn: (msg, fields) => emit("warn", msg, { ...base, ...fields }),
    error: (msg, fields) => emit("error", msg, { ...base, ...fields }),
    child: (childBase) => makeLogger({ ...base, ...childBase }),
  };
}

export const log: Logger = makeLogger({});
