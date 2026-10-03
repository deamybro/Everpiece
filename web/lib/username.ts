import { getAddress, recoverTypedDataAddress, type Address, type Hex } from "viem";
import { inboxKeyHash, messageKeyRegistration, messagePublicKey, normalizeUsername, usernameRegistration } from "@everpiece/shared";
import { config } from "./config";
import { directory } from "./api";
import { saveAccount, withSigner, type Account } from "./mera";

export class UsernameError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(code);
    this.code = code;
  }
}

/** messageKey: set only when the account itself signed it (else the recipient just can't get messages). */
export type Recipient = { username: string; account: Address; displayName: string; messageKey?: Hex };
/** "new": never paid before (show context, ask to confirm); "pinned": matches what we paid last time. */
export type Pinning = "new" | "pinned";

type SignedMessageKey = { messageKey: Hex; deadline: string; sig: Hex };
type DirectoryRecord = { username: string; account: string; displayName: string; inboxKeyHash: Hex; deadline: string; sig: Hex; messageKey?: SignedMessageKey | null };

/** The account's message key, only if the account signed it: the directory can't make senders encrypt to its own key. */
async function verifiedMessageKey(account: Address, k: SignedMessageKey | null | undefined): Promise<Hex | undefined> {
  if (!k) return undefined;
  try {
    const typed = messageKeyRegistration(config.directoryDomain, { account, messageKey: k.messageKey, deadline: BigInt(k.deadline) }, config.chainId);
    return getAddress(await recoverTypedDataAddress({ ...typed, signature: k.sig })) === account ? k.messageKey : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Never trust the directory's word alone: the account itself must have signed "I am @username" (the directory
 * cannot attribute a name to an account that did not sign for it).
 */
async function verified(r: DirectoryRecord): Promise<Recipient> {
  try {
    const account = getAddress(r.account);
    const typed = usernameRegistration(
      config.directoryDomain,
      { username: r.username, account, displayName: r.displayName, inboxKeyHash: r.inboxKeyHash, deadline: BigInt(r.deadline) },
      config.chainId,
    );
    if (getAddress(await recoverTypedDataAddress({ ...typed, signature: r.sig })) !== account) throw new Error();
    return { username: r.username, account, displayName: r.displayName, messageKey: await verifiedMessageKey(account, r.messageKey) };
  } catch {
    throw new UsernameError("RecipientUnverified");
  }
}

// ── TOFU pinning (master §10.2–10.3) ────────────────────────────────────────────────────────────────────────────
const PINS_KEY = "everpiece.pins.v1";
function pins(): Record<string, Address> {
  try {
    return JSON.parse(localStorage.getItem(PINS_KEY) ?? "{}") as Record<string, Address>;
  } catch {
    return {};
  }
}
/** Called only after a payment to `r` is CONFIRMED ("after first successful interaction"). */
export function pin(r: Recipient): void {
  localStorage.setItem(PINS_KEY, JSON.stringify({ ...pins(), [r.username]: r.account }));
}

/** Look up @username for sending. Throws RecipientChanged if it no longer matches the pinned account. */
export async function findRecipient(input: string): Promise<{ recipient: Recipient; pinning: Pinning }> {
  const username = normalizeUsername(input);
  if (!username) throw new UsernameError("InvalidUsername");
  const r = await directory("/v1/usernames/lookup", { username }).catch(() => null);
  if (!r) throw new UsernameError("DirectoryUnavailable");
  if (r.status !== 200) throw new UsernameError(r.body.error ?? "DirectoryUnavailable");
  const recipient = await verified(r.body as DirectoryRecord);
  if (recipient.username !== username) throw new UsernameError("RecipientUnverified");
  const pinned = pins()[username];
  if (pinned && getAddress(pinned) !== recipient.account) throw new UsernameError("RecipientChanged");
  return { recipient, pinning: pinned ? "pinned" : "new" };
}

// ── Own username ────────────────────────────────────────────────────────────────────────────────────────────────
/** Fills in `account.username` from the directory (e.g. after signing in on a new device). */
export async function syncUsername(account: Account): Promise<Account> {
  if (account.username) return account;
  const r = await directory("/v1/usernames/by-account", { account: account.address }).catch(() => null);
  if (!r || r.status !== 200) return account;
  const me = await verified(r.body as DirectoryRecord).catch(() => null);
  if (!me || me.account !== account.address) return account;
  return saveAccount({ ...account, username: me.username, name: account.name || me.displayName });
}

/** null = available; otherwise the reason code (UsernameTaken, UsernameTooSimilar, UsernameReserved, …). */
export async function checkAvailable(username: string): Promise<string | null> {
  const r = await directory("/v1/usernames/available", { username }).catch(() => null);
  if (!r || r.status !== 200) throw new UsernameError("DirectoryUnavailable");
  return r.body.available === true ? null : String(r.body.reason ?? "UsernameTaken");
}

/** One fingerprint prompt: signs "I am @username" and binds this passkey's inbox key. */
export async function registerUsername(account: Account, username: string, displayName: string): Promise<Account> {
  // The directory accepts deadlines at most 10 minutes ahead (REQUEST_DEADLINE_MAX_SEC = 600).
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 540);
  // The same prompt also signs "this is my message key", so @username payments can carry messages from day one.
  const { sig, inboxKey, messageSeed, keyReg } = await withSigner(account, async (signer, inboxKey, messageSeed) => ({
    inboxKey,
    messageSeed,
    sig: await signer.signTypedData(
      usernameRegistration(config.directoryDomain, { username, account: account.address, displayName, inboxKeyHash: inboxKeyHash(inboxKey), deadline }, config.chainId),
    ),
    keyReg: await signMessageKey(signer, account.address, messageSeed, deadline),
  }));
  const r = await directory("/v1/usernames/register", {
    username, account: account.address, displayName, inboxKeyHash: inboxKeyHash(inboxKey), deadline: deadline.toString(), sig,
  }).catch(() => null);
  if (!r) throw new UsernameError("DirectoryUnavailable");
  if (r.status !== 201 && r.status !== 200) throw new UsernameError(r.body.error);
  // Messages are optional: if publishing the key fails, Home offers "Turn on messages" later.
  const published = await publishMessageKey(keyReg);
  return saveAccount({ ...account, username, inboxKey, messageSeed, messageKeyPublished: published });
}

