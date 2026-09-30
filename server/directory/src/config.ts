import { getAddress, isAddress, type Address } from "viem";
import { MONAD_MAINNET_CHAIN_ID } from "@everpiece/shared";

/** The directory holds NO keys: nothing here can move money or sign approvals. */
export type DirectoryConfig = {
  rpcUrl: string;
  expectedChainId: number;
  escrow: Address;
  port: number;
  host: string;
  dbPath: string;
  /** Max clock skew allowed on client-supplied request deadlines. */
  requestDeadlineMaxSec: number;
  perIpPerMinute: number;
  /** New usernames per IP per day (squatting brake; not a security boundary). */
  registrationsPerIpPerDay: number;
  /** Max inbox entries returned per read. */
  inboxPageSize: number;
  allowedOrigin?: string;
  maxBodyBytes: number;
};

const req = (env: NodeJS.ProcessEnv, n: string) => {
  const v = env[n];
  if (!v) throw new Error(`config: ${n} is required`);
  return v;
};
const int = (env: NodeJS.ProcessEnv, n: string, d: number) => {
  const v = env[n];
  if (v === undefined) return d;
  const x = Number(v);
  if (!Number.isSafeInteger(x) || x < 0) throw new Error(`config: ${n} must be a non-negative integer`);
  return x;
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): DirectoryConfig {
  const escrow = req(env, "ESCROW_ADDRESS");
  if (!isAddress(escrow, { strict: false })) throw new Error("config: ESCROW_ADDRESS must be an address");
  const allowedOrigin = env.ALLOWED_ORIGIN;
  if (allowedOrigin && new URL(allowedOrigin).origin !== allowedOrigin) throw new Error("config: ALLOWED_ORIGIN must be a bare origin");
  return {
    rpcUrl: req(env, "MONAD_RPC"),
    expectedChainId: int(env, "EXPECTED_CHAIN_ID", MONAD_MAINNET_CHAIN_ID),
    escrow: getAddress(escrow),
    port: int(env, "PORT", 8789),
    host: env.HOST ?? "127.0.0.1",
    dbPath: env.DIRECTORY_DB_PATH ?? "directory.sqlite",
    requestDeadlineMaxSec: int(env, "REQUEST_DEADLINE_MAX_SEC", 600),
    perIpPerMinute: int(env, "PER_IP_PER_MINUTE", 60),
    registrationsPerIpPerDay: int(env, "REGISTRATIONS_PER_IP_PER_DAY", 5),
    inboxPageSize: int(env, "INBOX_PAGE_SIZE", 100),
    allowedOrigin,
    maxBodyBytes: int(env, "MAX_BODY_BYTES", 4096),
  };
}
