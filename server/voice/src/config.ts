import { getAddress, isAddress, type Address } from "viem";
import { MONAD_MAINNET_CHAIN_ID } from "@everpiece/shared";

/** The message store holds NO keys: it can't decrypt a message, sign anything or move money. It only reads the chain. */
export type VoiceConfig = {
  /** Read-only chain access, to check that a message really belongs to a payment before keeping it. */
  rpcUrl: string;
  expectedChainId: number;
  escrow: Address;
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
  /** A message no payment has claimed (bound) is deleted this long after upload. */
  unboundHours: number;
  /** A bound message is deleted this long after its payment's expiry (payments expire within 30 days). */
  keepAfterExpiryDays: number;
};

const req = (env: NodeJS.ProcessEnv, n: string) => {
  const v = env[n];
  if (!v) throw new Error(`config: ${n} is required`);
  return v;
};
const int = (env: NodeJS.ProcessEnv, n: string, d: number) => {
  const v = env[n];
  if (v === undefined || v === "") return d;
  const x = Number(v);
  if (!Number.isSafeInteger(x) || x < 0) throw new Error(`config: ${n} must be a non-negative integer`);
  return x;
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): VoiceConfig {
  const escrow = req(env, "ESCROW_ADDRESS");
  if (!isAddress(escrow, { strict: false })) throw new Error("config: ESCROW_ADDRESS must be an address");
  const allowedOrigin = env.ALLOWED_ORIGIN;
  if (allowedOrigin && new URL(allowedOrigin).origin !== allowedOrigin) throw new Error("config: ALLOWED_ORIGIN must be a bare origin");
  return {
    rpcUrl: req(env, "MONAD_RPC"),
    expectedChainId: int(env, "EXPECTED_CHAIN_ID", MONAD_MAINNET_CHAIN_ID),
    escrow: getAddress(escrow),
    port: int(env, "PORT", 8791),
    host: env.HOST ?? "127.0.0.1",
    dbPath: env.VOICE_DB_PATH ?? "voice.sqlite",
    allowedOrigin,
    perIpPerMinute: int(env, "PER_IP_PER_MINUTE", 60),
    uploadsPerIpPerDay: int(env, "UPLOADS_PER_IP_PER_DAY", 30),
    maxTotalBytes: int(env, "MAX_TOTAL_BYTES", 500 * 1024 * 1024),
    unboundHours: int(env, "UNBOUND_HOURS", 24),
    keepAfterExpiryDays: int(env, "KEEP_AFTER_EXPIRY_DAYS", 15),
  };
}
