// Mainnet feature flags (mainnet mandate §33): "Do not enable a feature merely because code exists."
// Every flag is OFF unless its env var is exactly "true". NGN payout is forced off ("Coming Soon").

export const FEATURE_FLAGS = [
  "USDC_PAYMENTS_ENABLED",
  "AUSD_PAYMENTS_ENABLED",
  "AGORA_SETTLEMENT_ENABLED",
  "DEX_AUSD_FALLBACK_ENABLED",
  "AURORA_LIVE_ENABLED",
  "PRIVATE_PAYMENTS_ENABLED",
  "AUTOMATE_ENABLED",
  "EARN_ENABLED",
  "INVEST_ENABLED",
  "NGN_PAYOUT_ENABLED",
] as const;
export type FeatureFlag = (typeof FEATURE_FLAGS)[number];
export type FeatureFlags = Record<FeatureFlag, boolean>;

/** Flags that stay off whatever the environment says, with the reason shown to users / operators. */
export const FORCED_OFF: Partial<Record<FeatureFlag, string>> = {
  NGN_PAYOUT_ENABLED: "Coming Soon: no licensed NGN payout partner is live (docs/PAYOUT.md).",
  // No DEX fallback is implemented: a verified route must be a fixed, allowlisted contract call (never relayed
  // calldata) and none is built yet (docs/MAINNET_AUDIT.md).
  DEX_AUSD_FALLBACK_ENABLED: "Not built: no verified fixed-call DEX route yet.",
};

/** Reads flags from an env-like record (process.env, or NEXT_PUBLIC_-prefixed in the web app). Fail closed. */
export function readFlags(env: Record<string, string | undefined>, prefix = ""): FeatureFlags {
  const out = {} as FeatureFlags;
  for (const f of FEATURE_FLAGS) out[f] = !FORCED_OFF[f] && env[prefix + f] === "true";
  return out;
}

/** What each flag additionally needs before it may be turned on for mainnet (checked by operators, not code). */
export const FLAG_PREREQUISITES: Record<FeatureFlag, string> = {
  USDC_PAYMENTS_ENABLED: "EverpiecePayV2 deployed (owner GO), relayer PAY_V2_ADDRESS set, canary passed.",
  AUSD_PAYMENTS_ENABLED: "EverpiecePayV2 deployed (owner GO), canary passed.",
  AGORA_SETTLEMENT_ENABLED: "Agora granted EverpiecePayV2 APPROVED_SWAPPER on the AUSD/USDC pair; quote() returns available.",
  DEX_AUSD_FALLBACK_ENABLED: "Forced off until a verified fixed-call DEX route exists.",
  AURORA_LIVE_ENABLED: "Aurora Intents API key (studio.aurora.dev) on the relayer; mainnet-only route tested with a small canary.",
  PRIVATE_PAYMENTS_ENABLED: "TACEO Merces access + compliance service; mainnet limits are 1 USDC/tx, 35 tx/epoch, 100 members (VERIFIED §4.11).",
  AUTOMATE_ENABLED: "Automate service pointed at mainnet contracts; rules dry-run against finalized state.",
  EARN_ENABLED: "EverpieceEarnUsdc (and/or AUSD Earn) deployed (owner GO); vault liquidity checked.",
  INVEST_ENABLED: "A route that passes docs/INVEST.md safety criteria; currently none (aStocks NOT_AVAILABLE).",
  NGN_PAYOUT_ENABLED: "Forced off (Coming Soon).",
};
