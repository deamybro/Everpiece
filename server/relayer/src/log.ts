/**
 * Structured JSON logs. Callers pass only non-secret fields; this module never receives keys, and it drops any
 * field whose name looks secret as a second line of defense (master §0.6).
 */
const SECRET = /key|secret|mnemonic|prf|otp|password|cookie/i;

type Level = "debug" | "info" | "warn" | "error" | "alert";

let sink: (line: string) => void = (line) => process.stdout.write(line + "\n");
let minLevel: Level = (process.env.LOG_LEVEL as Level) ?? "info";
const order: Record<Level, number> = { debug: 0, info: 1, warn: 2, error: 3, alert: 4 };

export function setLogSink(fn: (line: string) => void, level: Level = "info"): void {
  sink = fn;
  minLevel = level;
}

export function log(level: Level, msg: string, fields: Record<string, unknown> = {}): void {
  if (order[level] < order[minLevel]) return;
  const safe: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(fields)) {
    safe[k] = SECRET.test(k) ? "[redacted]" : typeof v === "bigint" ? v.toString() : v;
  }
  sink(JSON.stringify({ ts: new Date().toISOString(), level, msg, ...safe }));
}
