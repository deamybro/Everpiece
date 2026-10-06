import { randomBytes, randomUUID } from "node:crypto";
import { getAddress, isAddress, isHex, recoverTypedDataAddress, type Address, type Hex } from "viem";
import {
  NUBAN, PAYOUT_REQUEST_VERSION, bankAccountHash, fromBaseUnits, isFinalPayout, nextPayoutState, payoutAccountHashOf, payoutAccountProblem,
  payoutAccountTyped, payoutRequestProblem, payoutRequestTyped, payoutStateOf, stableNeededFor, toBaseUnits,
  type PayoutAccount, type PayoutRequest,
} from "@everpiece/shared";
import type { PayoutConfig } from "./config.ts";
import { Paycrest, ProviderError, type Institution } from "./paycrest.ts";
import { PayoutStore, type OrderRow } from "./store.ts";
import { BankVault, newSalt } from "./vault.ts";
import { log } from "./log.ts";

export type Result = { httpStatus: number; body: Record<string, unknown> };
const err = (httpStatus: number, error: string, detail?: string): Result => ({ httpStatus, body: detail ? { error, detail } : { error } });
const wire = (v: unknown) => JSON.parse(JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x)));
const STABLE_DECIMALS = 6;
const PREPARE_TTL_MS = 15 * 60_000;
const STATUS_POLL_MS = 4_000;

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

function parseAccountRecord(o: unknown): PayoutAccount {
  const r = o as Record<string, unknown>;
  if (!r || typeof r !== "object" || typeof r.account !== "string" || !isAddress(r.account)) throw new Error("account");
  if (typeof r.deadline !== "string" && typeof r.deadline !== "number") throw new Error("deadline");
  return {
    account: getAddress(r.account), currency: r.currency as "NGN", institution: String(r.institution), accountHash: String(r.accountHash) as Hex,
    accountName: String(r.accountName), last4: String(r.last4), deadline: BigInt(r.deadline),
  };
}
function parseRequestRecord(o: unknown): PayoutRequest {
  const r = o as Record<string, unknown>;
  if (!r || typeof r !== "object" || typeof r.recipient !== "string" || !isAddress(r.recipient)) throw new Error("recipient");
  if (typeof r.requestId !== "string" || !isHex(r.requestId)) throw new Error("requestId");
  return {
    version: Number(r.version), requestId: r.requestId.toLowerCase() as Hex, recipient: getAddress(r.recipient), currency: r.currency as "NGN",
    fiatAmount: BigInt(String(r.fiatAmount)), payoutAccountHash: String(r.payoutAccountHash) as Hex, expiresAt: BigInt(String(r.expiresAt)),
  };
}

/**
 * docs/PAYOUT.md. Never holds money. Holds bank numbers encrypted (P4). Every destination is signed by the
 * recipient; every request binds that exact signed destination; "Delivered" only on the provider's confirmation.
 */
export class PayoutService {
  readonly cfg: PayoutConfig;
  readonly store: PayoutStore;
  private readonly provider: Paycrest;
  private readonly vault: BankVault;
  private readonly limiter: Limiter;
  private readonly readLimiter: Limiter;
  /** Each order is a real provider order on mainnet: a tight per-IP budget of its own (audit 2026-10-06). */
  private readonly orderLimiter: Limiter;
  private readonly now: () => number;
  private institutionsCache: { at: number; list: Institution[] } | null = null;

  constructor(cfg: PayoutConfig, opts: { fetch?: typeof fetch; now?: () => number; store?: PayoutStore } = {}) {
    this.cfg = cfg;
    this.store = opts.store ?? new PayoutStore(cfg.dbPath);
    this.provider = new Paycrest(cfg.paycrestUrl, cfg.paycrestApiKey, cfg.paycrestApiSecret, opts.fetch);
    this.vault = new BankVault(cfg.bankEncKey);
    this.limiter = new Limiter(cfg.perIpPerMinute);
    this.readLimiter = new Limiter(cfg.readsPerIpPerMinute);
    this.orderLimiter = new Limiter(cfg.ordersPerIpPerMinute);
    this.now = opts.now ?? Date.now;
  }

