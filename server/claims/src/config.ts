import { getAddress, isAddress, isHex, type Address, type Hex } from "viem";
import { MONAD_MAINNET_CHAIN_ID } from "@everpiece/shared";

export type SmsProviderName = "twilio" | "twilio-sms" | "termii" | "simulated";
export type EmailProviderName = "none" | "resend" | "simulated";

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
  /** Plain Twilio SMS; Everpiece generates/checks the code (LocalOtp). */
  twilioSms?: { user: string; secret: string; accountSid: string; from: string; baseUrl: string };
  termii?: { baseUrl: string; apiKey: string; senderId: string };
  /** Email channel for the verification code. "none" (default): link payments are SMS-only. */
  emailProvider?: EmailProviderName;
  /** Codes per email address per day (defaults to perPhonePerDay). */
  perEmailPerDay?: number;
  /** Resend (VERIFIED §4.8); Everpiece generates/checks the code (LocalOtp). `from` must be on a Resend-verified domain. */
  resend?: { apiKey: string; from: string; baseUrl: string };
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
  if (!["twilio", "twilio-sms", "termii", "simulated"].includes(smsProvider)) throw new Error("config: SMS_PROVIDER must be twilio | twilio-sms | termii | simulated");
  const rpcUrl = req(env, "MONAD_RPC");

  // A simulated provider must never back a real deployment (master §0.5: never present SIMULATED as LIVE).
  if (smsProvider === "simulated" && !(env.ALLOW_SIMULATED_SMS === "1" && isLocalRpc(rpcUrl))) {
    throw new Error("config: SMS_PROVIDER=simulated requires ALLOW_SIMULATED_SMS=1 and a localhost MONAD_RPC");
  }

  const emailProvider = (env.EMAIL_PROVIDER ?? "none") as EmailProviderName;
  if (!["none", "resend", "simulated"].includes(emailProvider)) throw new Error("config: EMAIL_PROVIDER must be none | resend | simulated");
  if (emailProvider === "simulated" && !(env.ALLOW_SIMULATED_EMAIL === "1" && isLocalRpc(rpcUrl))) {
    throw new Error("config: EMAIL_PROVIDER=simulated requires ALLOW_SIMULATED_EMAIL=1 and a localhost MONAD_RPC");
  }

  const cfg: ClaimsConfig = {
    rpcUrl,
    emailProvider,
    perEmailPerDay: int(env, "EMAIL_PER_ADDRESS_PER_DAY", 10),
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
  if (smsProvider === "twilio-sms") {
    const accountSid = req(env, "TWILIO_ACCOUNT_SID");
    if (!/^AC[0-9a-fA-F]{32}$/.test(accountSid)) throw new Error("config: TWILIO_ACCOUNT_SID must look like AC + 32 hex");
    const from = req(env, "TWILIO_FROM_NUMBER");
    if (!/^\+[1-9][0-9]{7,14}$/.test(from)) throw new Error("config: TWILIO_FROM_NUMBER must be E.164");
    cfg.twilioSms = {
      user: req(env, "TWILIO_API_USER"), // API Key SID (SK…) or Account SID
      secret: req(env, "TWILIO_API_SECRET"),
      accountSid,
      from,
      baseUrl: env.TWILIO_MESSAGES_BASE_URL ?? "https://api.twilio.com/2010-04-01",
    };
  }
  if (emailProvider === "resend") {
    const apiKey = req(env, "RESEND_API_KEY");
    if (!/^re_\S{8,}$/.test(apiKey)) throw new Error("config: RESEND_API_KEY must look like re_…");
    const from = req(env, "EMAIL_FROM");
    // "Name <addr@domain>" or "addr@domain"; the domain must be verified in Resend.
    if (!/^([^<>\r\n]{1,64} <[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+>|[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+)$/.test(from)) {
      throw new Error('config: EMAIL_FROM must be "Name <addr@domain>" or "addr@domain"');
    }
    cfg.resend = { apiKey, from, baseUrl: env.RESEND_BASE_URL ?? "https://api.resend.com" };
  }
  if (smsProvider === "termii") {
    cfg.termii = { baseUrl: req(env, "TERMII_BASE_URL"), apiKey: req(env, "TERMII_API_KEY"), senderId: req(env, "TERMII_SENDER_ID") };
  }
  return cfg;
}
