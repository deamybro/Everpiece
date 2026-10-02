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
  messageKeyRegistration,
  recipientCommitment,
  usernameProblem,
  usernameRegistration,
  usernameSkeleton,
} from "@everpiece/shared";
import type { DirectoryConfig } from "./config.ts";
import { DirectoryStore, type MessageKey, type User } from "./store.ts";
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
const str = (v: unknown, n: string, max: number): string => {
  if (typeof v !== "string" || v.length > max) throw new Bad(`${n}: string ≤ ${max}`);
  return v;
};

export type OnchainPayment = { status: number; mode: number; recipientCommitment: Hex };
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
  private readonly readPayment: PaymentReader;
  private readonly ipLimiter: Limiter;
  private readonly now: () => number;

  constructor(cfg: DirectoryConfig, opts: { store?: DirectoryStore; now?: () => number; readPayment?: PaymentReader } = {}) {
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
  private guard(ip: string): Result | null {
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
    const typed = usernameRegistration(this.cfg.escrow, { username, account, displayName, inboxKeyHash, deadline }, this.cfg.expectedChainId);
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
    const typed = messageKeyRegistration(this.cfg.escrow, { account, messageKey, deadline }, this.cfg.expectedChainId);
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

async function signedBy(expected: Address, typed: Parameters<typeof recoverTypedDataAddress>[0]): Promise<boolean> {
  try {
    return getAddress(await recoverTypedDataAddress(typed)) === getAddress(expected);
  } catch {
    return false;
  }
}
