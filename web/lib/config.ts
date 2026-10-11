import type { Address } from "viem";
import { AUSD_ADDRESS, AUSD_EIP712_NAME, readFlags, type DollarToken } from "@everpiece/shared";

/** Public runtime config (NEXT_PUBLIC_* are inlined at build time; keep accesses literal). */
export const config = {
  chainId: Number(process.env.NEXT_PUBLIC_CHAIN_ID ?? "143"),
  rpcUrl: process.env.NEXT_PUBLIC_MONAD_RPC ?? "https://rpc.monad.xyz",
  escrow: (process.env.NEXT_PUBLIC_ESCROW_ADDRESS ?? "") as Address,
  /** EIP-712 domain of @username records, message keys and payment requests. Pinned across escrow redeploys. */
  directoryDomain: (process.env.NEXT_PUBLIC_DIRECTORY_DOMAIN || process.env.NEXT_PUBLIC_ESCROW_ADDRESS || "") as Address,
  /** EverpiecePay (instant payments). Empty = instant payments unavailable. */
  pay: (process.env.NEXT_PUBLIC_PAY_ADDRESS ?? "") as Address,
  /** EverpiecePayV2 (USDC + AUSD settlement). Empty = only the v1 AUSD flows. */
  payV2: (process.env.NEXT_PUBLIC_PAY_V2_ADDRESS ?? "") as Address,
  /** The dollar token: real AUSD unless a deployment sets another (TestDollar on Monad testnet). */
  dollar: {
    address: (process.env.NEXT_PUBLIC_DOLLAR_ADDRESS || AUSD_ADDRESS) as Address,
    eip712Name: process.env.NEXT_PUBLIC_DOLLAR_EIP712_NAME || AUSD_EIP712_NAME,
    eip712Version: process.env.NEXT_PUBLIC_DOLLAR_EIP712_VERSION || "1",
  } satisfies DollarToken,
  relayerUrl: process.env.NEXT_PUBLIC_RELAYER_URL ?? "",
  claimsUrl: process.env.NEXT_PUBLIC_CLAIMS_URL ?? "",
  directoryUrl: process.env.NEXT_PUBLIC_DIRECTORY_URL ?? "",
  /** Encrypted message store (server/voice). Empty = messages can't be attached; payments still work. */
  voiceUrl: process.env.NEXT_PUBLIC_VOICE_URL ?? "",
  /** Envio/Hasura GraphQL (read-only public role): payment history's source of truth. Empty = device-only fallback. */
  indexerUrl: process.env.NEXT_PUBLIC_INDEXER_URL ?? "",
  /** Block explorer for on-chain proof links (VERIFIED §1.3 / §4.9: Monadscan; testnet sets testnet.monadscan.com). */
  explorerUrl: process.env.NEXT_PUBLIC_EXPLORER_URL || "https://monadscan.com",
  /** Local dev stack only: mints TEST Dollars on a local fork. Never set in production. */
  devFaucetUrl: process.env.NEXT_PUBLIC_DEV_FAUCET_URL ?? "",
  /** "Add Dollars from another chain" (Aurora Intents): "live", "simulated" (test site: nothing crosses a chain) or "off". */
  funding: (process.env.NEXT_PUBLIC_FUNDING === "live" || process.env.NEXT_PUBLIC_FUNDING === "simulated" ? process.env.NEXT_PUBLIC_FUNDING : "off") as "live" | "simulated" | "off",
  /** Last-mile payouts (docs/PAYOUT.md): the payout server, via the app's own origin. Empty = bank payouts unavailable. */
  payoutUrl: process.env.NEXT_PUBLIC_PAYOUT_URL ?? "",
  /** The payout provider is SIMULATED (test site): no bank is paid. */
  payoutSimulated: process.env.NEXT_PUBLIC_PAYOUT_SIMULATED === "1",
  /** Earn (docs/EARN.md): EverpieceEarn + its vault. Empty = Earn unavailable. Testnet vault = SIMULATED yield. */
  earn: (process.env.NEXT_PUBLIC_EARN_ADDRESS ?? "") as Address,
  earnVault: (process.env.NEXT_PUBLIC_EARN_VAULT_ADDRESS ?? "") as Address,
  /** EverpieceEarnUsdc (USDC Earn, Aave waMonUSDC). Empty = USDC Earn unavailable. */
  earnUsdc: (process.env.NEXT_PUBLIC_EARN_USDC_ADDRESS ?? "") as Address,
  /** Automate (docs/AUTOMATE.md): the service, via the app's own origin. Empty = Automate unavailable. */
  automateUrl: process.env.NEXT_PUBLIC_AUTOMATE_URL ?? "",
  /** EverpieceAutomate (bounded automation grants) and the relayer EOA named as executor. Empty = confirm each run. */
  automate: (process.env.NEXT_PUBLIC_AUTOMATE_ADDRESS ?? "") as Address,
  automateExecutor: (process.env.NEXT_PUBLIC_AUTOMATE_EXECUTOR ?? "") as Address,
  /** Shown on the test-money banner, e.g. "Monad testnet"; default "Local test network" (the fork). */
  networkLabel: process.env.NEXT_PUBLIC_NETWORK_LABEL || "Local test network",
};

/**
 * Mainnet feature flags (packages/shared/src/flags.ts): off unless exactly "true"; NGN payout and the unbuilt DEX
 * fallback are forced off. Each NEXT_PUBLIC_ var is read literally so Next inlines it at build time.
 */
export const flags = readFlags({
  USDC_PAYMENTS_ENABLED: process.env.NEXT_PUBLIC_USDC_PAYMENTS_ENABLED,
  AUSD_PAYMENTS_ENABLED: process.env.NEXT_PUBLIC_AUSD_PAYMENTS_ENABLED,
  AGORA_SETTLEMENT_ENABLED: process.env.NEXT_PUBLIC_AGORA_SETTLEMENT_ENABLED,
  DEX_AUSD_FALLBACK_ENABLED: process.env.NEXT_PUBLIC_DEX_AUSD_FALLBACK_ENABLED,
  AURORA_LIVE_ENABLED: process.env.NEXT_PUBLIC_AURORA_LIVE_ENABLED,
  PRIVATE_PAYMENTS_ENABLED: process.env.NEXT_PUBLIC_PRIVATE_PAYMENTS_ENABLED,
  AUTOMATE_ENABLED: process.env.NEXT_PUBLIC_AUTOMATE_ENABLED,
  EARN_ENABLED: process.env.NEXT_PUBLIC_EARN_ENABLED,
  INVEST_ENABLED: process.env.NEXT_PUBLIC_INVEST_ENABLED,
  NGN_PAYOUT_ENABLED: process.env.NEXT_PUBLIC_NGN_PAYOUT_ENABLED,
});

export const isDevStack = config.devFaucetUrl !== "";
