import { getAddress, isAddress, isHex, parseEther, parseGwei, type Address, type Hex } from "viem";
import { AURORA_API_URL, AUSD_ADDRESS, AUSD_EIP712_NAME, MONAD_MAINNET_CHAIN_ID, USDC_MAINNET_ADDRESS, tokenFor } from "@everpiece/shared";
import type { FundingConfig } from "./funding.ts";

/** The only methods this relayer will ever submit (master §26.2 — no arbitrary calldata): escrow + EverpiecePay. */
export const METHODS = ["createPayment", "claimUsernamePayment", "claimLinkPayment", "cancel", "refundExpired", "payWithAusd", "payWithToken", "earnDeposit", "earnWithdraw"] as const;
export const PAY_METHODS: readonly Method[] = ["payWithAusd", "payWithToken"];
/** EverpieceEarn (docs/EARN.md): gasless deposits/withdrawals into verified AUSD vaults; settle-once like EverpiecePay. */
export const EARN_METHODS: readonly Method[] = ["earnDeposit", "earnWithdraw"];
export type Method = (typeof METHODS)[number];

export type RelayerConfig = {
  rpcUrl: string;
  expectedChainId: number;
  escrow: Address;
  /** EverpiecePay (instant payments). Optional: without it the pay methods are refused. */
  pay?: Address;
  /** EverpieceEarn (gasless Earn deposits/withdrawals). Optional: without it the earn methods are refused. */
  earn?: Address;
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
  /** "Add Dollars from another chain" (Aurora Intents). Off unless AURORA_API_KEY is set. */
  funding?: FundingConfig;
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
    earn: env.EARN_ADDRESS ? address(env, "EARN_ADDRESS") : undefined,
    ausd: address(env, "AUSD_ADDRESS", AUSD_ADDRESS),
    ausdEip712Name: env.DOLLAR_EIP712_NAME ?? AUSD_EIP712_NAME,
    relayerPrivateKey: key,
    port: int(env, "PORT", 8787),
    host: env.HOST ?? "127.0.0.1",
    dbPath: env.RELAYER_DB_PATH ?? "relayer.sqlite",
    // Worst cases measured on real AUSD with cold state by contracts/test/fork/RelayerGas.t.sol (mainnet and testnet),
    // plus 5–10%. Monad charges the full limit (VERIFIED §1.5); too low fails the payment (testnet: payWithAusd at 200k).
    // test/gasLimits.test.ts keeps these equal to that test's constants.
    gasLimits: {
      createPayment: big(env, "GAS_LIMIT_CREATE", 350_000n), // measured ≤ 318,483
      claimUsernamePayment: big(env, "GAS_LIMIT_CLAIM_USERNAME", 230_000n), // ≤ 208,121
      claimLinkPayment: big(env, "GAS_LIMIT_CLAIM_LINK", 270_000n), // ≤ 250,278
      cancel: big(env, "GAS_LIMIT_CANCEL", 205_000n), // ≤ 189,469
      refundExpired: big(env, "GAS_LIMIT_REFUND", 155_000n), // ≤ 138,273
      payWithAusd: big(env, "GAS_LIMIT_PAY_AUSD", 280_000n), // ≤ 255,331 (live testnet: 223,216)
      payWithToken: big(env, "GAS_LIMIT_PAY_TOKEN", 550_000n), // ≤ 520,398 USDC on mainnet; 449,716 CTK on testnet (live: 400,622)
      // EverpieceEarnFork.t.sol, real Aave waMonAUSD, cold state: deposit 660,269, withdraw 595,649
      earnDeposit: big(env, "GAS_LIMIT_EARN_DEPOSIT", 800_000n),
      earnWithdraw: big(env, "GAS_LIMIT_EARN_WITHDRAW", 750_000n),
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
    funding: fundingConfig(env),
  };
}

/** Aurora funding: needs AURORA_API_KEY; delivers USDC on mainnet, or AURORA_DESTINATION_TOKEN (test stacks). */
function fundingConfig(env: NodeJS.ProcessEnv): FundingConfig | undefined {
  if (!env.AURORA_API_KEY) return undefined;
  if (!/^[A-Za-z0-9._-]{8,200}$/.test(env.AURORA_API_KEY)) throw new Error("config: AURORA_API_KEY has unexpected characters");
  const chainId = int(env, "EXPECTED_CHAIN_ID", MONAD_MAINNET_CHAIN_ID);
  const destination = env.AURORA_DESTINATION_TOKEN
    ? address(env, "AURORA_DESTINATION_TOKEN")
    : chainId === MONAD_MAINNET_CHAIN_ID ? USDC_MAINNET_ADDRESS : undefined;
  if (!destination) throw new Error("config: AURORA_DESTINATION_TOKEN is required off mainnet");
  // Aurora is a FUNDING provider, never AUSD settlement (docs/ROUTING.md §3.2): it delivers a verified intermediate
  // asset that Agora then settles into exact AUSD. AUSD itself, or a token without an Agora route, is refused.
  const ausd = env.AUSD_ADDRESS ? address(env, "AUSD_ADDRESS") : AUSD_ADDRESS;
  if (destination.toLowerCase() === ausd.toLowerCase()) throw new Error("config: Aurora must not deliver AUSD directly (docs/ROUTING.md §3.2)");
  const t = tokenFor(chainId, destination);
  if (!t || t.route !== "AGORA_INSTANT_SETTLEMENT") throw new Error("config: AURORA_DESTINATION_TOKEN needs a verified Agora route to AUSD (docs/ROUTING.md §3.1)");
  return {
    apiUrl: (env.AURORA_API_URL || AURORA_API_URL).replace(/\/$/, ""),
    apiKey: env.AURORA_API_KEY,
    destinationToken: destination,
    slippageBps: int(env, "FUNDING_SLIPPAGE_BPS", 50), // stable → stable; excess input is refunded by Aurora
    deadlineMinutes: int(env, "FUNDING_DEADLINE_MINUTES", 30),
    maxWholeTokens: int(env, "FUNDING_MAX_WHOLE_TOKENS", 600), // the $500 payment ceiling + room for fees
    perIpPerMinute: int(env, "FUNDING_PER_IP_PER_MINUTE", 60),
  };
}
