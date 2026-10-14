import { getAddress, isAddress, isHex, parseEther, parseGwei, type Address, type Hex } from "viem";
import { readFlags, settlementAsset, type FeatureFlags } from "@everpiece/shared";
import { AURORA_API_URL, AUSD_ADDRESS, AUSD_EIP712_NAME, MONAD_MAINNET_CHAIN_ID, USDC_MAINNET_ADDRESS, tokenFor } from "@everpiece/shared";
import type { FundingConfig } from "./funding.ts";

/** The only methods this relayer will ever submit (master §26.2 — no arbitrary calldata): escrow + EverpiecePay. */
export const METHODS = ["createPayment", "claimUsernamePayment", "claimLinkPayment", "cancel", "refundExpired", "payWithAusd", "payWithToken", "earnDeposit", "earnWithdraw", "payV2Direct", "payV2Convert", "earnUsdcDeposit", "earnUsdcWithdraw", "automateActivate", "automateRevoke", "automateExecute"] as const;
export const PAY_METHODS: readonly Method[] = ["payWithAusd", "payWithToken"];
/** EverpiecePayV2 (USDC + AUSD). Two methods for one contract function so each route has its own tight gas limit. */
export const PAY_V2_METHODS: readonly Method[] = ["payV2Direct", "payV2Convert"];
/** EverpieceEarn (docs/EARN.md): gasless deposits/withdrawals into verified AUSD vaults; settle-once like EverpiecePay. */
export const EARN_METHODS: readonly Method[] = ["earnDeposit", "earnWithdraw", "earnUsdcDeposit", "earnUsdcWithdraw"];
/** USDC Earn (EverpieceEarnUsdc): same contract surface, its own router, deposits signed in USDC's own domain. */
export const EARN_USDC_METHODS: readonly Method[] = ["earnUsdcDeposit", "earnUsdcWithdraw"];
/** EverpieceAutomate (bounded automation). automateExecute is internal-only: the Automate service, never a browser. */
export const AUTOMATE_METHODS: readonly Method[] = ["automateActivate", "automateRevoke", "automateExecute"];
export type Method = (typeof METHODS)[number];

