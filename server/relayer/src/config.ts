import { getAddress, isAddress, isHex, parseEther, parseGwei, type Address, type Hex } from "viem";
import { AUSD_ADDRESS, MONAD_MAINNET_CHAIN_ID } from "@everpiece/shared";

/** The only escrow methods this relayer will ever submit (master §26.2 — no arbitrary calldata). */
export const METHODS = ["createPayment", "claimUsernamePayment", "claimLinkPayment", "cancel", "refundExpired"] as const;
export type Method = (typeof METHODS)[number];

export type RelayerConfig = {
  rpcUrl: string;
  expectedChainId: number;
  escrow: Address;
  ausd: Address;
  relayerPrivateKey: Hex;
  port: number;
  host: string;
  dbPath: string;
  /** Explicit per-method gas limits. Monad charges the FULL limit (VERIFIED §1.5) — keep them tight (ESCROW_SPEC §22). */
  gasLimits: Record<Method, bigint>;
  maxFeePerGasWei: bigint;
  priorityFeeWei: bigint;
  /** Refuse new submissions below this MON balance (reserve-balance rules, VERIFIED §1.9). */
  minRelayerBalanceWei: bigint;
  /** Sum of submitted gas LIMITS per UTC day. */
  dailyGasBudget: bigint;
  perIpPerMinute: number;
  perSignerPerMinute: number;
  perSignerPerDay: number;
  /** Application-level minimum payment (master §26.3); the contract only requires > 0. */
  minPaymentAmount: bigint;
  maxBodyBytes: number;
  pollIntervalMs: number;
  rebroadcastAfterMs: number;
  stuckAfterMs: number;
  allowedOrigin?: string;
};

function req(env: NodeJS.ProcessEnv, name: string): string {
  const v = env[name];
  if (!v) throw new Error(`config: ${name} is required`);
  return v;
}

function address(env: NodeJS.ProcessEnv, name: string, fallback?: Address): Address {
  const v = env[name] ?? fallback;
  if (!v || !isAddress(v, { strict: false })) throw new Error(`config: ${name} must be an address`);
  return getAddress(v);
}

function int(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const v = env[name];
  if (v === undefined) return fallback;
  const n = Number(v);
  if (!Number.isSafeInteger(n) || n < 0) throw new Error(`config: ${name} must be a non-negative integer`);
  return n;
}

function big(env: NodeJS.ProcessEnv, name: string, fallback: bigint): bigint {
  const v = env[name];
  if (v === undefined) return fallback;
  if (!/^[0-9]+$/.test(v)) throw new Error(`config: ${name} must be a decimal integer`);
  return BigInt(v);
}

/** Defaults are mainnet-conservative; every value can be overridden by env. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): RelayerConfig {
  const key = req(env, "RELAYER_PRIVATE_KEY");
  if (!isHex(key) || key.length !== 66) throw new Error("config: RELAYER_PRIVATE_KEY must be a 32-byte hex key");
  return {
    rpcUrl: req(env, "MONAD_RPC"),
    expectedChainId: int(env, "EXPECTED_CHAIN_ID", MONAD_MAINNET_CHAIN_ID),
    escrow: address(env, "ESCROW_ADDRESS"),
    ausd: address(env, "AUSD_ADDRESS", AUSD_ADDRESS),
    relayerPrivateKey: key,
    port: int(env, "PORT", 8787),
    host: env.HOST ?? "127.0.0.1",
    dbPath: env.RELAYER_DB_PATH ?? "relayer.sqlite",
    gasLimits: {
      createPayment: big(env, "GAS_LIMIT_CREATE", 350_000n),
      claimUsernamePayment: big(env, "GAS_LIMIT_CLAIM_USERNAME", 215_000n),
      claimLinkPayment: big(env, "GAS_LIMIT_CLAIM_LINK", 240_000n),
      cancel: big(env, "GAS_LIMIT_CANCEL", 195_000n),
      refundExpired: big(env, "GAS_LIMIT_REFUND", 145_000n),
    },
    maxFeePerGasWei: big(env, "MAX_FEE_PER_GAS_WEI", parseGwei("500")),
    priorityFeeWei: big(env, "PRIORITY_FEE_WEI", parseGwei("2")), // Monad RPC suggests 2 gwei (VERIFIED §1.14)
    minRelayerBalanceWei: big(env, "MIN_RELAYER_BALANCE_WEI", parseEther("11")),
    dailyGasBudget: big(env, "DAILY_GAS_BUDGET", 100_000_000n),
    perIpPerMinute: int(env, "RATE_PER_IP_PER_MINUTE", 30),
    perSignerPerMinute: int(env, "RATE_PER_SIGNER_PER_MINUTE", 6),
    perSignerPerDay: int(env, "RATE_PER_SIGNER_PER_DAY", 60),
    minPaymentAmount: big(env, "MIN_PAYMENT_AMOUNT", 1_000_000n), // $1
    maxBodyBytes: int(env, "MAX_BODY_BYTES", 8_192),
    pollIntervalMs: int(env, "POLL_INTERVAL_MS", 500),
    rebroadcastAfterMs: int(env, "REBROADCAST_AFTER_MS", 15_000),
    stuckAfterMs: int(env, "STUCK_AFTER_MS", 120_000),
    allowedOrigin: env.ALLOWED_ORIGIN,
  };
}
