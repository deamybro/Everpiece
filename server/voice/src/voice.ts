import { timingSafeEqual } from "node:crypto";
import { createPublicClient, defineChain, http, keccak256, type Hex, type PublicClient } from "viem";
import { MAX_ENVELOPE_BYTES, MessageError, PaymentStatus, everpieceEscrowAbi, metadataCommitment, parseEnvelopeHeader } from "@everpiece/shared";
import type { VoiceConfig } from "./config.ts";
import { VoiceStore } from "./store.ts";
import { log } from "./log.ts";

export type Result = { httpStatus: number; body?: Record<string, unknown>; bytes?: Uint8Array };
const err = (httpStatus: number, error: string): Result => ({ httpStatus, body: { error } });

/** 32-byte hex locator: HKDF of the message secret (packages/shared voice.ts). Knowing it is the capability to read. */
export const LOCATOR = /^0x[0-9a-f]{64}$/;
const HEX32 = /^0x[0-9a-fA-F]{64}$/;

export type OnchainPayment = { status: number; metadataCommitment: Hex; expiresAt: bigint };
export type PaymentReader = (paymentId: Hex) => Promise<OnchainPayment>;

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
 * Stores and serves end-to-end encrypted message envelopes. It checks only what it can see without a key (format
 * version, audio type, duration, size). Uploads that no payment claims are deleted after `unboundHours`: a client
 * binds a message by showing the store the payment and the commitment salt, and the store checks the payment's
 * on-chain metadataCommitment itself (read at "finalized"). So the store only keeps messages that real payments
 * carry, for as long as those payments can still be claimed (plus `keepAfterExpiryDays`).
 * Whether a message belongs to a payment is still checked by the RECIPIENT too; this service is never trusted for it.
 * If it is down, payments still work: messages are optional (master §24.8).
 */
export class VoiceService {
  readonly cfg: VoiceConfig;
  readonly store: VoiceStore;
  readonly client: PublicClient;
  private readonly readPayment: PaymentReader;
  private readonly now: () => number;
  private readonly limiter: Limiter;
  private readonly uploadsByIpDay = new Map<string, number>();

  constructor(cfg: VoiceConfig, deps: { store?: VoiceStore; now?: () => number; readPayment?: PaymentReader } = {}) {
    this.cfg = cfg;
    this.store = deps.store ?? new VoiceStore(cfg.dbPath);
    this.now = deps.now ?? Date.now;
    this.limiter = new Limiter(cfg.perIpPerMinute);
    const chain = defineChain({
      id: cfg.expectedChainId,
      name: `monad-${cfg.expectedChainId}`,
      nativeCurrency: { name: "MON", symbol: "MON", decimals: 18 },
      rpcUrls: { default: { http: [cfg.rpcUrl] } },
    });
    this.client = createPublicClient({ chain, transport: http(cfg.rpcUrl, { timeout: 10_000, retryCount: 2 }) }) as PublicClient;
    this.readPayment =
      deps.readPayment ??
      (async (paymentId) =>
        (await this.client.readContract({
          address: cfg.escrow,
          abi: everpieceEscrowAbi,
          functionName: "getPayment",
          args: [paymentId],
          blockTag: "finalized", // inclusion ≠ success (VERIFIED §1.14)
        })) as unknown as OnchainPayment);
  }

  async start(): Promise<void> {
    const chainId = await this.client.getChainId();
    if (chainId !== this.cfg.expectedChainId) throw new Error(`startup: RPC chainId ${chainId} != expected ${this.cfg.expectedChainId}`);
    const code = await this.client.getCode({ address: this.cfg.escrow });
    if (!code || code === "0x") throw new Error("startup: no code at ESCROW_ADDRESS");
    log("info", "voice.startup", { chainId, escrow: this.cfg.escrow });
  }

  /** Lifecycle deletion; run at start and hourly. */
  sweep(): number {
    const removed = this.store.deleteExpired(this.now());
    if (removed) log("info", "messages.expired", { removed });
    return removed;
  }

  health(): Record<string, unknown> {
    return { ok: true, ...this.store.counts(), bytes: this.store.totalBytes() };
  }

