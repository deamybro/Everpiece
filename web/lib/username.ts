import { getAddress, recoverTypedDataAddress, type Address, type Hex } from "viem";
import { inboxKeyHash, normalizeUsername, usernameRegistration } from "@everpiece/shared";
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

export type Recipient = { username: string; account: Address; displayName: string };
/** "new": never paid before (show context, ask to confirm); "pinned": matches what we paid last time. */
export type Pinning = "new" | "pinned";

type DirectoryRecord = { username: string; account: string; displayName: string; inboxKeyHash: Hex; deadline: string; sig: Hex };

/**
 * Never trust the directory's word alone: the account itself must have signed "I am @username" (the directory
 * cannot attribute a name to an account that did not sign for it).
 */
async function verified(r: DirectoryRecord): Promise<Recipient> {
  try {
    const account = getAddress(r.account);
    const typed = usernameRegistration(
      config.escrow,
      { username: r.username, account, displayName: r.displayName, inboxKeyHash: r.inboxKeyHash, deadline: BigInt(r.deadline) },
      config.chainId,
    );
    if (getAddress(await recoverTypedDataAddress({ ...typed, signature: r.sig })) !== account) throw new Error();
    return { username: r.username, account, displayName: r.displayName };
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
  const { sig, inboxKey } = await withSigner(account, async (signer, inboxKey) => ({
    inboxKey,
    sig: await signer.signTypedData(
      usernameRegistration(config.escrow, { username, account: account.address, displayName, inboxKeyHash: inboxKeyHash(inboxKey), deadline }, config.chainId),
    ),
  }));
  const r = await directory("/v1/usernames/register", {
    username, account: account.address, displayName, inboxKeyHash: inboxKeyHash(inboxKey), deadline: deadline.toString(), sig,
  }).catch(() => null);
  if (!r) throw new UsernameError("DirectoryUnavailable");
  if (r.status !== 201 && r.status !== 200) throw new UsernameError(r.body.error);
  return saveAccount({ ...account, username, inboxKey });
}

// ── Inbox ───────────────────────────────────────────────────────────────────────────────────────────────────────
export type InboxItem = { paymentId: Hex; recipientSalt: Hex };

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