  /** Writes (anything that creates or changes data) and reads (status polling) have separate per-IP budgets. */
  limited(ip: string, read = false): Result | null {
    return (read ? this.readLimiter : this.limiter).allow(ip, this.now()) ? null : err(429, "RateLimited");
  }
  private fail(e: unknown): Result {
    if (e instanceof ProviderError) return err(e.httpStatus, e.code);
    log("error", "payout.unexpected", { err: String(e).slice(0, 200) });
    return err(500, "InternalError");
  }
  health() {
    return { ok: true, simulated: this.cfg.simulated, network: this.cfg.sourceNetwork, currency: this.cfg.sourceCurrency, ...(this.store.counts() as object) };
  }

  async institutions(currency: string): Promise<Result> {
    if (currency !== "NGN") return err(422, "UNSUPPORTED_CURRENCY");
    try {
      if (!this.institutionsCache || this.now() - this.institutionsCache.at > 3_600_000) {
        this.institutionsCache = { at: this.now(), list: (await this.provider.institutions("NGN")).filter((i) => i.type === "bank") };
      }
      return { httpStatus: 200, body: { institutions: this.institutionsCache.list, simulated: this.cfg.simulated } };
    } catch (e) {
      return this.fail(e);
    }
  }
  private async institutionName(code: string): Promise<string | null> {
    const r = await this.institutions("NGN");
    return r.httpStatus === 200 ? ((r.body.institutions as Institution[]).find((i) => i.code === code)?.name ?? null) : null;
  }

  /** Step 1 (recipient): verify the account with the provider; returns the record for the owner to sign. */
  async prepareAccount(body: unknown, ip: string): Promise<Result> {
    const o = (body ?? {}) as Record<string, unknown>;
    if (typeof o.account !== "string" || !isAddress(o.account) || typeof o.institution !== "string" || typeof o.accountNumber !== "string") return err(400, "InvalidRequest");
    if (!NUBAN.test(o.accountNumber)) return err(422, "INVALID_ACCOUNT_NUMBER");
    const institutionName = await this.institutionName(o.institution);
    if (!institutionName) return err(422, "UNKNOWN_BANK");
    const now = this.now();
    if (this.store.verificationsSince(ip, now - 86_400_000) >= this.cfg.verificationsPerIpPerDay) return err(429, "TooManyVerifications");
    this.store.recordVerification(ip, now);
    let name: string | null;
    try {
      name = await this.provider.verifyAccount(o.institution, o.accountNumber);
    } catch (e) {
      return e instanceof ProviderError && e.code === "PROVIDER_REFUSED" ? err(422, "ACCOUNT_NOT_FOUND") : this.fail(e);
    }
    // P4: Everpiece verifies the account before saving; a bank that can't confirm the name isn't accepted in V1.
    if (!name) return err(422, "ACCOUNT_NAME_UNAVAILABLE");
    const salt = newSalt();
    const prepareId = randomUUID();
    const record: PayoutAccount = {
      account: getAddress(o.account), currency: "NGN", institution: o.institution, accountHash: bankAccountHash(salt, o.institution, o.accountNumber),
      accountName: name, last4: o.accountNumber.slice(-4), deadline: BigInt(Math.floor((now + PREPARE_TTL_MS) / 1000)),
    };
    this.store.putPending({
      prepare_id: prepareId, account: record.account.toLowerCase(), institution: o.institution, enc_number: this.vault.encrypt(o.accountNumber), salt,
      account_name: name, last4: record.last4, expires_at: now + PREPARE_TTL_MS,
    });
    log("info", "payout.account_prepared", { institution: o.institution });
    return { httpStatus: 200, body: { prepareId, record: wire(record), institutionName } };
  }

