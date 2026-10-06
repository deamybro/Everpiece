import { getAddress, isAddress, isHex, type Address, type Hex } from "viem";
import { MONAD_MAINNET_CHAIN_ID } from "@everpiece/shared";

/** The payout server never holds customer money (owner decision P1). It holds bank details, encrypted (P4). */
export type PayoutConfig = {
  expectedChainId: number;
  /** EIP-712 verifyingContract of the signed records (the directory's pinned domain). */
  domainAddress: Address;
  /** Paycrest Sender API (VERIFIED §4.15). The test site points this at its SIMULATED Paycrest. */
  paycrestUrl: string;
  paycrestApiKey: string;
  paycrestApiSecret: string;
  /** Where the stablecoin is paid in (mainnet: USDC on Base, reached by CCTP; docs/PAYOUT.md §5). */
  sourceNetwork: string;
  sourceCurrency: string;
  /** "At least ₦X" (P2): stablecoin quoted with this buffer over the live rate. */
  rateBufferBps: number;
  /** AES-256-GCM root key for bank account numbers at rest. */
  bankEncKey: Hex;
  port: number;
  host: string;
  dbPath: string;
  allowedOrigin?: string;
  perIpPerMinute: number;
  /** Bank-account verifications per IP per day (each one is a real name lookup at the provider). */
  verificationsPerIpPerDay: number;
  /** Label shown to users when the provider is simulated (test site). */
  simulated: boolean;
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

export function loadConfig(env: NodeJS.ProcessEnv = process.env): PayoutConfig {
  const domain = req(env, "DIRECTORY_DOMAIN_ADDRESS");
  if (!isAddress(domain, { strict: false })) throw new Error("config: DIRECTORY_DOMAIN_ADDRESS must be an address");
  const key = req(env, "PAYOUT_BANK_ENC_KEY");
  if (!isHex(key) || key.length !== 66) throw new Error("config: PAYOUT_BANK_ENC_KEY must be a 32-byte hex value");
  const allowedOrigin = env.ALLOWED_ORIGIN;
  if (allowedOrigin && new URL(allowedOrigin).origin !== allowedOrigin) throw new Error("config: ALLOWED_ORIGIN must be a bare origin");
  return {
    expectedChainId: int(env, "EXPECTED_CHAIN_ID", MONAD_MAINNET_CHAIN_ID),
    domainAddress: getAddress(domain),
    paycrestUrl: (env.PAYCREST_API_URL || "https://api.paycrest.io").replace(/\/$/, ""),
    paycrestApiKey: req(env, "PAYCREST_API_KEY"),
    paycrestApiSecret: req(env, "PAYCREST_API_SECRET"),
    sourceNetwork: env.PAYOUT_SOURCE_NETWORK || "base",
    sourceCurrency: env.PAYOUT_SOURCE_CURRENCY || "USDC",
    rateBufferBps: int(env, "PAYOUT_RATE_BUFFER_BPS", 100),
    bankEncKey: key as Hex,
    port: int(env, "PORT", 8793),
    host: env.HOST ?? "127.0.0.1",
    dbPath: env.PAYOUT_DB_PATH ?? "payout.sqlite",
    allowedOrigin,
    perIpPerMinute: int(env, "PER_IP_PER_MINUTE", 60),
    verificationsPerIpPerDay: int(env, "VERIFICATIONS_PER_IP_PER_DAY", 20),
    simulated: env.PAYOUT_SIMULATED === "1",
  };
}
