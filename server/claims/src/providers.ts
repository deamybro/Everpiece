import { createHmac, hkdfSync, randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import type { ClaimsConfig } from "./config.ts";

/**
 * A verification provider sends a one-time code to a phone and later checks it. With Twilio Verify and Termii the
 * PROVIDER generates, stores and checks the code, so Everpiece never stores OTPs at all (master §13).
 */
export type CheckResult = "approved" | "wrong" | "dead";
export interface VerificationProvider {
  readonly name: string;
  readonly live: boolean; // false => SIMULATED; must be surfaced as such (master §0.5)
  start(e164: string): Promise<{ ref: string }>;
  check(e164: string, code: string, ref: string): Promise<CheckResult>;
}

export class ProviderError extends Error {}

const TIMEOUT = 10_000;

/**
 * Twilio Verify (docs/VERIFIED.md §4.4):
 *   POST {base}/Services/{ServiceSid}/Verifications      To, Channel=sms           → { sid, status }
 *   POST {base}/Services/{ServiceSid}/VerificationCheck  To, Code                  → { status: approved|pending|… }
 *   HTTP Basic (Account SID + Auth Token, or API Key SID + secret), application/x-www-form-urlencoded, JSON replies.
 *   A verification is deleted after 10 min, on approval, or at max attempts → VerificationCheck returns 404.
 */
export class TwilioVerifyProvider implements VerificationProvider {
  readonly name = "twilio-verify";
  readonly live = true;
  private readonly cfg: NonNullable<ClaimsConfig["twilio"]>;
  private readonly fetchImpl: typeof fetch;
  constructor(cfg: NonNullable<ClaimsConfig["twilio"]>, fetchImpl: typeof fetch = fetch) {
    this.cfg = cfg;
    this.fetchImpl = fetchImpl;
  }

  private async post(path: string, form: Record<string, string>): Promise<Response> {
    return this.fetchImpl(`${this.cfg.baseUrl}/Services/${this.cfg.serviceSid}/${path}`, {
      method: "POST",
      headers: {
        authorization: "Basic " + Buffer.from(`${this.cfg.user}:${this.cfg.secret}`).toString("base64"),
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams(form).toString(),
      signal: AbortSignal.timeout(TIMEOUT),
    });
  }

  async start(e164: string): Promise<{ ref: string }> {
    const r = await this.post("Verifications", { To: e164, Channel: "sms" });
    if (!r.ok) throw new ProviderError(`twilio start HTTP ${r.status}`);
    const j = (await r.json()) as { sid?: string; status?: string };
    if (!j.sid || j.status !== "pending") throw new ProviderError(`twilio start status ${j.status}`);
    return { ref: j.sid };
  }

  async check(e164: string, code: string, _ref?: string): Promise<CheckResult> {
    const r = await this.post("VerificationCheck", { To: e164, Code: code });
    if (r.status === 404) return "dead"; // expired, approved already, or max attempts reached
    if (!r.ok) throw new ProviderError(`twilio check HTTP ${r.status}`);
    const j = (await r.json()) as { status?: string };
    if (j.status === "approved") return "approved";
    if (j.status === "pending") return "wrong";
    return "dead"; // canceled | max_attempts_reached | expired | failed | deleted
  }
}

/**
 * Termii Token API (docs/VERIFIED.md §4.5):
 *   POST {TERMII_BASE_URL}/api/sms/otp/send    api_key, message_type, to, from, channel, pin_attempts, pin_time_to_live,
 *                                              pin_length, pin_placeholder, message_text, pin_type → { pinId, … }
 *   POST {TERMII_BASE_URL}/api/sms/otp/verify  api_key, pin_id, pin → { pinId, verified: "True", msisdn }
 * TODO(VERIFY): request body encoding (JSON assumed), whether `to` accepts a leading "+", and the exact
 * failed/expired response shape — https://developers.termii.com (live account test before enabling).
 */
export class TermiiProvider implements VerificationProvider {
  readonly name = "termii";
  readonly live = true;
  private readonly cfg: NonNullable<ClaimsConfig["termii"]>;
  private readonly fetchImpl: typeof fetch;
  constructor(cfg: NonNullable<ClaimsConfig["termii"]>, fetchImpl: typeof fetch = fetch) {
    this.cfg = cfg;
    this.fetchImpl = fetchImpl;
  }

  private post(path: string, body: Record<string, unknown>): Promise<Response> {
    return this.fetchImpl(`${this.cfg.baseUrl.replace(/\/$/, "")}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT),
    });
  }

  async start(e164: string): Promise<{ ref: string }> {
    const r = await this.post("/api/sms/otp/send", {
      api_key: this.cfg.apiKey,
      message_type: "NUMERIC",
      to: e164.replace(/^\+/, ""),
      from: this.cfg.senderId,
      channel: "dnd", // transactional route for Nigeria's DND registry
      pin_attempts: 5,
      pin_time_to_live: 10,
      pin_length: 6,
      pin_placeholder: "< 1234 >",
      message_text: "Your Everpiece code is < 1234 >. It expires in 10 minutes. Never share it with anyone, including the sender.",
      pin_type: "NUMERIC",
    });
    if (!r.ok) throw new ProviderError(`termii send HTTP ${r.status}`);
    const j = (await r.json()) as { pinId?: string };
    if (!j.pinId) throw new ProviderError("termii send: no pinId");
    return { ref: j.pinId };
  }

  async check(_e164: string, code: string, ref: string): Promise<CheckResult> {
    const r = await this.post("/api/sms/otp/verify", { api_key: this.cfg.apiKey, pin_id: ref, pin: code });
    if (!r.ok) return r.status >= 500 ? Promise.reject(new ProviderError(`termii verify HTTP ${r.status}`)) : "wrong";
    const j = (await r.json()) as { verified?: unknown };
    if (j.verified === true || j.verified === "True" || j.verified === "true") return "approved";
    if (typeof j.verified === "string" && /expired/i.test(j.verified)) return "dead";
    return "wrong";
  }
}

/**
 * Everpiece-generated one-time codes (for plain SMS channels that do not check codes themselves).
 * Master §13: the code is never stored — only HMAC-SHA256(key, ref:code) with a 10-minute expiry; single use;
 * constant-time comparison. Pending codes live in process memory: a restart only means "request a new code".
 */
export class LocalOtp {
  private readonly key: Buffer;
  private readonly pending = new Map<string, { mac: Buffer; exp: number }>();
  private readonly now: () => number;
  static readonly TTL_MS = 600_000;
  constructor(key: Buffer, now: () => number = Date.now) {
    this.key = key;
    this.now = now;
  }
  private mac(ref: string, code: string): Buffer {
    return createHmac("sha256", this.key).update(`${ref}:${code}`).digest();
  }
  issue(prefix: string): { ref: string; code: string } {
    const ref = prefix + randomBytes(12).toString("hex");
    const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
    this.pending.set(ref, { mac: this.mac(ref, code), exp: this.now() + LocalOtp.TTL_MS });
    return { ref, code };
  }
  forget(ref: string): void {
    this.pending.delete(ref);
  }
  check(ref: string, code: string): CheckResult {
    const p = this.pending.get(ref);
    if (!p || this.now() > p.exp) {
      this.pending.delete(ref);
      return "dead";
    }
    if (!timingSafeEqual(p.mac, this.mac(ref, code))) return "wrong";
    this.pending.delete(ref);
    return "approved";
  }
}

/** One GSM-7 segment; the code is the only variable part. */
export function otpMessage(code: string): string {
  return `Your Everpiece code is ${code}. It expires in 10 minutes. Never share it with anyone, including the person who sent you money.`;
}

/**
 * Twilio Programmable Messaging (VERIFIED §4.6): Everpiece generates the code (LocalOtp) and Twilio only delivers it.
 *   POST {base}/Accounts/{AccountSid}/Messages.json   To, From, Body   → { sid, status, error_code }
 *   HTTP Basic (Account SID + Auth Token, or API Key SID + secret with the AccountSid still in the URL), form-encoded.
 * Works on a Twilio trial (free SMS units; trial accounts can only text verified numbers).
 */
export class TwilioSmsProvider implements VerificationProvider {
  readonly name = "twilio-sms";
  readonly live = true;
  private readonly cfg: NonNullable<ClaimsConfig["twilioSms"]>;
  private readonly otp: LocalOtp;
  private readonly fetchImpl: typeof fetch;
  constructor(cfg: NonNullable<ClaimsConfig["twilioSms"]>, otpKey: Buffer, fetchImpl: typeof fetch = fetch, now: () => number = Date.now) {
    this.cfg = cfg;
    this.otp = new LocalOtp(otpKey, now);
    this.fetchImpl = fetchImpl;
  }

  async start(e164: string): Promise<{ ref: string }> {
    const { ref, code } = this.otp.issue("TSMS");
    const r = await this.fetchImpl(`${this.cfg.baseUrl}/Accounts/${this.cfg.accountSid}/Messages.json`, {
      method: "POST",
      headers: {
        authorization: "Basic " + Buffer.from(`${this.cfg.user}:${this.cfg.secret}`).toString("base64"),
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ To: e164, From: this.cfg.from, Body: otpMessage(code) }).toString(),
      signal: AbortSignal.timeout(TIMEOUT),
    });
    if (!r.ok) {
      this.otp.forget(ref);
      const j = (await r.json().catch(() => ({}))) as { code?: number };
      throw new ProviderError(`twilio sms HTTP ${r.status}${j.code ? ` code ${j.code}` : ""}`);
    }
    const j = (await r.json()) as { sid?: string; status?: string };
    if (!j.sid || j.status === "failed" || j.status === "undelivered") {
      this.otp.forget(ref);
      throw new ProviderError(`twilio sms status ${j.status}`);
    }
    return { ref };
  }

  async check(_e164: string, code: string, ref: string): Promise<CheckResult> {
    return this.otp.check(ref, code);
  }
}

/**
 * SIMULATED provider for local/fork tests ONLY (config refuses it unless ALLOW_SIMULATED_SMS=1 and the RPC is
 * localhost). Codes go to an injected sink, never to logs; same LocalOtp storage rules as live SMS.
 */
export class SimulatedProvider implements VerificationProvider {
  readonly name = "SIMULATED";
  readonly live = false;
  private readonly otp: LocalOtp;
  private readonly sink: (e164: string, code: string) => void;
  constructor(sink: (e164: string, code: string) => void, now: () => number = Date.now) {
    this.sink = sink;
    this.otp = new LocalOtp(randomBytes(32), now);
  }
  async start(e164: string): Promise<{ ref: string }> {
    const { ref, code } = this.otp.issue("SIM");
    this.sink(e164, code);
    return { ref };
  }
  async check(_e164: string, code: string, ref: string): Promise<CheckResult> {
    return this.otp.check(ref, code);
  }
}

/** OTP MAC key: HKDF from PHONE_ENC_KEY with its own label (independent of the phone enc/lookup subkeys). */
export function otpKeyFrom(phoneEncKey: `0x${string}`): Buffer {
  return Buffer.from(hkdfSync("sha256", Buffer.from(phoneEncKey.slice(2), "hex"), Buffer.alloc(0), "everpiece.claims.otp.mac.v1", 32));
}

export function providerFromConfig(cfg: ClaimsConfig, simulatedSink?: (e164: string, code: string) => void): VerificationProvider {
  if (cfg.smsProvider === "twilio") return new TwilioVerifyProvider(cfg.twilio!);
  if (cfg.smsProvider === "twilio-sms") return new TwilioSmsProvider(cfg.twilioSms!, otpKeyFrom(cfg.phoneEncKey));
  if (cfg.smsProvider === "termii") return new TermiiProvider(cfg.termii!);
  return new SimulatedProvider(simulatedSink ?? (() => {}));
}
