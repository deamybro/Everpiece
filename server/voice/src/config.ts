/** The message store holds NO keys: it can't decrypt a message, sign anything or move money. */
export type VoiceConfig = {
  port: number;
  host: string;
  dbPath: string;
  allowedOrigin?: string;
  /** Requests (reads + uploads) per IP per minute. */
  perIpPerMinute: number;
  /** New messages per IP per day (abuse brake; not a security boundary). */
  uploadsPerIpPerDay: number;
  /** Stop accepting uploads above this many stored bytes (protects the shared host's disk). */
  maxTotalBytes: number;
  /** Messages are deleted this long after upload. Payments expire within 30 days (ESCROW_SPEC), plus time to listen. */
  retentionDays: number;
};

const int = (env: NodeJS.ProcessEnv, n: string, d: number) => {
  const v = env[n];
  if (v === undefined || v === "") return d;
  const x = Number(v);
  if (!Number.isSafeInteger(x) || x < 0) throw new Error(`config: ${n} must be a non-negative integer`);
  return x;
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): VoiceConfig {
  const allowedOrigin = env.ALLOWED_ORIGIN;
  if (allowedOrigin && new URL(allowedOrigin).origin !== allowedOrigin) throw new Error("config: ALLOWED_ORIGIN must be a bare origin");
  return {
    port: int(env, "PORT", 8791),
    host: env.HOST ?? "127.0.0.1",
    dbPath: env.VOICE_DB_PATH ?? "voice.sqlite",
    allowedOrigin,
    perIpPerMinute: int(env, "PER_IP_PER_MINUTE", 60),
    uploadsPerIpPerDay: int(env, "UPLOADS_PER_IP_PER_DAY", 30),
    maxTotalBytes: int(env, "MAX_TOTAL_BYTES", 500 * 1024 * 1024),
    retentionDays: int(env, "RETENTION_DAYS", 45),
  };
}
