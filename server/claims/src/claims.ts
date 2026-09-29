import { randomBytes } from "node:crypto";
import {
  createPublicClient,
  defineChain,
  getAddress,
  http,
  isAddress,
  recoverTypedDataAddress,
  toHex,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import {
  E164,
  PaymentMode,
  PaymentStatus,
  claimApproval,
  claimStart,
  everpieceEscrowAbi,
  inviteRegistration,
  phoneHash,
  recipientCommitment,
} from "@everpiece/shared";
import type { ClaimsConfig } from "./config.ts";
import { PhoneVault, maskPhone } from "./phone.ts";
import { ProviderError, type VerificationProvider } from "./providers.ts";
import { ClaimsStore } from "./store.ts";
import { log } from "./log.ts";

export type Result = { httpStatus: number; body: Record<string, unknown> };
const err = (httpStatus: number, error: string, extra: Record<string, unknown> = {}): Result => ({ httpStatus, body: { error, ...extra } });

class Bad extends Error {}
type Obj = Record<string, unknown>;
function fields(v: unknown, keys: readonly string[]): Obj {
  if (typeof v !== "object" || v === null || Array.isArray(v)) throw new Bad("expected object");
  const o = v as Obj;
  for (const k of Object.keys(o)) if (!keys.includes(k)) throw new Bad(`unknown field ${k}`);
  for (const k of keys) if (!(k in o)) throw new Bad(`missing field ${k}`);
  return o;
}
const hex = (v: unknown, bytes: number, n: string): Hex => {
  if (typeof v !== "string" || !new RegExp(`^0x[0-9a-fA-F]{${bytes * 2}}$`).test(v)) throw new Bad(`${n}: ${bytes}-byte hex`);
  return v.toLowerCase() as Hex;
};
const addr = (v: unknown, n: string): Address => {
  if (typeof v !== "string" || !isAddress(v, { strict: false })) throw new Bad(`${n}: address`);
  return getAddress(v);
};
const secs = (v: unknown, n: string): bigint => {
  if (typeof v !== "string" || !/^[1-9][0-9]{0,12}$/.test(v)) throw new Bad(`${n}: unix seconds as decimal string`);
  return BigInt(v);
};

type Payment = { sender: Address; expiresAt: bigint; mode: number; status: number; approver: Address; recipientCommitment: Hex };

class Limiter {
  private hits = new Map<string, number[]>();
  private readonly perMinute: number;
  constructor(perMinute: number) {
    this.perMinute = perMinute;
  }
  allow(key: string, now: number): boolean {
    const w = (this.hits.get(key) ?? []).filter((t) => now - t < 60_000);
    const ok = w.length < this.perMinute;
    if (ok) w.push(now);
    this.hits.set(key, w);
    return ok;
  }
}

/**
 * Link-mode "Capability B" (master §11–14): verify that the intended recipient controls the phone the sender
 * registered, then issue a short-lived ClaimApproval bound to the recipient's wallet. The approver can never claim
 * alone: the contract also requires the link claim key's signature (Capability A).
 */
export class ClaimsService {
  readonly cfg: ClaimsConfig;
  readonly store: ClaimsStore;
  readonly provider: VerificationProvider;
  readonly approver: PrivateKeyAccount;
  readonly client: PublicClient;
  private readonly vault: PhoneVault;
  private readonly ipLimiter: Limiter;
  private readonly now: () => number;

  constructor(cfg: ClaimsConfig, provider: VerificationProvider, opts: { store?: ClaimsStore; now?: () => number } = {}) {
    this.cfg = cfg;
    this.provider = provider;
    this.store = opts.store ?? new ClaimsStore(cfg.dbPath);
    this.now = opts.now ?? Date.now;
    this.vault = new PhoneVault(cfg.phoneEncKey);
    this.ipLimiter = new Limiter(cfg.perIpPerMinute);
    this.approver = privateKeyToAccount(cfg.approverPrivateKey);
    const chain = defineChain({
      id: cfg.expectedChainId,
      name: `monad-${cfg.expectedChainId}`,
      nativeCurrency: { name: "MON", symbol: "MON", decimals: 18 },
      rpcUrls: { default: { http: [cfg.rpcUrl] } },
    });
    this.client = createPublicClient({ chain, transport: http(cfg.rpcUrl, { timeout: 10_000, retryCount: 2 }) }) as PublicClient;
  }

  /** Refuse to run against the wrong chain/contract, or with a key that is not the escrow's approver. */
  async start(): Promise<void> {
    const chainId = await this.client.getChainId();
    if (chainId !== this.cfg.expectedChainId) throw new Error(`startup: RPC chainId ${chainId} != expected ${this.cfg.expectedChainId}`);
    const code = await this.client.getCode({ address: this.cfg.escrow });
    if (!code || code === "0x") throw new Error("startup: no code at ESCROW_ADDRESS");
    const [current, owner] = await Promise.all([
      this.client.readContract({ address: this.cfg.escrow, abi: everpieceEscrowAbi, functionName: "claimApprover" }),
      this.client.readContract({ address: this.cfg.escrow, abi: everpieceEscrowAbi, functionName: "owner" }),
    ]);
    if (getAddress(owner) === this.approver.address) throw new Error("startup: approver key must not be the escrow owner (spec §2)");
    if (getAddress(current) !== this.approver.address && !this.cfg.allowRetiredApprover) {
      throw new Error(`startup: key ${this.approver.address} is not escrow.claimApprover() (${current})`);
    }
    if (!this.provider.live) log("warn", "claims.sms_provider_simulated", { provider: this.provider.name });
    log("info", "claims.startup", { chainId, escrow: this.cfg.escrow, approver: this.approver.address, sms: this.provider.name });
  }

  private nowSec(): bigint {
    return BigInt(Math.floor(this.now() / 1000));
  }

  private async payment(paymentId: Hex): Promise<Payment> {
    return (await this.client.readContract({
      address: this.cfg.escrow,
      abi: everpieceEscrowAbi,
      functionName: "getPayment",
      args: [paymentId],
    })) as unknown as Payment;
  }

  /** The payment must be an ACTIVE, unexpired LINK payment guarded by THIS approver. */
  private claimable(p: Payment): string | null {
    if (p.status !== PaymentStatus.ACTIVE) return "PaymentNotActive";
    if (p.mode !== PaymentMode.LINK) return "NotALinkPayment";
    if (getAddress(p.approver) !== this.approver.address) return "NotThisApprover";
    if (this.nowSec() >= p.expiresAt) return "PaymentExpired";
    return null;
  }

  private deadlineOk(deadline: bigint): boolean {
    const n = this.nowSec();
    return deadline >= n && deadline <= n + BigInt(this.cfg.requestDeadlineMaxSec);
  }

  private guard(ip: string): Result | null {
    return this.ipLimiter.allow(ip, this.now()) ? null : err(429, "RateLimited");
  }

  // -----------------------------------------------------------------------------------------------
  // 1. Sender registers the recipient's phone for a LINK payment (signed InviteRegistration)
  // -----------------------------------------------------------------------------------------------
  async registerInvite(body: unknown, ip: string): Promise<Result> {
    const limited = this.guard(ip);
    if (limited) return limited;
    let paymentId: Hex, phone: string, deadline: bigint, senderSig: Hex;
    try {
      const o = fields(body, ["paymentId", "phone", "deadline", "senderSig"]);
      paymentId = hex(o.paymentId, 32, "paymentId");
      if (typeof o.phone !== "string" || !E164.test(o.phone)) throw new Bad("phone: E.164 required");
      phone = o.phone;
      deadline = secs(o.deadline, "deadline");
      senderSig = hex(o.senderSig, 65, "senderSig");
    } catch (e) {
      return err(400, "InvalidRequest", { detail: (e as Error).message });
    }
    if (!this.deadlineOk(deadline)) return err(400, "BadDeadline");
    const p = await this.payment(paymentId);
    const why = this.claimable(p);
    if (why) return err(422, why);
    const typed = inviteRegistration(this.cfg.escrow, { paymentId, phoneHash: phoneHash(phone), deadline }, this.cfg.expectedChainId);
    if (!(await signedBy(p.sender, { ...typed, signature: senderSig }))) return err(401, "InvalidSenderSignature");

    const key = this.vault.lookupKey(phone);
    const existing = this.store.getInvite(paymentId);
    if (existing) {
      // Immutable once set: a mistaken phone is fixed by cancelling the payment, not by rewriting the invite.
      return existing.phone_key === key ? { httpStatus: 200, body: { paymentId, maskedPhone: existing.phone_mask, idempotent: true } } : err(409, "InviteAlreadyRegistered");
    }
    this.store.insertInvite({ payment_id: paymentId, phone_enc: this.vault.encrypt(phone), phone_mask: maskPhone(phone), phone_key: key, sender: p.sender, created_at: this.now() });
    log("info", "claims.invite_registered", { paymentId });
    return { httpStatus: 201, body: { paymentId, maskedPhone: maskPhone(phone) } };
  }

  // -----------------------------------------------------------------------------------------------
  // 2. Link holder asks for a code (proves Capability A first, so no one else can trigger SMS)
  // -----------------------------------------------------------------------------------------------
  async startVerification(body: unknown, ip: string): Promise<Result> {
    const limited = this.guard(ip);
    if (limited) return limited;
    let paymentId: Hex, recipient: Address, claimKey: Address, recipientSalt: Hex, deadline: bigint, claimKeySig: Hex;
    try {
      const o = fields(body, ["paymentId", "recipient", "claimKey", "recipientSalt", "deadline", "claimKeySig"]);
      paymentId = hex(o.paymentId, 32, "paymentId");
      recipient = addr(o.recipient, "recipient");
      claimKey = addr(o.claimKey, "claimKey");
      recipientSalt = hex(o.recipientSalt, 32, "recipientSalt");
      deadline = secs(o.deadline, "deadline");
      claimKeySig = hex(o.claimKeySig, 65, "claimKeySig");
    } catch (e) {
      return err(400, "InvalidRequest", { detail: (e as Error).message });
    }
    if (!this.deadlineOk(deadline)) return err(400, "BadDeadline");
    if (recipient === getAddress(this.cfg.escrow)) return err(400, "InvalidRecipient");
    const p = await this.payment(paymentId);
    const why = this.claimable(p);
    if (why) return err(422, why);
    if (claimKey === this.approver.address) return err(403, "InvalidClaimKey");
    if (recipientCommitment(PaymentMode.LINK, claimKey, recipientSalt) !== p.recipientCommitment.toLowerCase()) {
      return err(403, "LinkRevealMismatch");
    }
    const typed = claimStart(this.cfg.escrow, { paymentId, recipient, deadline }, this.cfg.expectedChainId);
    if (!(await signedBy(claimKey, { ...typed, signature: claimKeySig }))) return err(401, "InvalidClaimKeySignature");

    const invite = this.store.getInvite(paymentId);
    if (!invite) return err(409, "InviteNotRegistered");

    // Progressive cooldown per payment (never a permanent lock — master §13.1) + per-phone daily cap (SMS pumping).
    const now = this.now();
    const recent = this.store.sendsForPaymentSince(paymentId, now - 86_400_000);
    if (recent.length > 0) {
      const c = this.cfg.resendCooldownsSec;
      const wait = c[Math.min(recent.length - 1, c.length - 1)] * 1000;
      const readyAt = recent[recent.length - 1] + wait;
      if (now < readyAt) return err(429, "Cooldown", { retryAfterSeconds: Math.ceil((readyAt - now) / 1000) });
    }
    if (this.store.sendsForPhoneSince(invite.phone_key, now - 86_400_000) >= this.cfg.perPhonePerDay) {
      return err(429, "PhoneDailyLimit", { retryAfterSeconds: 3600 });
    }

    const phone = this.vault.decrypt(invite.phone_enc);
    let ref: string;
    try {
      ({ ref } = await this.provider.start(phone));
    } catch (e) {
      log("error", "claims.provider_start_failed", { paymentId, provider: this.provider.name, err: e instanceof ProviderError ? e.message : "unknown" });
      return err(503, "VerificationUnavailable");
    }
    this.store.recordSend(paymentId, invite.phone_key, now);
    this.store.openSession(paymentId, recipient, ref, now);
    const c = this.cfg.resendCooldownsSec;
    log("info", "claims.code_sent", { paymentId, provider: this.provider.name });
    return {
      httpStatus: 200,
      body: {
        paymentId,
        maskedPhone: invite.phone_mask,
        resendAfterSeconds: c[Math.min(recent.length, c.length - 1)],
        simulated: !this.provider.live,
      },
    };
  }

  // -----------------------------------------------------------------------------------------------
  // 3. Recipient submits the code → short-lived ClaimApproval for THAT wallet
  // -----------------------------------------------------------------------------------------------
  async verifyCode(body: unknown, ip: string): Promise<Result> {
    const limited = this.guard(ip);
    if (limited) return limited;
    let paymentId: Hex, recipient: Address, code: string;
    try {
      const o = fields(body, ["paymentId", "recipient", "code"]);
      paymentId = hex(o.paymentId, 32, "paymentId");
      recipient = addr(o.recipient, "recipient");
      if (typeof o.code !== "string" || !/^[0-9]{4,10}$/.test(o.code)) throw new Bad("code: 4-10 digits");
      code = o.code;
    } catch (e) {
      return err(400, "InvalidRequest", { detail: (e as Error).message });
    }
    const s = this.store.latestOpenSession(paymentId);
    if (!s) return err(409, "NoActiveVerification");
    if (s.recipient !== recipient) return err(403, "RecipientMismatch"); // approval is only ever for the wallet that started
    const now = this.now();
    if (now - s.created_at > this.cfg.sessionTtlSec * 1000) {
      this.store.setSessionStatus(s.id, "CLOSED");
      return err(410, "VerificationExpired");
    }
    if (s.attempts >= this.cfg.maxVerifyAttempts) {
      this.store.setSessionStatus(s.id, "CLOSED");
      return err(429, "TooManyAttempts"); // request a new code after the cooldown; the payment is never locked
    }
    const p = await this.payment(paymentId);
    const why = this.claimable(p);
    if (why) return err(422, why);
    const invite = this.store.getInvite(paymentId);
    if (!invite) return err(409, "InviteNotRegistered");

    let result;
    try {
      result = await this.provider.check(this.vault.decrypt(invite.phone_enc), code, s.provider_ref);
    } catch (e) {
      log("error", "claims.provider_check_failed", { paymentId, provider: this.provider.name, err: e instanceof ProviderError ? e.message : "unknown" });
      return err(503, "VerificationUnavailable");
    }
    if (result === "dead") {
      this.store.setSessionStatus(s.id, "CLOSED");
      return err(410, "VerificationExpired");
    }
    if (result === "wrong") {
      const used = this.store.bumpAttempts(s.id);
      return err(400, "InvalidCode", { attemptsLeft: Math.max(0, this.cfg.maxVerifyAttempts - used) });
    }

    this.store.setSessionStatus(s.id, "APPROVED");
    const approvalNonce = toHex(randomBytes(32));
    let approvalDeadline = this.nowSec() + BigInt(this.cfg.approvalTtlSec);
    if (approvalDeadline >= p.expiresAt) approvalDeadline = p.expiresAt - 1n;
    const approverSig = await this.approver.signTypedData(
      claimApproval(this.cfg.escrow, { paymentId, recipient, approvalNonce, deadline: approvalDeadline }, this.cfg.expectedChainId),
    );
    this.store.recordApproval(paymentId, recipient, approvalNonce, Number(approvalDeadline), now);
    log("info", "claims.approval_issued", { paymentId, recipient, approvalDeadline });
    return {
      httpStatus: 200,
      body: { paymentId, recipient, approver: this.approver.address, approvalNonce, approvalDeadline: approvalDeadline.toString(), approverSig },
    };
  }

  health(): Record<string, unknown> {
    return { ok: true, approver: this.approver.address, escrow: this.cfg.escrow, sms: this.provider.name, smsLive: this.provider.live };
  }
}

async function signedBy(expected: Address, typed: Parameters<typeof recoverTypedDataAddress>[0]): Promise<boolean> {
  try {
    return getAddress(await recoverTypedDataAddress(typed)) === getAddress(expected);
  } catch {
    return false;
  }
}