  /** Step 2 (recipient): the owner's signature makes it their payout destination. */
  async saveAccount(body: unknown): Promise<Result> {
    const o = (body ?? {}) as Record<string, unknown>;
    if (typeof o.prepareId !== "string" || typeof o.sig !== "string" || !isHex(o.sig)) return err(400, "InvalidRequest");
    let record: PayoutAccount;
    try {
      record = parseAccountRecord(o.record);
    } catch {
      return err(400, "InvalidRequest");
    }
    const now = this.now();
    const p = this.store.takePending(o.prepareId, now);
    if (!p) return err(404, "PREPARE_EXPIRED");
    const same = p.account === record.account.toLowerCase() && p.institution === record.institution && p.account_name === record.accountName &&
      p.last4 === record.last4 && bankAccountHash(p.salt as Hex, p.institution, this.vault.decrypt(p.enc_number)) === record.accountHash;
    if (!same) return err(422, "RECORD_MISMATCH");
    const problem = payoutAccountProblem(record, BigInt(Math.floor(now / 1000)));
    if (problem) return err(422, problem);
    const signer = await recoverTypedDataAddress({ ...payoutAccountTyped(this.cfg.domainAddress, record, this.cfg.expectedChainId), signature: o.sig as Hex }).catch(() => null);
    if (!signer || getAddress(signer) !== record.account) return err(401, "InvalidSignature");
    this.store.putAccount({ account: record.account.toLowerCase(), record: JSON.stringify(wire(record)), sig: o.sig, enc_number: p.enc_number, salt: p.salt, updated_at: now });
    log("info", "payout.account_saved", { institution: record.institution });
    return { httpStatus: 201, body: { record: wire(record), sig: o.sig } };
  }

  async account(address: string): Promise<Result> {
    if (!isAddress(address)) return err(400, "InvalidRequest");
    const a = this.store.account(address);
    if (!a) return err(404, "NO_PAYOUT_ACCOUNT");
    const record = JSON.parse(a.record);
    return { httpStatus: 200, body: { record, sig: a.sig, institutionName: await this.institutionName(record.institution) } };
  }

  /** The recipient's signed "pay me at least ₦X to my signed bank destination". */
  async createRequest(body: unknown): Promise<Result> {
    const o = (body ?? {}) as Record<string, unknown>;
    if (typeof o.sig !== "string" || !isHex(o.sig)) return err(400, "InvalidRequest");
    let r: PayoutRequest;
    try {
      r = parseRequestRecord(o.request);
    } catch {
      return err(400, "InvalidRequest");
    }
    const problem = payoutRequestProblem(r, BigInt(Math.floor(this.now() / 1000)));
    if (problem) return err(422, problem);
    if (r.expiresAt > BigInt(Math.floor(this.now() / 1000)) + 30n * 86_400n) return err(422, "EXPIRY_TOO_FAR");
    const signer = await recoverTypedDataAddress({ ...payoutRequestTyped(this.cfg.domainAddress, r, this.cfg.expectedChainId), signature: o.sig as Hex }).catch(() => null);
    if (!signer || getAddress(signer) !== r.recipient) return err(401, "InvalidSignature");
    const a = this.store.account(r.recipient);
    if (!a) return err(404, "NO_PAYOUT_ACCOUNT");
    if (payoutAccountHashOf(this.cfg.domainAddress, parseAccountRecord(JSON.parse(a.record)), this.cfg.expectedChainId) !== r.payoutAccountHash) return err(422, "ACCOUNT_CHANGED");
    const existing = this.store.request(r.requestId);
    if (existing) return existing.sig === o.sig ? { httpStatus: 200, body: { request: wire(r), idempotent: true } } : err(409, "RequestExists");
    this.store.putRequest({ request_id: r.requestId, recipient: r.recipient.toLowerCase(), record: JSON.stringify(wire(r)), sig: o.sig, created_at: this.now() });
    log("info", "payout.request_created", { fiatAmount: r.fiatAmount.toString() });
    return { httpStatus: 201, body: { request: wire(r) } };
  }

