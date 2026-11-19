/**
 * JSON-lines logger, same shape as the knowledge services: callers pass only
 * metadata (counts, dims, states), never request text — chunk text is
 * personal data and logs must stay safe to read.
 */

export type LogLevel = "info" | "warn" | "error";

export type LogFields = Record<string, string | number | boolean | null>;

export interface Logger {
  error: (msg: string, fields?: LogFields) => void;
  info: (msg: string, fields?: LogFields) => void;
  warn: (msg: string, fields?: LogFields) => void;
}

export const createJsonLogger = (
  stream: NodeJS.WritableStream = process.stdout
): Logger => {
  const emit = (level: LogLevel, msg: string, fields?: LogFields): void => {
    const entry = { level, msg, time: new Date().toISOString(), ...fields };
    stream.write(`${JSON.stringify(entry)}\n`);
  };
  return {
    error: (msg, fields) => emit("error", msg, fields),
    info: (msg, fields) => emit("info", msg, fields),
    warn: (msg, fields) => emit("warn", msg, fields),
  };
};
