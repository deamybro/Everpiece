import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { keccak256, type Address, type Hex } from "viem";
import { MONAD_MAINNET_CHAIN_ID } from "./constants.ts";

/**
 * Everpiece username directory (master §10). Off-chain, NOT trustless: the directory is a trust boundary and the
 * client pins recipients on first successful use (TOFU, master §10.2–10.3).
 *
 * What a registration signature proves: the account itself agreed to be called @username. What it does NOT prove:
 * that @username is the person the sender means. That is what the review screen + pinning are for.
 */
export const DIRECTORY_EIP712_NAME = "Everpiece Directory";
export const DIRECTORY_EIP712_VERSION = "1";

export function directoryDomain(escrow: Address, chainId: number = MONAD_MAINNET_CHAIN_ID) {
  return { name: DIRECTORY_EIP712_NAME, version: DIRECTORY_EIP712_VERSION, chainId, verifyingContract: escrow } as const;
}

export const directoryTypes = {
  /** Signed by `account` (its Mera key). `inboxKeyHash` lets the account later read its own payment inbox. */
  UsernameRegistration: [
    { name: "username", type: "string" },
    { name: "account", type: "address" },
    { name: "displayName", type: "string" },
    { name: "inboxKeyHash", type: "bytes32" },
    { name: "deadline", type: "uint256" },
  ],
} as const;

export type UsernameRegistration = { username: string; account: Address; displayName: string; inboxKeyHash: Hex; deadline: bigint };

export function usernameRegistration(escrow: Address, m: UsernameRegistration, chainId: number = MONAD_MAINNET_CHAIN_ID) {
  return { domain: directoryDomain(escrow, chainId), types: directoryTypes, primaryType: "UsernameRegistration" as const, message: m };
}

/** Lowercase ASCII only: no homoglyphs, no case tricks. 3–20 chars, starts with a letter. */
export const USERNAME = /^[a-z][a-z0-9_]{2,19}$/;

/** Names that could be mistaken for Everpiece staff or the system. */
export const RESERVED_USERNAMES: ReadonlySet<string> = new Set([
  "everpiece", "admin", "administrator", "support", "help", "helpdesk", "official", "security", "team", "staff",
  "system", "root", "mod", "moderator", "monad", "mera", "agora", "ausd", "wallet", "bank", "payments", "refund",
  "refunds", "verify", "verification", "claims", "relayer", "info", "contact", "service", "customer_service",
]);

/** Normalizes user input ("@Mama " → "mama"). Returns null if it can never be a valid username. */
export function normalizeUsername(input: string): string | null {
  const u = input.trim().replace(/^@/, "").toLowerCase();
  return USERNAME.test(u) ? u : null;
}

/**
 * Lookalike key: two usernames with the same key are treated as the SAME name, so only one person can hold it
 * (`mama`, `marna`, `mama_`, `m_a_m_a` all → "mama"; `adm1n` → "admln"). The directory stores it UNIQUE.
 * Folds: "_" dropped · 0→o · 1, i→l · rn→m · vv→w. The first-payment confirmation and pinning remain the main defence.
 */
export function usernameSkeleton(u: string): string {
  return u.replace(/_/g, "").replace(/0/g, "o").replace(/[1i]/g, "l").replace(/rn/g, "m").replace(/vv/g, "w");
}

const RESERVED_SKELETONS: ReadonlySet<string> = new Set([...RESERVED_USERNAMES].map(usernameSkeleton));

export function usernameProblem(u: string): "Invalid" | "Reserved" | null {
  if (!USERNAME.test(u)) return "Invalid";
  const k = usernameSkeleton(u);
  if (RESERVED_SKELETONS.has(k) || k.startsWith(usernameSkeleton("everpiece"))) return "Reserved";
  return null;
}

/** Display names are shown to senders as context; keep them short and free of control/bidi characters. */
export function cleanDisplayName(input: string): string | null {
  const s = input.normalize("NFC").trim().replace(/\s+/g, " ");
  if (s.length < 1 || s.length > 40) return null;
  // C0/C1 controls and Unicode bidi overrides/isolates (display spoofing).
  if (/[\u0000-\u001f\u007f-\u009f‎‏‪-‮⁦-⁩]/.test(s)) return null;
  return s;
}

/**
 * Inbox key, EVERPIECE_INBOX_V1: HKDF-SHA256(ikm = passkey PRF output, salt = none, info = "everpiece.inbox.v1", 32 B).
 * Domain-separated from the account key (which goes PRF → BIP-39 → BIP-32), so it reveals nothing about it, and it is
 * re-derivable on any device holding the passkey. It only authorizes READING the account's own inbox (privacy, not
 * funds). TODO(REVIEW): cryptographic review with the voice-key derivation (master §23).
 */
export function deriveEverpieceInboxKeyV1(prfOutput: Uint8Array): Uint8Array {
  if (prfOutput.length !== 32) throw new Error("EVERPIECE_INBOX_V1: PRF output must be 32 bytes");
  return hkdf(sha256, prfOutput, undefined, new TextEncoder().encode("everpiece.inbox.v1"), 32);
}

export function inboxKeyHash(inboxKey: Hex): Hex {
  return keccak256(inboxKey);
}