  /** Everything a sender needs to check before paying: the signed request, the signed destination, the latest order. */
  async getRequest(id: string): Promise<Result> {
    const r = /^0x[0-9a-fA-F]{64}$/.test(id) ? this.store.request(id) : undefined;
    if (!r) return err(404, "UNKNOWN_REQUEST");
    const account = await this.account(r.recipient);
    const latest = this.store.ordersFor(r.request_id)[0];
    const order = latest ? await this.refreshed(latest) : null;
    return {
      httpStatus: 200,
      body: { request: JSON.parse(r.record), sig: r.sig, account: account.httpStatus === 200 ? account.body : null, order: order && this.publicOrder(order), simulated: this.cfg.simulated },
    };
  }

  /** Live price: stablecoin the provider must receive so the bank gets at least ₦X (P2). */
  async quote(body: unknown): Promise<Result> {
    const o = (body ?? {}) as Record<string, unknown>;
    const r = typeof o.requestId === "string" && /^0x[0-9a-fA-F]{64}$/.test(o.requestId) ? this.store.request(o.requestId) : undefined;
    if (!r) return err(404, "UNKNOWN_REQUEST");
    const req = parseRequestRecord(JSON.parse(r.record));
    try {
      const approx = (Number(req.fiatAmount) / 100 / 1000).toFixed(0); // rate lookups take a rough stablecoin amount
      const rate = await this.provider.sellRate(this.cfg.sourceNetwork, this.cfg.sourceCurrency, approx === "0" ? "1" : approx, req.currency);
      const stable = stableNeededFor(req.fiatAmount, rate, this.cfg.rateBufferBps);
      return { httpStatus: 200, body: { rate, stableAmount: stable.toString(), currency: this.cfg.sourceCurrency, bufferBps: this.cfg.rateBufferBps, simulated: this.cfg.simulated } };
    } catch (e) {
      return this.fail(e);
    }
  }

  /** "≈ $X" while someone types a naira amount (no request yet). Same maths as a real quote. */
  async rate(koboText: string | null): Promise<Result> {
    if (!koboText || !/^[1-9][0-9]{0,15}$/.test(koboText)) return err(400, "InvalidRequest");
    const kobo = BigInt(koboText);
    try {
      const approx = (Number(kobo) / 100 / 1000).toFixed(0);
      const rate = await this.provider.sellRate(this.cfg.sourceNetwork, this.cfg.sourceCurrency, approx === "0" ? "1" : approx, "NGN");
      return { httpStatus: 200, body: { rate, stableAmount: stableNeededFor(kobo, rate, this.cfg.rateBufferBps).toString(), bufferBps: this.cfg.rateBufferBps } };
    } catch (e) {
      return this.fail(e);
    }
  }

  /**
   * "Send to their bank" / "cash out to my bank": the SENDER picks the amount; the destination is still only one the
   * recipient signed (their PayoutAccount). Recorded as a direct request bound to that signed destination.
   */
  private async directRequest(o: Record<string, unknown>): Promise<Result | { row: NonNullable<ReturnType<PayoutStore["request"]>> }> {
    if (typeof o.recipient !== "string" || !isAddress(o.recipient) || typeof o.fiatAmount !== "string" || !/^[1-9][0-9]{0,15}$/.test(o.fiatAmount)) return err(400, "InvalidRequest");
    const a = this.store.account(o.recipient);
    if (!a) return err(404, "NO_PAYOUT_ACCOUNT");
    const nowSec = BigInt(Math.floor(this.now() / 1000));
    const req: PayoutRequest = {
      version: PAYOUT_REQUEST_VERSION, requestId: `0x${randomBytes(32).toString("hex")}`, recipient: getAddress(o.recipient), currency: "NGN",
      fiatAmount: BigInt(o.fiatAmount), payoutAccountHash: payoutAccountHashOf(this.cfg.domainAddress, parseAccountRecord(JSON.parse(a.record)), this.cfg.expectedChainId),
      expiresAt: nowSec + 3600n,
    };
    const problem = payoutRequestProblem(req, nowSec);
    if (problem) return err(422, problem);
    const row = { request_id: req.requestId, recipient: req.recipient.toLowerCase(), record: JSON.stringify(wire(req)), sig: "", created_at: this.now(), direct: 1 };
    this.store.putRequest(row);
    return { row };
  }

