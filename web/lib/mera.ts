import {
  createPasskeyWithPrfOutput,
  createSecp256k1SigningSession,
  getPasskeyPrfOutput,
  isMeraError,
  type PasskeyCredentialTransport,
} from "@category-labs/mera";
import { toViemAccount } from "@category-labs/mera/viem";
import { startSession, takeFromSession } from "./session";
import { bytesToHex, type Address, type Hex, type LocalAccount } from "viem";
import { deriveEverpieceAccountV1, deriveEverpieceInboxKeyV1, deriveEverpieceMessageSeedV1 } from "@everpiece/shared";

/**
 * Mera passkey accounts, EVERPIECE_ACCOUNT_V1 (VERIFIED §3.4). Stored locally: the credential id/transports
 * (not secret, per the Mera recipe), the derived public address, the chosen @username, and the EVERPIECE_INBOX_V1
 * inbox key. The inbox key only lets this device READ the account's username-payment inbox (privacy, not funds), so
 * Home can show money waiting without a fingerprint prompt. Likewise the EVERPIECE_MESSAGE_KEY_V1 seed: it only opens
 * messages sent to this account (privacy, not funds), so Home can play them without a prompt; an XSS on our origin could
 * read both, which is why the CSP is strict (THREAT_MODEL F1, K). PRF output and private keys are never persisted, logged
 * or sent anywhere, and are zeroed right after use (master §22.2).
 */
const STORAGE_KEY = "everpiece.account.v1";

export type Account = {
  credentialId: string;
  transports?: PasskeyCredentialTransport[];
  address: Address;
  name: string;
  inboxKey?: Hex;
  /** EVERPIECE_MESSAGE_KEY_V1 seed (opens messages sent to this account). */
  messageSeed?: Hex;
  /** The directory has this account's signed message key. */
  messageKeyPublished?: boolean;
  username?: string;
};

// Passkey accounts are bound to this id: it must never change once users exist. Mainnet pins it to the registrable domain
// (NEXT_PUBLIC_RP_ID=everpiece.xyz, valid for every subdomain); dev stacks default to the hostname they are served on.
const rpId = () => process.env.NEXT_PUBLIC_RP_ID || window.location.hostname;

export function loadAccount(): Account | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as Account) : null;
  } catch {
    return null;
  }
}

export function saveAccount(a: Account): Account {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(a));
  return a;
}

export function forgetAccount(): void {
  localStorage.removeItem(STORAGE_KEY);
}

function publicFrom(prfOutput: Uint8Array): { address: Address; inboxKey: Hex; messageSeed: Hex } {
  const { privateKey, address } = deriveEverpieceAccountV1(prfOutput);
  privateKey.fill(0);
  const ik = deriveEverpieceInboxKeyV1(prfOutput);
  const inboxKey = bytesToHex(ik);
  ik.fill(0);
  const ms = deriveEverpieceMessageSeedV1(prfOutput);
  const messageSeed = bytesToHex(ms);
  ms.fill(0);
  prfOutput.fill(0);
  return { address, inboxKey, messageSeed };
}

export async function createAccount(name: string): Promise<Account> {
  const created = await createPasskeyWithPrfOutput({ rp: { id: rpId(), name: "Everpiece" }, user: { name, displayName: name } });
  return saveAccount({ credentialId: created.credentialId, transports: created.transports ? [...created.transports] : undefined, ...publicFrom(created.prfOutput), name });
}

/** Sign in with an existing passkey on this device / synced provider. */
export async function signIn(): Promise<Account> {
  const r = await getPasskeyPrfOutput({ rpId: rpId() });
  return saveAccount({ credentialId: r.credentialId, ...publicFrom(r.prfOutput), name: "" });
}

/**
 * One passkey ceremony → a signing capability for exactly one financial action → session ended, keys zeroed
 * (master §22.4 "prompt per financial action"). The same ceremony also yields the inbox key (needed once, when the
 * username is registered).
 */
