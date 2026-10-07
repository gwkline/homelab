// One JSON object per stdout line; Alloy ships pod logs to Loki, where
// `| json` turns these fields into filters.
export const log = (
  level: "info" | "warn" | "error",
  msg: string,
  fields: Record<string, unknown> = {}
): void => {
  console.log(
    JSON.stringify({ level, msg, time: new Date().toISOString(), ...fields })
  );
};