  /** The provider order the sender will pay. One live order per request; refunds go to the sender's own address (P3). */
  async createOrder(body: unknown, ip = "unknown"): Promise<Result> {
    if (!this.orderLimiter.allow(ip, this.now())) return err(429, "RateLimited");
    const o = (body ?? {}) as Record<string, unknown>;
    if (typeof o.sender !== "string" || !isAddress(o.sender)) return err(400, "InvalidRequest");
    let r = typeof o.requestId === "string" && /^0x[0-9a-fA-F]{64}$/.test(o.requestId) ? this.store.request(o.requestId) : undefined;
    if (!r && o.requestId === undefined) {
      const d = await this.directRequest(o);
      if ("httpStatus" in d) return d;
      r = d.row;
    }
    if (!r) return err(404, "UNKNOWN_REQUEST");
    const req = parseRequestRecord(JSON.parse(r.record));
    const now = this.now();
    if (payoutRequestProblem(req, BigInt(Math.floor(now / 1000)))) return err(422, payoutRequestProblem(req, BigInt(Math.floor(now / 1000)))!);
    const orders = await Promise.all(this.store.ordersFor(r.request_id).map((x) => this.refreshed(x)));
    if (orders.some((x) => x.state === "DELIVERED" || x.state === "BANK_PROCESSING" || x.state === "PAYOUT_FUNDED")) return err(409, "REQUEST_ALREADY_PAID");
    const sender = o.sender.toLowerCase();
    const live = orders.find((x) => x.state === "AWAITING_PAYMENT" && Date.parse(x.valid_until) > now + 60_000 && x.sender === sender);
    if (live) return { httpStatus: 200, body: { order: this.publicOrder(live) } };
    const a = this.store.account(req.recipient);
    if (!a) return err(404, "NO_PAYOUT_ACCOUNT");
    const record = parseAccountRecord(JSON.parse(a.record));
    if (payoutAccountHashOf(this.cfg.domainAddress, record, this.cfg.expectedChainId) !== req.payoutAccountHash) return err(422, "ACCOUNT_CHANGED");
    const accountNumber = this.vault.decrypt(a.enc_number);
    // defense in depth: the number we're about to send must be the one the recipient signed
    if (bankAccountHash(a.salt as Hex, record.institution, accountNumber) !== record.accountHash) {
      log("alert", "payout.destination_mismatch", {});
      return err(500, "DESTINATION_MISMATCH");
    }
    try {
      const q = await this.quote({ requestId: req.requestId });
      if (q.httpStatus !== 200) return q;
      const stable = BigInt(String(q.body.stableAmount));
      const po = await this.provider.createOrder({
        amount: fromBaseUnits(stable, STABLE_DECIMALS, 0), currency: this.cfg.sourceCurrency, network: this.cfg.sourceNetwork,
        refundAddress: getAddress(o.sender), institution: record.institution, accountIdentifier: accountNumber, accountName: record.accountName,
        memo: "Everpiece", reference: req.requestId,
      });
      const row: OrderRow = {
        order_id: po.id, request_id: r.request_id, sender: o.sender.toLowerCase(), receive_address: po.receiveAddress, amount_to_transfer: po.amountToTransfer,
        currency: po.currency, valid_until: po.validUntil, state: payoutStateOf(po.status) ?? "AWAITING_PAYMENT", created_at: now, updated_at: now, checked_at: now,
        history: JSON.stringify([{ state: payoutStateOf(po.status) ?? "AWAITING_PAYMENT", at: now }]),
      };
      this.store.putOrder(row);
      log("info", "payout.order_created", { order: po.id, amount: po.amountToTransfer, currency: po.currency });
      return { httpStatus: 201, body: { order: this.publicOrder(row), rate: q.body.rate } };
    } catch (e) {
      return this.fail(e);
    }
  }

