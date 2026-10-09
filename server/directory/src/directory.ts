import { timingSafeEqual } from "node:crypto";
import {
  createPublicClient,
  defineChain,
  getAddress,
  http,
  isAddress,
  keccak256,
  recoverTypedDataAddress,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import {
  PaymentMode,
  PaymentStatus,
  cleanDisplayName,
  MESSAGE_WRAP_BYTES,
  everpieceEscrowAbi,
  everpiecePayAbi,
  everpiecePayV2Abi,
  paymentV2Id,
  instantPaymentId,
  paymentIdOf,
  paymentRequestTyped,
  requestProblem,
  RequestMode,
  messageKeyRegistration,
  recipientCommitment,
  usernameProblem,
  usernameRegistration,
  usernameSkeleton,
} from "@everpiece/shared";
import type { DirectoryConfig } from "./config.ts";
import { DirectoryStore, type MessageKey, type RequestRow, type User } from "./store.ts";
import { log } from "./log.ts";

export type Result = { httpStatus: number; body: Record<string, unknown> };
const err = (httpStatus: number, error: string, extra: Record<string, unknown> = {}): Result => ({ httpStatus, body: { error, ...extra } });

class Bad extends Error {}

/** keccak256("Transfer(address,address,uint256)") */
const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
export type Delivery = { timestamp: number; transfers: { token: Address; to: Address; value: bigint }[] };
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
const str = (v: unknown, n: string, max: number): string => {
  if (typeof v !== "string" || v.length > max) throw new Bad(`${n}: string ≤ ${max}`);
  return v;
};

export type OnchainPayment = { status: number; mode: number; recipientCommitment: Hex };
export type PaymentReader = (paymentId: Hex) => Promise<OnchainPayment>;
/** EverpiecePay.settled(id) at "finalized". */
export type SettledReader = (paymentId: Hex) => Promise<boolean>;

const dec = (v: unknown, n: string): bigint => {
  if (typeof v !== "string" || !/^(0|[1-9][0-9]{0,77})$/.test(v)) throw new Bad(`${n}: decimal string`);
  return BigInt(v);
};
const publicRequest = (r: RequestRow, u: User | undefined) => ({
  request: { version: 1, requestId: r.request_id, recipient: r.recipient, asset: r.asset, amount: r.amount, mode: r.mode, expiresAt: r.expires_at, memoHash: r.memo_hash },
  sig: r.sig,
  // what the payer's app shows, still to be verified by it (the recipient's signed @username record)
  recipientRecord: u ? publicUser(u) : null,
  paid: r.paid_payment_id ? { paymentId: r.paid_payment_id, kind: r.paid_kind, at: r.paid_at } : null,
});

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

const publicMessageKey = (k: MessageKey | undefined) => (k ? { messageKey: k.message_key, deadline: k.deadline, sig: k.sig } : null);
const publicUser = (u: User, k?: MessageKey) => ({
  username: u.username,
  account: u.account,
  displayName: u.display_name,
  inboxKeyHash: u.inbox_key_hash,
  deadline: u.deadline,
  sig: u.sig,
  registeredAt: u.created_at,
  /** Clients verify this signature themselves before encrypting to the key (the directory could lie). */
  messageKey: publicMessageKey(k),
});

/**
 * Username directory + username-payment inbox (master §10, ESCROW_SPEC §3.1).
 *
 * Trust: the directory can lie about which account @name is (TOFU pinning in the client is the V1 mitigation), but it
 * cannot attribute a name to an account that did not sign for it, and it cannot move money: username claims need the
 * recipient's own signature on-chain. It holds no keys.
 *
 * Inbox: the recipient salt is not a secret against theft (master §3.1), but it links a payment to its recipient, so
 * inbox reads need the account's inbox key (EVERPIECE_INBOX_V1). Deliveries are self-authenticating: an entry is stored
 * only if (recipient, salt) opens the on-chain commitment of an ACTIVE USERNAME payment read at "finalized".
 */
export class DirectoryService {
  readonly cfg: DirectoryConfig;
  readonly store: DirectoryStore;
  readonly client: PublicClient;
  readonly readPayment: PaymentReader;
  readonly readSettled: SettledReader;
  /** EverpiecePayV2: the asset its finalized Paid event says was delivered, or null if not settled/finalized. */
  readonly readDeliveredV2: (paymentId: Hex) => Promise<Address | null>;
  /** A Monad transaction's finalized outcome: ERC-20 transfers it made (for cross-chain deliveries by Aurora). */
  readonly readDelivery: (txHash: Hex) => Promise<Delivery | null>;
  private readonly ipLimiter: Limiter;
  readonly now: () => number;

  constructor(cfg: DirectoryConfig, opts: { store?: DirectoryStore; now?: () => number; readPayment?: PaymentReader; readSettled?: SettledReader; readDeliveredV2?: (paymentId: Hex) => Promise<Address | null>; readDelivery?: (txHash: Hex) => Promise<Delivery | null> } = {}) {
    this.cfg = cfg;
    this.store = opts.store ?? new DirectoryStore(cfg.dbPath);
    this.now = opts.now ?? Date.now;
    this.ipLimiter = new Limiter(cfg.perIpPerMinute);
    const chain = defineChain({
      id: cfg.expectedChainId,
      name: `monad-${cfg.expectedChainId}`,
      nativeCurrency: { name: "MON", symbol: "MON", decimals: 18 },
      rpcUrls: { default: { http: [cfg.rpcUrl] } },
    });
    this.client = createPublicClient({ chain, transport: http(cfg.rpcUrl, { timeout: 10_000, retryCount: 2 }) }) as PublicClient;
    this.readPayment =
      opts.readPayment ??
      (async (paymentId) =>
        (await this.client.readContract({
          address: cfg.escrow,
          abi: everpieceEscrowAbi,
          functionName: "getPayment",
          args: [paymentId],
          blockTag: "finalized", // inclusion ≠ success (VERIFIED §1.14)
        })) as unknown as OnchainPayment);
    this.readSettled =
      opts.readSettled ??
      (async (paymentId) =>
        cfg.payAddress
          ? Boolean(await this.client.readContract({ address: cfg.payAddress, abi: everpiecePayAbi, functionName: "settled", args: [paymentId], blockTag: "finalized" }))
          : false);
    this.readDelivery =
      opts.readDelivery ??
      (async (txHash) => {
        const receipt = await this.client.getTransactionReceipt({ hash: txHash }).catch(() => null);
        if (!receipt || receipt.status !== "success") return null;
        const finalized = await this.client.getBlock({ blockTag: "finalized" });
        if (receipt.blockNumber > finalized.number) return null; // inclusion ≠ success (VERIFIED §1.14)
        const block = await this.client.getBlock({ blockNumber: receipt.blockNumber });
        const transfers = receipt.logs
          .filter((l) => l.topics[0] === TRANSFER_TOPIC && l.topics.length === 3)
          .map((l) => ({ token: getAddress(l.address), to: getAddress(`0x${l.topics[2]!.slice(26)}`), value: BigInt(l.data) }));
        return { timestamp: Number(block.timestamp), transfers };
      });
    this.readDeliveredV2 =
      opts.readDeliveredV2 ??
      (async (paymentId) => {
        if (!cfg.payV2Address) return null;
        const settled = await this.client.readContract({ address: cfg.payV2Address, abi: everpiecePayV2Abi, functionName: "settled", args: [paymentId], blockTag: "finalized" });
        if (!settled) return null;
        const logs = await this.client.getContractEvents({
          address: cfg.payV2Address, abi: everpiecePayV2Abi, eventName: "Paid", args: { paymentId }, fromBlock: "earliest", toBlock: "finalized",
        });
        const ev = logs[0] as unknown as { args: { deliveredAsset: Address } } | undefined;
        return ev ? getAddress(ev.args.deliveredAsset) : null;
      });
  }

  async start(): Promise<void> {
    const chainId = await this.client.getChainId();
    if (chainId !== this.cfg.expectedChainId) throw new Error(`startup: RPC chainId ${chainId} != expected ${this.cfg.expectedChainId}`);
    const code = await this.client.getCode({ address: this.cfg.escrow });
    if (!code || code === "0x") throw new Error("startup: no code at ESCROW_ADDRESS");
    log("info", "directory.startup", { chainId, escrow: this.cfg.escrow });
  }

  health(): Record<string, unknown> {
    return { ok: true, chainId: this.cfg.expectedChainId, escrow: this.cfg.escrow };
  }

  private nowSec(): bigint {
    return BigInt(Math.floor(this.now() / 1000));
  }
  private deadlineOk(deadline: bigint): boolean {
    const n = this.nowSec();
    return deadline >= n && deadline <= n + BigInt(this.cfg.requestDeadlineMaxSec);
  }
  guard(ip: string): Result | null {
    return this.ipLimiter.allow(ip, this.now()) ? null : err(429, "RateLimited");
  }

  /** @username → account, signed by the account. First come; one username per account; immutable in V1. */
  async register(body: unknown, ip: string): Promise<Result> {
    const limited = this.guard(ip);
    if (limited) return limited;
    let username: string, account: Address, displayName: string, inboxKeyHash: Hex, deadline: bigint, sig: Hex;
    try {
      const o = fields(body, ["username", "account", "displayName", "inboxKeyHash", "deadline", "sig"]);
      username = str(o.username, "username", 20);
      account = addr(o.account, "account");
      displayName = str(o.displayName, "displayName", 80);
      inboxKeyHash = hex(o.inboxKeyHash, 32, "inboxKeyHash");
      deadline = secs(o.deadline, "deadline");
      sig = hex(o.sig, 65, "sig");
    } catch (e) {
      return err(400, "InvalidRequest", { detail: (e as Error).message });
    }
    const problem = usernameProblem(username);
    if (problem === "Invalid") return err(400, "InvalidUsername");
    if (problem === "Reserved") return err(409, "UsernameReserved");
    // The signed string must already be the canonical form, so what senders see is exactly what was signed.
    if (cleanDisplayName(displayName) !== displayName) return err(400, "InvalidDisplayName");
    if (!this.deadlineOk(deadline)) return err(400, "BadDeadline");
    const typed = usernameRegistration(this.cfg.domainAddress, { username, account, displayName, inboxKeyHash, deadline }, this.cfg.expectedChainId);
    if (!(await signedBy(account, { ...typed, signature: sig }))) return err(401, "InvalidSignature");

    const byName = this.store.byUsername(username);
    if (byName) {
      const same = byName.account === account && byName.display_name === displayName && byName.inbox_key_hash === inboxKeyHash;
      return same ? { httpStatus: 200, body: { ...publicUser(byName), idempotent: true } } : err(409, "UsernameTaken");
    }
    if (this.store.byAccount(account)) return err(409, "AccountHasUsername");
    const skeleton = usernameSkeleton(username);
    if (this.store.bySkeleton(skeleton)) return err(409, "UsernameTooSimilar");
    const dayAgo = this.now() - 86_400_000;
    if (this.store.registrationsSince(ip, dayAgo) >= this.cfg.registrationsPerIpPerDay) return err(429, "TooManyRegistrations");

    const u: User = { username, skeleton, account, display_name: displayName, inbox_key_hash: inboxKeyHash, deadline: deadline.toString(), sig, created_at: this.now() };
    try {
      this.store.insertUser(u);
    } catch (e) {
      // Lost a race on a UNIQUE constraint (the database, not this check, is the final guarantee). Anything else is a real fault.
      if (!/UNIQUE constraint failed: users./.test(String((e as Error).message))) throw e;
      if (this.store.byUsername(username)) return err(409, "UsernameTaken");
      if (this.store.bySkeleton(skeleton)) return err(409, "UsernameTooSimilar");
      return err(409, "AccountHasUsername");
    }
    this.store.recordRegistration(ip, this.now());
    log("info", "directory.registered", { username, account });
    return { httpStatus: 201, body: publicUser(u) };
  }

  /**
   * The account publishes its message key (X25519, EVERPIECE_MESSAGE_KEY_V1) so senders can encrypt messages to it.
   * Signed by the account; one key per account, immutable (it is derived from the passkey, so it never changes).
   */
  async registerMessageKey(body: unknown, ip: string): Promise<Result> {
    const limited = this.guard(ip);
    if (limited) return limited;
    let account: Address, messageKey: Hex, deadline: bigint, sig: Hex;
    try {
      const o = fields(body, ["account", "messageKey", "deadline", "sig"]);
      account = addr(o.account, "account");
      messageKey = hex(o.messageKey, 32, "messageKey");
      deadline = secs(o.deadline, "deadline");
      sig = hex(o.sig, 65, "sig");
    } catch (e) {
      return err(400, "InvalidRequest", { detail: (e as Error).message });
    }
    if (!this.deadlineOk(deadline)) return err(400, "BadDeadline");
    const typed = messageKeyRegistration(this.cfg.domainAddress, { account, messageKey, deadline }, this.cfg.expectedChainId);
    if (!(await signedBy(account, { ...typed, signature: sig }))) return err(401, "InvalidSignature");
    if (!this.store.byAccount(account)) return err(404, "NoUsername");
    const existing = this.store.messageKeyOf(account);
    if (existing) return existing.message_key === messageKey ? { httpStatus: 200, body: { account, idempotent: true } } : err(409, "MessageKeyExists");
    try {
      this.store.insertMessageKey({ account, message_key: messageKey, deadline: deadline.toString(), sig, created_at: this.now() });
    } catch (e) {
      if (!/UNIQUE constraint failed: message_keys./.test(String((e as Error).message))) throw e;
      return err(409, "MessageKeyExists");
    }
    log("info", "directory.messageKey", { account });
    return { httpStatus: 201, body: { account } };
  }

  /** Can this name be registered right now? Same rules as register (exact, lookalike, reserved), no signature needed. */
  async available(body: unknown, ip: string): Promise<Result> {
    const limited = this.guard(ip);
    if (limited) return limited;
    let username: string;
    try {
      username = str(fields(body, ["username"]).username, "username", 20);
    } catch (e) {
      return err(400, "InvalidRequest", { detail: (e as Error).message });
    }
    const problem = usernameProblem(username);
    const reason =
      problem === "Invalid" ? "InvalidUsername"
      : problem === "Reserved" ? "UsernameReserved"
      : this.store.byUsername(username) ? "UsernameTaken"
      : this.store.bySkeleton(usernameSkeleton(username)) ? "UsernameTooSimilar"
      : null;
    return { httpStatus: 200, body: reason ? { available: false, reason } : { available: true } };
  }

  async lookup(body: unknown, ip: string): Promise<Result> {
    const limited = this.guard(ip);
    if (limited) return limited;
    let username: string;
    try {
      username = str(fields(body, ["username"]).username, "username", 40);
    } catch (e) {
      return err(400, "InvalidRequest", { detail: (e as Error).message });
    }
    const u = this.store.byUsername(username);
    return u ? { httpStatus: 200, body: publicUser(u, this.store.messageKeyOf(u.account)) } : err(404, "UnknownUsername");
  }

  async byAccount(body: unknown, ip: string): Promise<Result> {
    const limited = this.guard(ip);
    if (limited) return limited;
    let account: Address;
    try {
      account = addr(fields(body, ["account"]).account, "account");
    } catch (e) {
      return err(400, "InvalidRequest", { detail: (e as Error).message });
    }
    const u = this.store.byAccount(account);
    return u ? { httpStatus: 200, body: publicUser(u, this.store.messageKeyOf(u.account)) } : err(404, "NoUsername");
  }

  /** Sender's client hands over the recipient salt after the payment is CONFIRMED. Self-authenticating (see class doc). */
  async deliver(body: unknown, ip: string): Promise<Result> {
    const limited = this.guard(ip);
    if (limited) return limited;
    let paymentId: Hex, recipient: Address, recipientSalt: Hex, messageWrap: Hex | null;
    try {
      const withMessage = typeof body === "object" && body !== null && "messageWrap" in body;
      const o = fields(body, ["paymentId", "recipient", "recipientSalt", ...(withMessage ? ["messageWrap"] : [])]);
      paymentId = hex(o.paymentId, 32, "paymentId");
      recipient = addr(o.recipient, "recipient");
      recipientSalt = hex(o.recipientSalt, 32, "recipientSalt");
      // Opaque to the directory: only the recipient's message key opens it, and only for this payment.
      messageWrap = withMessage ? hex(o.messageWrap, MESSAGE_WRAP_BYTES, "messageWrap") : null;
    } catch (e) {
      return err(400, "InvalidRequest", { detail: (e as Error).message });
    }
    const existing = this.store.getInbox(paymentId);
    if (existing) {
      return existing.recipient === recipient && existing.recipient_salt === recipientSalt && (existing.message_wrap ?? null) === messageWrap
        ? { httpStatus: 200, body: { paymentId, idempotent: true } }
        : err(409, "AlreadyDelivered");
    }
    const p = await this.readPayment(paymentId);
    if (p.status === PaymentStatus.NONE) return err(422, "PaymentNotFinalized"); // client retries shortly
    if (p.mode !== PaymentMode.USERNAME) return err(422, "NotAUsernamePayment");
    if (p.status !== PaymentStatus.ACTIVE) return err(422, "PaymentNotActive");
    if (recipientCommitment(PaymentMode.USERNAME, recipient, recipientSalt).toLowerCase() !== p.recipientCommitment.toLowerCase()) {
      return err(422, "RecipientMismatch");
    }
    this.store.insertInbox({ payment_id: paymentId, recipient, recipient_salt: recipientSalt, message_wrap: messageWrap, created_at: this.now() });
    log("info", "directory.delivered", { paymentId });
    return { httpStatus: 201, body: { paymentId } };
  }

  /** The account reads its own inbox with its inbox key (only the hash is stored). */
  async inbox(body: unknown, ip: string): Promise<Result> {
    const limited = this.guard(ip);
    if (limited) return limited;
    let account: Address, inboxKey: Hex;
    try {
      const o = fields(body, ["account", "inboxKey"]);
      account = addr(o.account, "account");
      inboxKey = hex(o.inboxKey, 32, "inboxKey");
    } catch (e) {
      return err(400, "InvalidRequest", { detail: (e as Error).message });
    }
    const u = this.store.byAccount(account);
    const given = Buffer.from(keccak256(inboxKey).slice(2), "hex");
    const stored = Buffer.from((u?.inbox_key_hash ?? "0x" + "00".repeat(32)).slice(2), "hex");
    if (!u || !timingSafeEqual(given, stored)) return err(401, "Unauthorized");
    const items = this.store.inboxFor(account, this.cfg.inboxPageSize).map((i) => ({
      paymentId: i.payment_id, recipientSalt: i.recipient_salt, deliveredAt: i.created_at, ...(i.message_wrap ? { messageWrap: i.message_wrap } : {}),
    }));
    return { httpStatus: 200, body: { items } };
  }
}

export const REQUESTS_PER_RECIPIENT_PER_DAY = 100;

// ── Payment requests (owner mandate §8–10) ─────────────────────────────────────────────────────────────────────
// Methods are attached to the prototype below to keep the class body above readable.
export interface DirectoryService {
  createRequest(body: unknown, ip: string): Promise<Result>;
  getRequest(body: unknown, ip: string): Promise<Result>;
  requestPaid(body: unknown, ip: string): Promise<Result>;
  myRequests(body: unknown, ip: string): Promise<Result>;
}

const REQUEST_KEYS = ["version", "requestId", "recipient", "asset", "amount", "mode", "expiresAt", "memoHash"] as const;

/** The recipient signs every security-critical field; the directory stores it only if that signature is the recipient's. */
DirectoryService.prototype.createRequest = async function (this: DirectoryService, body: unknown, ip: string): Promise<Result> {
  const limited = (this as unknown as { guard(ip: string): Result | null }).guard(ip);
  if (limited) return limited;
  let r: { version: number; requestId: Hex; recipient: Address; asset: Address; amount: bigint; mode: 1 | 2; expiresAt: bigint; memoHash: Hex }, sig: Hex;
  try {
    const o = fields(body, ["request", "sig"]);
    const q = fields(o.request, REQUEST_KEYS);
    if (q.version !== 1) throw new Bad("version");
    if (q.mode !== RequestMode.INSTANT && q.mode !== RequestMode.PROTECTED) throw new Bad("mode");
    r = { version: 1, requestId: hex(q.requestId, 32, "requestId"), recipient: addr(q.recipient, "recipient"), asset: addr(q.asset, "asset"),
      amount: dec(q.amount, "amount"), mode: q.mode as 1 | 2, expiresAt: secs(q.expiresAt, "expiresAt"), memoHash: hex(q.memoHash, 32, "memoHash") };
    sig = hex(o.sig, 65, "sig");
  } catch (e) {
    return err(400, "InvalidRequest", { detail: (e as Error).message });
  }
  const nowSec = BigInt(Math.floor(this.now() / 1000));
  const problem = requestProblem(r, nowSec, this.cfg.expectedChainId);
  if (problem) return err(422, problem);
  if (r.expiresAt > nowSec + 30n * 86_400n) return err(422, "EXPIRY_TOO_FAR");
  if (!(await signedBy(r.recipient, { ...paymentRequestTyped(this.cfg.domainAddress, r, this.cfg.expectedChainId), signature: sig }))) return err(401, "InvalidSignature");
  const u = this.store.byAccount(r.recipient);
  if (!u) return err(404, "NoUsername"); // requests are "Pay @name": the payer must be able to see who it is
  const existing = this.store.getRequest(r.requestId);
  if (existing) return existing.sig === sig ? { httpStatus: 200, body: { ...publicRequest(existing, u), idempotent: true } } : err(409, "RequestExists");
  if (this.store.requestsFor(r.recipient, REQUESTS_PER_RECIPIENT_PER_DAY).filter((x) => x.created_at > this.now() - 86_400_000).length >= REQUESTS_PER_RECIPIENT_PER_DAY) return err(429, "TooManyRequests");
  const row: RequestRow = { request_id: r.requestId, recipient: r.recipient, asset: r.asset, amount: r.amount.toString(), mode: r.mode,
    expires_at: r.expiresAt.toString(), memo_hash: r.memoHash, sig, created_at: this.now(), paid_payment_id: null, paid_kind: null, paid_at: null };
  this.store.insertRequest(row);
  log("info", "request.created", { mode: r.mode });
  return { httpStatus: 201, body: publicRequest(row, u) };
};

DirectoryService.prototype.getRequest = async function (this: DirectoryService, body: unknown, ip: string): Promise<Result> {
  const limited = (this as unknown as { guard(ip: string): Result | null }).guard(ip);
  if (limited) return limited;
  let id: Hex;
  try {
    id = hex(fields(body, ["requestId"]).requestId, 32, "requestId");
  } catch (e) {
    return err(400, "InvalidRequest", { detail: (e as Error).message });
  }
  const r = this.store.getRequest(id);
  return r ? { httpStatus: 200, body: publicRequest(r, this.store.byAccount(r.recipient)) } : err(404, "UnknownRequest");
};

DirectoryService.prototype.myRequests = async function (this: DirectoryService, body: unknown, ip: string): Promise<Result> {
  const limited = (this as unknown as { guard(ip: string): Result | null }).guard(ip);
  if (limited) return limited;
  let account: Address;
  try {
    account = addr(fields(body, ["account"]).account, "account");
  } catch (e) {
    return err(400, "InvalidRequest", { detail: (e as Error).message });
  }
  const u = this.store.byAccount(account);
  return { httpStatus: 200, body: { items: this.store.requestsFor(account, 50).map((r) => publicRequest(r, u)) } };
};

/**
 * "This request is paid": accepted only with a self-authenticating proof. The payer sends the payment's own terms;
 * the directory recomputes its id and checks the chain at "finalized":
 *   instant   — EverpiecePay Payment with ref = requestId, recipient and amount = the request's; settled(id) = true
 *   instantV2 — EverpiecePayV2 Payment with ref = requestId, recipient, amount and asset = the request's; settled at
 *               finality. If the on-chain Paid event shows another asset was delivered (truthful fallback), the
 *               request is recorded as "instantV2Fallback" — never as paid in the requested asset.
 *   crossChain — an external wallet paid from another chain through Aurora Intents: the finalized Monad delivery
 *               transaction moved at least the request's amount of USDC to the requester, after the request was made,
 *               and was not used for another request. A USDC request is "crossChain"; an AUSD request delivered as
 *               USDC is "crossChainUsdc" (AUSD isn't available cross-chain; the requester converts on-chain).
 *   protected — escrow PaymentIntent with salt = requestId, USERNAME mode, amount = the request's, the recipient
 *               commitment opening to the request's recipient; getPayment(id) exists
 */
DirectoryService.prototype.requestPaid = async function (this: DirectoryService, body: unknown, ip: string): Promise<Result> {
  const limited = (this as unknown as { guard(ip: string): Result | null }).guard(ip);
  if (limited) return limited;
  let o: Record<string, unknown>;
  let requestId: Hex;
  try {
    const kind = (body as { kind?: unknown })?.kind;
    o = fields(body, kind === "protected" ? ["requestId", "kind", "intent", "recipientSalt"] : kind === "crossChain" ? ["requestId", "kind", "txHash"] : ["requestId", "kind", "payment"]);
    if (kind === "instantV2Fallback") throw new Bad("kind");
    requestId = hex(o.requestId, 32, "requestId");
  } catch (e) {
    return err(400, "InvalidRequest", { detail: (e as Error).message });
  }
  const r = this.store.getRequest(requestId);
  if (!r) return err(404, "UnknownRequest");
  if (r.paid_payment_id) return { httpStatus: 200, body: { ...publicRequest(r, this.store.byAccount(r.recipient)), idempotent: true } };
  let paymentId: Hex;
  try {
    if (o.kind === "instant") {
      if (r.mode !== RequestMode.INSTANT || !this.cfg.payAddress) return err(422, "WrongKind");
      const p = fields(o.payment, ["ref", "sender", "recipient", "amount", "sourceToken", "maxSourceAmount", "deadline"]);
      const payment = { ref: hex(p.ref, 32, "ref"), sender: addr(p.sender, "sender"), recipient: addr(p.recipient, "recipient"), amount: dec(p.amount, "amount"),
        sourceToken: addr(p.sourceToken, "sourceToken"), maxSourceAmount: dec(p.maxSourceAmount, "maxSourceAmount"), deadline: dec(p.deadline, "deadline") };
      if (payment.ref !== requestId || payment.recipient !== getAddress(r.recipient) || payment.amount !== BigInt(r.amount)) return err(422, "NotThisRequest");
      paymentId = instantPaymentId(this.cfg.payAddress, payment, this.cfg.expectedChainId);
      if (!(await this.readSettled(paymentId))) return err(422, "PaymentNotFinalized");
    } else if (o.kind === "instantV2") {
      if (r.mode !== RequestMode.INSTANT || !this.cfg.payV2Address) return err(422, "WrongKind");
      const p = fields(o.payment, ["ref", "sender", "recipient", "asset", "amount", "sourceToken", "maxSourceAmount", "deadline", "fallbackToSource"]);
      if (typeof p.fallbackToSource !== "boolean") throw new Bad("fallbackToSource");
      const payment = { ref: hex(p.ref, 32, "ref"), sender: addr(p.sender, "sender"), recipient: addr(p.recipient, "recipient"), asset: addr(p.asset, "asset"),
        amount: dec(p.amount, "amount"), sourceToken: addr(p.sourceToken, "sourceToken"), maxSourceAmount: dec(p.maxSourceAmount, "maxSourceAmount"),
        deadline: dec(p.deadline, "deadline"), fallbackToSource: p.fallbackToSource };
      if (payment.ref !== requestId || payment.recipient !== getAddress(r.recipient) || payment.amount !== BigInt(r.amount) || payment.asset !== getAddress(r.asset)) {
        return err(422, "NotThisRequest");
      }
      paymentId = paymentV2Id(this.cfg.payV2Address, payment, this.cfg.expectedChainId);
      const delivered = await this.readDeliveredV2(paymentId);
      if (!delivered) return err(422, "PaymentNotFinalized");
      if (delivered !== payment.asset) o.kind = "instantV2Fallback";
    } else if (o.kind === "crossChain") {
      if (r.mode !== RequestMode.INSTANT || !this.cfg.usdcAddress) return err(422, "WrongKind");
      const txHash = hex(o.txHash, 32, "txHash");
      if (this.store.paidBy(txHash)) return err(422, "DeliveryAlreadyUsed");
      const d = await this.readDelivery(txHash);
      if (!d) return err(422, "PaymentNotFinalized");
      if (d.timestamp * 1000 < r.created_at) return err(422, "NotThisRequest"); // a delivery older than the request
      const paid = d.transfers.some((t) => t.token === this.cfg.usdcAddress && t.to === getAddress(r.recipient) && t.value >= BigInt(r.amount));
      if (!paid) return err(422, "NotThisRequest");
      paymentId = txHash;
      o.kind = getAddress(r.asset) === this.cfg.usdcAddress ? "crossChain" : "crossChainUsdc";
    } else if (o.kind === "protected") {
      if (r.mode !== RequestMode.PROTECTED) return err(422, "WrongKind");
      const i = fields(o.intent, ["sender", "mode", "recipientCommitment", "metadataCommitment", "approver", "amount", "expiresAt", "validAfter", "validBefore", "salt"]);
      const intent = { sender: addr(i.sender, "sender"), mode: Number(i.mode), recipientCommitment: hex(i.recipientCommitment, 32, "rc"), metadataCommitment: hex(i.metadataCommitment, 32, "mc"),
        approver: addr(i.approver, "approver"), amount: dec(i.amount, "amount"), expiresAt: dec(i.expiresAt, "expiresAt"), validAfter: dec(i.validAfter, "validAfter"),
        validBefore: dec(i.validBefore, "validBefore"), salt: hex(i.salt, 32, "salt") };
      const salt = hex(o.recipientSalt, 32, "recipientSalt");
      if (intent.salt !== requestId || intent.mode !== PaymentMode.USERNAME || intent.amount !== BigInt(r.amount)) return err(422, "NotThisRequest");
      if (recipientCommitment(PaymentMode.USERNAME, getAddress(r.recipient), salt).toLowerCase() !== intent.recipientCommitment) return err(422, "NotThisRequest");
      paymentId = paymentIdOf(this.cfg.escrow, intent, this.cfg.expectedChainId);
      const onchain = await this.readPayment(paymentId);
      if (onchain.status === PaymentStatus.NONE) return err(422, "PaymentNotFinalized");
      if (onchain.recipientCommitment.toLowerCase() !== intent.recipientCommitment) return err(422, "NotThisRequest");
    } else return err(400, "InvalidRequest");
  } catch (e) {
    if (e instanceof Bad) return err(400, "InvalidRequest", { detail: e.message });
    log("warn", "request.paid_rpc_error", { err: String(e).slice(0, 200) });
    return err(503, "ChainUnavailable");
  }
  this.store.markRequestPaid(requestId, paymentId, String(o.kind), this.now());
  log("info", "request.paid", { kind: String(o.kind) });
  return { httpStatus: 200, body: publicRequest(this.store.getRequest(requestId)!, this.store.byAccount(r.recipient)) };
};

async function signedBy(expected: Address, typed: Parameters<typeof recoverTypedDataAddress>[0]): Promise<boolean> {
  try {
    return getAddress(await recoverTypedDataAddress(typed)) === getAddress(expected);
  } catch {
    return false;
  }
}