  put(locator: string, envelope: Uint8Array, ip: string): Result {
    const now = this.now();
    if (!LOCATOR.test(locator)) return err(400, "BadLocator");
    if (!this.limiter.allow(ip, now)) return err(429, "RateLimited");
    try {
      parseEnvelopeHeader(envelope);
    } catch (e) {
      return err(e instanceof MessageError && e.code === "MessageTooLarge" ? 413 : 400, e instanceof MessageError ? e.code : "MessageMalformed");
    }
    const existing = this.store.get(locator);
    if (existing) {
      // Idempotent retries succeed; a different message can never replace the first (first write wins).
      const same = existing.size === envelope.length && timingSafeEqual(Buffer.from(existing.envelope), Buffer.from(envelope));
      return same ? { httpStatus: 200, body: { ok: true } } : err(409, "MessageExists");
    }
    const day = `${ip}:${new Date(now).toISOString().slice(0, 10)}`;
    if ((this.uploadsByIpDay.get(day) ?? 0) >= this.cfg.uploadsPerIpPerDay) return err(429, "DailyLimit");
    if (this.store.totalBytes() + envelope.length > this.cfg.maxTotalBytes) {
      log("alert", "storage.full", { bytes: this.store.totalBytes() });
      return err(507, "StorageFull");
    }
    this.store.insert({ locator, envelope, size: envelope.length, created_at: now, payment_id: null, delete_after: now + this.cfg.unboundHours * 3_600_000 });
    this.uploadsByIpDay.set(day, (this.uploadsByIpDay.get(day) ?? 0) + 1);
    log("info", "message.stored", { size: envelope.length }); // never the locator
    return { httpStatus: 201, body: { ok: true } };
  }

  /**
   * "This message belongs to that payment": the client reveals the paymentId and the commitment salt (HKDF'd from
   * the message secret; it can't decrypt anything). The store recomputes the commitment from the bytes it holds and
   * compares it with the payment's on-chain metadataCommitment at "finalized". Idempotent; sender and recipient
   * both call it, so one lost request can't get a message deleted.
   */
  async bind(locator: string, body: unknown, ip: string): Promise<Result> {
    if (!LOCATOR.test(locator)) return err(400, "BadLocator");
    if (!this.limiter.allow(ip, this.now())) return err(429, "RateLimited");
    const o = body as Record<string, unknown>;
    if (typeof o !== "object" || o === null || Object.keys(o).sort().join() !== "metadataSalt,paymentId") return err(400, "InvalidRequest");
    if (typeof o.paymentId !== "string" || !HEX32.test(o.paymentId) || typeof o.metadataSalt !== "string" || !HEX32.test(o.metadataSalt)) return err(400, "InvalidRequest");
    const paymentId = o.paymentId.toLowerCase() as Hex;
    const m = this.store.get(locator);
    if (!m) return err(404, "NotFound");
    if (m.payment_id) return m.payment_id === paymentId ? { httpStatus: 200, body: { ok: true, idempotent: true } } : err(409, "BoundToAnotherPayment");
    let p: OnchainPayment;
    try {
      p = await this.readPayment(paymentId);
    } catch (e) {
      log("warn", "bind.rpc_error", { err: String(e).slice(0, 200) });
      return err(503, "ChainUnavailable");
    }
    if (Number(p.status) === PaymentStatus.NONE) return err(422, "PaymentNotFinalized"); // client retries shortly
    const expected = metadataCommitment(keccak256(new Uint8Array(m.envelope)), o.metadataSalt as Hex);
    if (expected.toLowerCase() !== p.metadataCommitment.toLowerCase()) return err(422, "NotThisPaymentsMessage");
    const deleteAfter = Number(p.expiresAt) * 1000 + this.cfg.keepAfterExpiryDays * 86_400_000;
    this.store.bind(locator, paymentId, Math.max(deleteAfter, m.delete_after));
    log("info", "message.bound", {}); // never the locator or the payment: the store keeps that link to itself
    return { httpStatus: 200, body: { ok: true } };
  }

  get(locator: string, ip: string): Result {
    if (!LOCATOR.test(locator)) return err(400, "BadLocator");
    if (!this.limiter.allow(ip, this.now())) return err(429, "RateLimited");
    const m = this.store.get(locator);
    return m ? { httpStatus: 200, bytes: new Uint8Array(m.envelope) } : err(404, "NotFound");
  }
}

export const MAX_UPLOAD_BYTES = MAX_ENVELOPE_BYTES;