  async order(id: string): Promise<Result> {
    const o = /^[A-Za-z0-9-]{8,80}$/.test(id) ? this.store.order(id) : undefined;
    if (!o) return err(404, "UNKNOWN_ORDER");
    return { httpStatus: 200, body: { order: this.publicOrder(await this.refreshed(o)) } };
  }

  /** Provider webhooks: authenticated, then confirmed with the provider itself (the body is only a nudge). */
  async webhook(raw: Uint8Array, signature: string | undefined): Promise<Result> {
    if (!this.provider.verifyWebhook(raw, signature)) {
      log("warn", "payout.webhook_bad_signature", {});
      return err(401, "InvalidSignature");
    }
    let id: unknown;
    try {
      id = (JSON.parse(Buffer.from(raw).toString("utf8")) as { data?: { id?: unknown } }).data?.id;
    } catch {
      return err(400, "MalformedJson");
    }
    const o = typeof id === "string" ? this.store.order(id) : undefined;
    if (!o) return { httpStatus: 200, body: { ok: true, ignored: true } };
    await this.refreshed({ ...o, checked_at: 0 });
    return { httpStatus: 200, body: { ok: true } };
  }

  private async refreshed(o: OrderRow): Promise<OrderRow> {
    const now = this.now();
    if (isFinalPayout(o.state) || now - o.checked_at < STATUS_POLL_MS) return o;
    try {
      const incoming = payoutStateOf(await this.provider.orderStatus(o.order_id));
      if (!incoming) {
        this.store.touch(o.order_id, now);
        return o;
      }
      const next = nextPayoutState(o.state, incoming);
      if (next !== o.state) log("info", "payout.state", { order: o.order_id, from: o.state, to: next });
      this.store.setState(o.order_id, next, now);
      return { ...o, state: next, checked_at: now };
    } catch {
      return o;
    }
  }

  private publicOrder(o: OrderRow) {
    const units = toBaseUnits(roundUp6(o.amount_to_transfer), STABLE_DECIMALS);
    const fresh = this.store.order(o.order_id) ?? o;
    const req = this.store.request(o.request_id);
    const r = req ? (JSON.parse(req.record) as { recipient: string; fiatAmount: string }) : null;
    return {
      orderId: o.order_id, requestId: o.request_id, state: o.state, receiveAddress: o.receive_address, amountToTransfer: o.amount_to_transfer,
      amountToTransferUnits: units?.toString() ?? null, currency: o.currency, validUntil: o.valid_until, simulated: this.cfg.simulated,
      recipient: r?.recipient ?? null, fiatAmount: r?.fiatAmount ?? null, history: JSON.parse(fresh.history ?? "[]") as { state: string; at: number }[],
    };
  }
}

/** The provider may quote more than 6 decimals; paying is rounded UP to the token's 6 (never short). */
function roundUp6(v: string): string {
  const [i, f = ""] = v.split(".");
  if (f.length <= 6) return v;
  const units = BigInt(i) * 1_000_000n + BigInt(f.slice(0, 6)) + (/[1-9]/.test(f.slice(6)) ? 1n : 0n);
  return `${units / 1_000_000n}.${(units % 1_000_000n).toString().padStart(6, "0")}`;
}

