import type { Address } from "viem";

/** Public runtime config (NEXT_PUBLIC_* are inlined at build time; keep accesses literal). */
export const config = {
  chainId: Number(process.env.NEXT_PUBLIC_CHAIN_ID ?? "143"),
  rpcUrl: process.env.NEXT_PUBLIC_MONAD_RPC ?? "https://rpc.monad.xyz",
  escrow: (process.env.NEXT_PUBLIC_ESCROW_ADDRESS ?? "") as Address,
  relayerUrl: process.env.NEXT_PUBLIC_RELAYER_URL ?? "",
  claimsUrl: process.env.NEXT_PUBLIC_CLAIMS_URL ?? "",
  directoryUrl: process.env.NEXT_PUBLIC_DIRECTORY_URL ?? "",
  /** Local dev stack only: mints TEST Dollars on a local fork. Never set in production. */
  devFaucetUrl: process.env.NEXT_PUBLIC_DEV_FAUCET_URL ?? "",
};

export const isDevStack = config.devFaucetUrl !== "";
