export type LogLevel = "debug" | "info" | "warn" | "error";

export type LogFields = Record<string, string | number | boolean | null>;

export interface Logger {
  debug: (msg: string, fields?: LogFields) => void;
  info: (msg: string, fields?: LogFields) => void;
  warn: (msg: string, fields?: LogFields) => void;
  error: (msg: string, fields?: LogFields) => void;
}

const levelWeight: Record<LogLevel, number> = {
  debug: 10,
  error: 40,
  info: 20,
  warn: 30,
};

// Structured JSON-lines logger. Redaction is by construction: callers only
// pass non-private metadata (ids, counts, durations, lengths) — never query
// text or chunk content. KNOWLEDGE_LOG_QUERIES opts the search handler into
// logging the raw query explicitly.
export const createJsonLogger = (
  stream: NodeJS.WritableStream = process.stdout,
  minLevel: LogLevel = "info"
): Logger => {
  const emit = (level: LogLevel, msg: string, fields?: LogFields): void => {
    if (levelWeight[level] < levelWeight[minLevel]) {
      return;
    }
    const entry = {
      level,
      msg,
      time: new Date().toISOString(),
      ...fields,
    };
    stream.write(`${JSON.stringify(entry)}\n`);
  };
  return {
    debug: (msg, fields) => emit("debug", msg, fields),
    error: (msg, fields) => emit("error", msg, fields),
    info: (msg, fields) => emit("info", msg, fields),
    warn: (msg, fields) => emit("warn", msg, fields),
  };
};
