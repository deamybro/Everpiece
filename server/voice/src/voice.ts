import { timingSafeEqual } from "node:crypto";
import { MAX_ENVELOPE_BYTES, MessageError, parseEnvelopeHeader } from "@everpiece/shared";
import type { VoiceConfig } from "./config.ts";
import { VoiceStore } from "./store.ts";
import { log } from "./log.ts";

export type Result = { httpStatus: number; body?: Record<string, unknown>; bytes?: Uint8Array };
const err = (httpStatus: number, error: string): Result => ({ httpStatus, body: { error } });

/** 32-byte hex locator: HKDF of the link's voice secret (packages/shared voice.ts). Knowing it is the capability to read. */
export const LOCATOR = /^0x[0-9a-f]{64}$/;

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
 * version, audio type, duration, size). Whether a message belongs to a payment is checked by the recipient against
 * the on-chain metadataCommitment, so this service can't attach a message to anyone's payment.
 * If it is down, payments still work: messages are optional (master §24.8).
 */
export class VoiceService {
  readonly cfg: VoiceConfig;
  readonly store: VoiceStore;
  private readonly now: () => number;
  private readonly limiter: Limiter;
  private readonly uploadsByIpDay = new Map<string, number>();

  constructor(cfg: VoiceConfig, deps: { store?: VoiceStore; now?: () => number } = {}) {
    this.cfg = cfg;
    this.store = deps.store ?? new VoiceStore(cfg.dbPath);
    this.now = deps.now ?? Date.now;
    this.limiter = new Limiter(cfg.perIpPerMinute);
  }

  /** Lifecycle deletion; run at start and hourly. */
  sweep(): number {
    const removed = this.store.deleteOlderThan(this.now() - this.cfg.retentionDays * 86_400_000);
    if (removed) log("info", "messages.expired", { removed });
    return removed;
  }

  health(): Record<string, unknown> {
    return { ok: true, messages: this.store.count(), bytes: this.store.totalBytes() };
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
    this.store.insert({ locator, envelope, size: envelope.length, created_at: now });
    this.uploadsByIpDay.set(day, (this.uploadsByIpDay.get(day) ?? 0) + 1);
    log("info", "message.stored", { size: envelope.length }); // never the locator
    return { httpStatus: 201, body: { ok: true } };
  }

  get(locator: string, ip: string): Result {
    if (!LOCATOR.test(locator)) return err(400, "BadLocator");
    if (!this.limiter.allow(ip, this.now())) return err(429, "RateLimited");
    const m = this.store.get(locator);
    return m ? { httpStatus: 200, bytes: new Uint8Array(m.envelope) } : err(404, "NotFound");
  }
}

export const MAX_UPLOAD_BYTES = MAX_ENVELOPE_BYTES;