// ── Message key (EVERPIECE_MESSAGE_KEY_V1) ──────────────────────────────────────────────────────────────────────
type KeyRegistration = { account: Address; messageKey: Hex; deadline: string; sig: Hex };

async function signMessageKey(signer: { signTypedData: (t: ReturnType<typeof messageKeyRegistration>) => Promise<Hex> }, account: Address, seed: Hex, deadline: bigint): Promise<KeyRegistration> {
  const messageKey = await messagePublicKey(seed);
  const sig = await signer.signTypedData(messageKeyRegistration(config.directoryDomain, { account, messageKey, deadline }, config.chainId));
  return { account, messageKey, deadline: deadline.toString(), sig };
}

async function publishMessageKey(k: KeyRegistration): Promise<boolean> {
  const r = await directory("/v1/message-keys/register", k).catch(() => null);
  return !!r && (r.status === 201 || r.status === 200);
}

/** Existing accounts: one fingerprint prompt publishes the message key so others can send them voice messages. */
export async function enableMessages(account: Account): Promise<Account> {
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 540);
  const { keyReg, messageSeed } = await withSigner(account, async (signer, _inboxKey, messageSeed) => ({
    messageSeed,
    keyReg: await signMessageKey(signer, account.address, messageSeed, deadline),
  }));
  if (!(await publishMessageKey(keyReg))) throw new UsernameError("DirectoryUnavailable");
  return saveAccount({ ...account, messageSeed, messageKeyPublished: true });
}

/** Does the directory hold this account's own (signed) message key? Checked once per page load. */
export async function messageKeyPublished(account: Account): Promise<boolean> {
  const r = await directory("/v1/usernames/by-account", { account: account.address }).catch(() => null);
  if (!r || r.status !== 200) return Boolean(account.messageKeyPublished);
  // Immutable per account and derived from the passkey, so a verified key is necessarily this passkey's key.
  const published = !!(await verifiedMessageKey(account.address, (r.body as DirectoryRecord).messageKey));
  if (published !== Boolean(account.messageKeyPublished)) saveAccount({ ...account, messageKeyPublished: published });
  return published;
}

// ── Inbox ───────────────────────────────────────────────────────────────────────────────────────────────────────
/** messageWrap: the message secret sealed to this account's message key, when the sender attached a message. */
export type InboxItem = { paymentId: Hex; recipientSalt: Hex; messageWrap?: Hex };

export async function readInbox(account: Account): Promise<InboxItem[]> {
  if (!account.inboxKey || !account.username) return [];
  const r = await directory("/v1/inbox/list", { account: account.address, inboxKey: account.inboxKey }).catch(() => null);
  if (!r || r.status !== 200) return [];
  return (r.body.items as InboxItem[]) ?? [];
}

/** Sender's name for context on an incoming payment ("from @stella"). Verified, or null. */
export async function usernameOf(address: Address): Promise<string | null> {
  const r = await directory("/v1/usernames/by-account", { account: address }).catch(() => null);
  if (!r || r.status !== 200) return null;
  const who = await verified(r.body as DirectoryRecord).catch(() => null);
  return who && who.account === getAddress(address) ? who.username : null;
}
