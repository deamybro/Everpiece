import { getAddress, isAddress, isHex, type Address, type Hex } from "viem";
import { MONAD_MAINNET_CHAIN_ID } from "@everpiece/shared";

export type SmsProviderName = "twilio" | "termii" | "simulated";

export type ClaimsConfig = {
  rpcUrl: string;
  expectedChainId: number;
  escrow: Address;
  approverPrivateKey: Hex;
  /** 32-byte key: AES-256-GCM for phone numbers at rest + HMAC for phone lookup keys (master §12.3). */
  phoneEncKey: Hex;
  port: number;
  host: string;
  dbPath: string;
  smsProvider: SmsProviderName;
  twilio?: { user: string; secret: string; serviceSid: string; baseUrl: string };
  termii?: { baseUrl: string; apiKey: string; senderId: string };
  /** Approval lifetime: short (master §14). */
  approvalTtlSec: number;
  /** Max clock skew allowed on client-supplied request deadlines. */
  requestDeadlineMaxSec: number;
  /** Progressive resend cooldowns (seconds): 1st resend waits [0], 2nd [1], … capped at the last. Never permanent. */
  resendCooldownsSec: number[];
  sessionTtlSec: number;
  maxVerifyAttempts: number;
  perPhonePerDay: number;
  perIpPerMinute: number;
  allowRetiredApprover: boolean;
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
const key32 = (env: NodeJS.ProcessEnv, n: string): Hex => {
  const v = req(env, n);
  if (!isHex(v) || v.length !== 66) throw new Error(`config: ${n} must be a 32-byte hex value`);
  return v;
};

export function isLocalRpc(url: string): boolean {
  const h = new URL(url).hostname;
  return h === "127.0.0.1" || h === "localhost" || h === "[::1]";
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ClaimsConfig {
  const escrow = req(env, "ESCROW_ADDRESS");
  if (!isAddress(escrow, { strict: false })) throw new Error("config: ESCROW_ADDRESS must be an address");
  const smsProvider = (env.SMS_PROVIDER ?? "twilio") as SmsProviderName;
  if (!["twilio", "termii", "simulated"].includes(smsProvider)) throw new Error("config: SMS_PROVIDER must be twilio | termii | simulated");
  const rpcUrl = req(env, "MONAD_RPC");

  // A simulated provider must never back a real deployment (master §0.5: never present SIMULATED as LIVE).
  if (smsProvider === "simulated" && !(env.ALLOW_SIMULATED_SMS === "1" && isLocalRpc(rpcUrl))) {
    throw new Error("config: SMS_PROVIDER=simulated requires ALLOW_SIMULATED_SMS=1 and a localhost MONAD_RPC");
  }

  const cfg: ClaimsConfig = {
    rpcUrl,
    expectedChainId: int(env, "EXPECTED_CHAIN_ID", MONAD_MAINNET_CHAIN_ID),
    escrow: getAddress(escrow),
    approverPrivateKey: key32(env, "APPROVER_PRIVATE_KEY"),
    phoneEncKey: key32(env, "PHONE_ENC_KEY"),
    port: int(env, "PORT", 8788),
    host: env.HOST ?? "127.0.0.1",
    dbPath: env.CLAIMS_DB_PATH ?? "claims.sqlite",
    smsProvider,
    approvalTtlSec: int(env, "APPROVAL_TTL_SEC", 300),
    requestDeadlineMaxSec: int(env, "REQUEST_DEADLINE_MAX_SEC", 600),
    resendCooldownsSec: (env.RESEND_COOLDOWNS_SEC ?? "30,60,120,300,600").split(",").map((s) => {
      const n = Number(s);
      if (!Number.isSafeInteger(n) || n < 0) throw new Error("config: RESEND_COOLDOWNS_SEC must be comma-separated seconds");
      return n;
    }),
    sessionTtlSec: int(env, "VERIFY_SESSION_TTL_SEC", 600),
    maxVerifyAttempts: int(env, "MAX_VERIFY_ATTEMPTS", 5),
    perPhonePerDay: int(env, "SMS_PER_PHONE_PER_DAY", 10),
    perIpPerMinute: int(env, "RATE_PER_IP_PER_MINUTE", 20),
    allowRetiredApprover: env.APPROVER_ALLOW_RETIRED === "1",
    allowedOrigin: env.ALLOWED_ORIGIN,
    maxBodyBytes: int(env, "MAX_BODY_BYTES", 4_096),
  };
  if (smsProvider === "twilio") {
    cfg.twilio = {
      user: req(env, "TWILIO_API_USER"), // Account SID, or API Key SID
      secret: req(env, "TWILIO_API_SECRET"), // Auth Token, or API Key secret
      serviceSid: req(env, "TWILIO_VERIFY_SERVICE_SID"),
      baseUrl: env.TWILIO_VERIFY_BASE_URL ?? "https://verify.twilio.com/v2",
    };
  }
  if (smsProvider === "termii") {
    cfg.termii = { baseUrl: req(env, "TERMII_BASE_URL"), apiKey: req(env, "TERMII_API_KEY"), senderId: req(env, "TERMII_SENDER_ID") };
  }
  return cfg;
}