export async function withSigner<T>(account: Account, fn: (signer: LocalAccount, inboxKey: Hex, messageSeed: Hex) => Promise<T>, opts?: { spend?: bigint }): Promise<T> {
  // An open, scoped session may sign a payment that declares its amount (see lib/session.ts); anything else always asks.
  const s = opts?.spend !== undefined ? takeFromSession(account.address, opts.spend) : null;
  if (s) {
    try {
      return await fn(s.signer, s.inboxKey, s.messageSeed);
    } catch (e) {
      s.refund();
      throw e;
    }
  }
  const r = await getPasskeyPrfOutput({ rpId: rpId(), credential: { credentialId: account.credentialId, transports: account.transports } });
  const { privateKey, address } = deriveEverpieceAccountV1(r.prfOutput);
  const ik = deriveEverpieceInboxKeyV1(r.prfOutput);
  const inboxKey = bytesToHex(ik);
  ik.fill(0);
  const ms = deriveEverpieceMessageSeedV1(r.prfOutput);
  const messageSeed = bytesToHex(ms);
  ms.fill(0);
  r.prfOutput.fill(0);
  if (address !== account.address) {
    privateKey.fill(0);
    throw new Error("WrongPasskey");
  }
  const session = createSecp256k1SigningSession({ privateKey });
  privateKey.fill(0);
  try {
    return await fn(toViemAccount(session), inboxKey, messageSeed);
  } finally {
    session.end();
  }
}

/** One fingerprint opens a short, capped session: small payments inside it need no further prompt (lib/session.ts). */
export async function unlockSession(account: Account, opts: { ttlMs: number; cap: bigint }): Promise<void> {
  const r = await getPasskeyPrfOutput({ rpId: rpId(), credential: { credentialId: account.credentialId, transports: account.transports } });
  const { privateKey, address } = deriveEverpieceAccountV1(r.prfOutput);
  const ik = deriveEverpieceInboxKeyV1(r.prfOutput);
  const inboxKey = bytesToHex(ik);
  ik.fill(0);
  const ms = deriveEverpieceMessageSeedV1(r.prfOutput);
  const messageSeed = bytesToHex(ms);
  ms.fill(0);
  r.prfOutput.fill(0);
  if (address !== account.address) {
    privateKey.fill(0);
    throw new Error("WrongPasskey");
  }
  const session = createSecp256k1SigningSession({ privateKey });
  privateKey.fill(0);
  startSession({ address, signer: toViemAccount(session), end: () => session.end(), inboxKey, messageSeed, ttlMs: opts.ttlMs, cap: opts.cap });
}

/** This device lacks the message seed (account saved before messages existed): one prompt derives it, nothing is signed. */
export async function unlockMessages(account: Account): Promise<Account> {
  const r = await getPasskeyPrfOutput({ rpId: rpId(), credential: { credentialId: account.credentialId, transports: account.transports } });
  const { address, messageSeed } = publicFrom(r.prfOutput);
  if (address !== account.address) throw new Error("WrongPasskey");
  return saveAccount({ ...account, messageSeed });
}

/** Mera error codes → consumer copy (master §22.5: never show raw SDK errors). */
export function friendlyPasskeyError(e: unknown): string {
  if (e instanceof Error && e.message === "WrongPasskey") return "That passkey belongs to a different Everpiece account.";
  if (isMeraError(e)) {
    switch (e.code) {
      case "PRF_UNAVAILABLE":
        return "This device or password manager can't create an Everpiece account. Try Chrome with Google Password Manager, or Safari on iPhone.";
      case "PASSKEY_OPERATION_FAILED":
        return "Fingerprint was cancelled or isn't available here. If you opened this from WhatsApp, open it in your browser instead.";
      case "CRYPTO_UNAVAILABLE":
        return "Please open Everpiece in a secure browser (Chrome or Safari).";
      default:
        return "Your fingerprint or screen lock couldn't be used. Please try again.";
    }
  }
  return "Your fingerprint or screen lock couldn't be used. Please try again.";
}