export type RelayerConfig = {
  rpcUrl: string;
  expectedChainId: number;
  escrow: Address;
  /** EverpiecePay (instant payments). Optional: without it the pay methods are refused. */
  pay?: Address;
  /** EverpiecePayV2 (USDC + AUSD settlement). Optional: without it the V2 pay methods are refused. */
  payV2?: Address;
  /** Converted V2 payments: refuse a signed maxSourceAmount above amount × (1 + this), however the payer signed. */
  maxConvertSlippageBps: bigint;
  /** Mainnet feature flags (packages/shared/src/flags.ts), from this process's env. */
  flags: FeatureFlags;
  /** EverpieceAutomate (bounded automation grants). Optional. */
  automate?: Address;
  /** Shared secret the Automate service presents on /v1/internal/* (x-internal-key). Unset = internal routes off. */
  internalKey?: string;
  /** EverpieceEarnUsdc (USDC Earn, Aave waMonUSDC). Optional. */
  earnUsdc?: Address;
  /** EverpieceEarn (gasless Earn deposits/withdrawals). Optional: without it the earn methods are refused. */
  earn?: Address;
  ausd: Address;
  /** EIP-712 name of the dollar token's domain: "Agora Dollar" (AUSD) by default, "Everpiece Test Dollar" on testnet. */
  ausdEip712Name?: string;
  /** The asset the protected-send ESCROW holds and its EIP-712 domain (mainnet: USDC "USDC"/"2"; defaults to the dollar above). */
  escrowAsset: { address: Address; eip712Name: string; eip712Version: string };
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
    payV2: env.PAY_V2_ADDRESS ? address(env, "PAY_V2_ADDRESS") : undefined,
    maxConvertSlippageBps: big(env, "MAX_CONVERT_SLIPPAGE_BPS", 50n),
    flags: readFlags(env),
    earn: env.EARN_ADDRESS ? address(env, "EARN_ADDRESS") : undefined,
    earnUsdc: env.EARN_USDC_ADDRESS ? address(env, "EARN_USDC_ADDRESS") : undefined,
    automate: env.AUTOMATE_ADDRESS ? address(env, "AUTOMATE_ADDRESS") : undefined,
    internalKey: env.RELAYER_INTERNAL_KEY && env.RELAYER_INTERNAL_KEY.length >= 32 ? env.RELAYER_INTERNAL_KEY : undefined,
    ausd: address(env, "AUSD_ADDRESS", AUSD_ADDRESS),
    ausdEip712Name: env.DOLLAR_EIP712_NAME ?? AUSD_EIP712_NAME,
    escrowAsset: {
      address: address(env, "ESCROW_ASSET_ADDRESS", address(env, "AUSD_ADDRESS", AUSD_ADDRESS)),
      eip712Name: env.ESCROW_ASSET_EIP712_NAME ?? env.DOLLAR_EIP712_NAME ?? AUSD_EIP712_NAME,
      eip712Version: env.ESCROW_ASSET_EIP712_VERSION ?? "1",
    },
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
      earnDeposit: big(env, "GAS_LIMIT_EARN_DEPOSIT", 850_000n),
      earnWithdraw: big(env, "GAS_LIMIT_EARN_WITHDRAW", 750_000n),
      // RelayerGasV2.t.sol, real Aave waMonUSDC, cold state: USDC Earn deposit 765,136, withdraw 643,800
      earnUsdcDeposit: big(env, "GAS_LIMIT_EARN_USDC_DEPOSIT", 820_000n),
      earnUsdcWithdraw: big(env, "GAS_LIMIT_EARN_USDC_WITHDRAW", 700_000n),
      // RelayerGasV2.t.sol AutomateForkTest, real USDC + Aave waMonUSDC, cold: activate 359,751 / execute 770,178
      automateActivate: big(env, "GAS_LIMIT_AUTOMATE_ACTIVATE", 400_000n),
      automateRevoke: big(env, "GAS_LIMIT_AUTOMATE_REVOKE", 120_000n),
      automateExecute: big(env, "GAS_LIMIT_AUTOMATE_EXECUTE", 830_000n),
      // RelayerGasV2.t.sol, real mainnet tokens, cold state: direct USDC 307,702 / AUSD 271,199; conversion worst case
      // (Agora approved but failing, then the v4 converter) 664,077, and that path completes at exactly this limit.
      payV2Direct: big(env, "GAS_LIMIT_PAY_V2_DIRECT", 340_000n),
      payV2Convert: big(env, "GAS_LIMIT_PAY_V2_CONVERT", 800_000n),
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
  // Aurora is a FUNDING provider (docs/ROUTING.md §3.2). It delivers USDC, which is itself a first-class settlement
  // asset (EverpiecePayV2), so a payment request in USDC is settled by Aurora's delivery alone; an AUSD request is
  // delivered as USDC and converted on-chain by the recipient. AUSD is not on Aurora's list (VERIFIED §4.14).
  const ausd = env.AUSD_ADDRESS ? address(env, "AUSD_ADDRESS") : AUSD_ADDRESS;
  if (destination.toLowerCase() === ausd.toLowerCase()) throw new Error("config: Aurora must not deliver AUSD directly (docs/ROUTING.md §3.2)");
  const t = tokenFor(chainId, destination);
  const settleable = settlementAsset(chainId, destination) !== undefined || t?.route === "AGORA_INSTANT_SETTLEMENT";
  if (!settleable) throw new Error("config: AURORA_DESTINATION_TOKEN must be a settlement asset or have a verified Agora route (docs/ROUTING.md §3.1)");
  return {
    apiUrl: (env.AURORA_API_URL || AURORA_API_URL).replace(/\/$/, ""),
    apiKey: env.AURORA_API_KEY,
    confidential: env.AURORA_CONFIDENTIAL === "true",
    destinationToken: destination,
    slippageBps: int(env, "FUNDING_SLIPPAGE_BPS", 50), // stable → stable; excess input is refunded by Aurora
    deadlineMinutes: int(env, "FUNDING_DEADLINE_MINUTES", 30),
    maxWholeTokens: int(env, "FUNDING_MAX_WHOLE_TOKENS", 600), // the $500 payment ceiling + room for fees
    perIpPerMinute: int(env, "FUNDING_PER_IP_PER_MINUTE", 60),
  };
}
