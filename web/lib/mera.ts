import {
  createPasskeyWithPrfOutput,
  createSecp256k1SigningSession,
  getPasskeyPrfOutput,
  isMeraError,
  type PasskeyCredentialTransport,
} from "@category-labs/mera";
import { toViemAccount } from "@category-labs/mera/viem";
import type { Address, LocalAccount } from "viem";
import { deriveEverpieceAccountV1 } from "@everpiece/shared";

/**
 * Mera passkey accounts, EVERPIECE_ACCOUNT_V1 (VERIFIED §3.4). Stored locally: ONLY the credential id/transports
 * (not secret, per the Mera recipe) plus the derived public address. PRF output and private keys are never
 * persisted, logged or sent anywhere, and are zeroed right after use (master §22.2).
 */
const STORAGE_KEY = "everpiece.account.v1";

export type Account = { credentialId: string; transports?: PasskeyCredentialTransport[]; address: Address; name: string };

const rpId = () => window.location.hostname; // production rpId must be everpiece.xyz (VERIFIED §3.5)

export function loadAccount(): Account | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as Account) : null;
  } catch {
    return null;
  }
}

function saveAccount(a: Account): Account {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(a));
  return a;
}

export function forgetAccount(): void {
  localStorage.removeItem(STORAGE_KEY);
}

function addressFrom(prfOutput: Uint8Array): Address {
  const { privateKey, address } = deriveEverpieceAccountV1(prfOutput);
  privateKey.fill(0);
  prfOutput.fill(0);
  return address;
}

export async function createAccount(name: string): Promise<Account> {
  const created = await createPasskeyWithPrfOutput({ rp: { id: rpId(), name: "Everpiece" }, user: { name, displayName: name } });
  return saveAccount({ credentialId: created.credentialId, transports: created.transports ? [...created.transports] : undefined, address: addressFrom(created.prfOutput), name });
}

/** Sign in with an existing passkey on this device / synced provider. */
export async function signIn(): Promise<Account> {
  const r = await getPasskeyPrfOutput({ rpId: rpId() });
  return saveAccount({ credentialId: r.credentialId, address: addressFrom(r.prfOutput), name: "" });
}

/**
 * One passkey ceremony → a signing capability for exactly one financial action → session ended, keys zeroed
 * (master §22.4 "prompt per financial action").
 */
export async function withSigner<T>(account: Account, fn: (signer: LocalAccount) => Promise<T>): Promise<T> {
  const r = await getPasskeyPrfOutput({ rpId: rpId(), credential: { credentialId: account.credentialId, transports: account.transports } });
  const { privateKey, address } = deriveEverpieceAccountV1(r.prfOutput);
  r.prfOutput.fill(0);
  if (address !== account.address) {
    privateKey.fill(0);
    throw new Error("WrongPasskey");
  }
  const session = createSecp256k1SigningSession({ privateKey });
  privateKey.fill(0);
  try {
    return await fn(toViemAccount(session));
  } finally {
    session.end();
  }
}

/** Mera error codes → consumer copy (master §22.5: never show raw SDK errors). */
export function friendlyPasskeyError(e: unknown): string {
  if (e instanceof Error && e.message === "WrongPasskey") return "That fingerprint belongs to a different Everpiece account.";
  if (isMeraError(e)) {
    switch (e.code) {
      case "PRF_UNAVAILABLE":
        return "This device or password manager can't create an Everpiece account. Try Chrome with Google Password Manager, or Safari on iPhone.";
      case "PASSKEY_OPERATION_FAILED":
        return "Fingerprint was cancelled or isn't available here. If you opened this from WhatsApp, open it in your browser instead.";
      case "CRYPTO_UNAVAILABLE":
        return "Please open Everpiece in a secure browser (Chrome or Safari).";
      default:
        return "Your fingerprint couldn't be used. Please try again.";
    }
  }
  return "Your fingerprint couldn't be used. Please try again.";
}
