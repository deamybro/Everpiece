import { createHmac, randomBytes, randomInt } from "node:crypto";
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
 * SIMULATED provider for local/fork tests ONLY (config refuses it unless ALLOW_SIMULATED_SMS=1 and the RPC is
 * localhost). Codes go to an injected sink, never to logs; only an HMAC of the code is kept, 10-minute expiry.
 */
export class SimulatedProvider implements VerificationProvider {
  readonly name = "SIMULATED";
  readonly live = false;
  private readonly secret = randomBytes(32);
  private readonly pending = new Map<string, { mac: string; exp: number }>();
  private readonly sink: (e164: string, code: string) => void;
  private readonly now: () => number;
  constructor(sink: (e164: string, code: string) => void, now: () => number = Date.now) {
    this.sink = sink;
    this.now = now;
  }
  private mac(ref: string, code: string) {
    return createHmac("sha256", this.secret).update(`${ref}:${code}`).digest("hex");
  }
  async start(e164: string): Promise<{ ref: string }> {
    const ref = "SIM" + randomBytes(12).toString("hex");
    const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
    this.pending.set(ref, { mac: this.mac(ref, code), exp: this.now() + 600_000 });
    this.sink(e164, code);
    return { ref };
  }
  async check(_e164: string, code: string, ref: string): Promise<CheckResult> {
    const p = this.pending.get(ref);
    if (!p || this.now() > p.exp) return "dead";
    if (p.mac !== this.mac(ref, code)) return "wrong";
    this.pending.delete(ref);
    return "approved";
  }
}

export function providerFromConfig(cfg: ClaimsConfig, simulatedSink?: (e164: string, code: string) => void): VerificationProvider {
  if (cfg.smsProvider === "twilio") return new TwilioVerifyProvider(cfg.twilio!);
  if (cfg.smsProvider === "termii") return new TermiiProvider(cfg.termii!);
  return new SimulatedProvider(simulatedSink ?? (() => {}));
}
