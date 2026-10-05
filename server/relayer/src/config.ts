import { getAddress, isAddress, isHex, parseEther, parseGwei, type Address, type Hex } from "viem";
import { AUSD_ADDRESS, AUSD_EIP712_NAME, MONAD_MAINNET_CHAIN_ID } from "@everpiece/shared";

/** The only methods this relayer will ever submit (master §26.2 — no arbitrary calldata): escrow + EverpiecePay. */
export const METHODS = ["createPayment", "claimUsernamePayment", "claimLinkPayment", "cancel", "refundExpired", "payWithAusd", "payWithToken"] as const;
export const PAY_METHODS: readonly Method[] = ["payWithAusd", "payWithToken"];
export type Method = (typeof METHODS)[number];

export type RelayerConfig = {
  rpcUrl: string;
  expectedChainId: number;
  escrow: Address;
  /** EverpiecePay (instant payments). Optional: without it the pay methods are refused. */
  pay?: Address;
  ausd: Address;
  /** EIP-712 name of the dollar token's domain: "Agora Dollar" (AUSD) by default, "Everpiece Test Dollar" on testnet. */
  ausdEip712Name?: string;
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
  /** Policy (server/relayer/src/policy.ts). Amounts in AUSD base units. */
  policy: { maxPerPayment: bigint; maxPerSenderPerDay: bigint; reviewAbove: bigint; denylist: ReadonlySet<string> };
  /** Headroom added to a token quote's sell amount (basis points); unused input is returned by the contract. */
  quoteHeadroomBps: bigint;
  quoteTtlSec: number;
  /**
   * A simulation that reverts is retried twice, this far apart, before the request is refused. A load-balanced RPC can
   * answer `latest` from a node a few seconds behind, e.g. before the payer's just-received funds (seen on testnet).
   */
  simulationRetryMs: number;
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
    pay: env.PAY_ADDRESS ? address(env, "PAY_ADDRESS") : undefined,
    ausd: address(env, "AUSD_ADDRESS", AUSD_ADDRESS),
    ausdEip712Name: env.DOLLAR_EIP712_NAME ?? AUSD_EIP712_NAME,
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
      payWithAusd: big(env, "GAS_LIMIT_PAY_AUSD", 200_000n),
      payWithToken: big(env, "GAS_LIMIT_PAY_TOKEN", 420_000n),
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
    policy: {
      maxPerPayment: big(env, "POLICY_MAX_PER_PAYMENT", 500_000_000n), // $500, same as the escrow ceiling
      maxPerSenderPerDay: big(env, "POLICY_MAX_PER_SENDER_PER_DAY", 2_000_000_000n), // $2,000
      reviewAbove: big(env, "POLICY_REVIEW_ABOVE", 0n),
      denylist: new Set((env.POLICY_DENYLIST ?? "").split(",").map((s) => s.trim()).filter(Boolean).map((s) => getAddress(s))),
    },
    quoteHeadroomBps: big(env, "QUOTE_HEADROOM_BPS", 50n), // 0.5%
    quoteTtlSec: int(env, "QUOTE_TTL_SEC", 60),
    simulationRetryMs: int(env, "SIMULATION_RETRY_MS", 1_500),
  };
}
