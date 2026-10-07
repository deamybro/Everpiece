import { isAddress, type Address } from "viem";

/** The Automate service never holds money or keys: it stores owner-signed rules and plans; the owner (or, later, a
 *  bounded on-chain module) executes. docs/AUTOMATE.md. */
export type AutomateConfig = {
  expectedChainId: number;
  /** EIP-712 verifyingContract of the signed records (the directory's pinned domain). */
  domainAddress: Address;
  port: number;
  host: string;
  dbPath: string;
  allowedOrigin?: string;
  /** Shared secret for trigger intake (the indexer watcher). Triggers are never accepted from browsers. */
  internalKey: string;
  /** How long a prepared execution waits for the owner's fingerprint before it lapses (money stays in the balance). */
  confirmWindowSec: number;
  maxRulesPerOwner: number;
  perIpPerMinute: number;
  readsPerIpPerMinute: number;
};

const int = (env: NodeJS.ProcessEnv, n: string, d: number) => {
  const v = env[n];
  if (v === undefined || v === "") return d;
  const x = Number(v);
  if (!Number.isSafeInteger(x) || x < 0) throw new Error(`config: ${n} must be a non-negative integer`);
  return x;
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AutomateConfig {
  const domain = env.DIRECTORY_DOMAIN_ADDRESS ?? "";
  if (!isAddress(domain, { strict: false })) throw new Error("config: DIRECTORY_DOMAIN_ADDRESS must be an address");
  const internalKey = env.AUTOMATE_INTERNAL_KEY ?? "";
  if (internalKey.length < 32) throw new Error("config: AUTOMATE_INTERNAL_KEY must be at least 32 characters");
  return {
    expectedChainId: int(env, "EXPECTED_CHAIN_ID", 10143),
    domainAddress: domain as Address,
    port: int(env, "PORT", 8794),
    host: env.HOST ?? "127.0.0.1",
    dbPath: env.AUTOMATE_DB ?? "automate.sqlite",
    allowedOrigin: env.ALLOWED_ORIGIN || undefined,
    internalKey,
    confirmWindowSec: int(env, "CONFIRM_WINDOW_SEC", 86_400),
    maxRulesPerOwner: int(env, "MAX_RULES_PER_OWNER", 20),
    perIpPerMinute: int(env, "WRITES_PER_IP_PER_MINUTE", 30),
    readsPerIpPerMinute: int(env, "READS_PER_IP_PER_MINUTE", 240),
  };
}
