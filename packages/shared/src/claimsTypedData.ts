import { keccak256, stringToHex, type Address, type Hex } from "viem";
import { MONAD_MAINNET_CHAIN_ID } from "./constants.ts";

/**
 * Off-chain messages of the claims/approver server (server/claims). Never submitted on-chain.
 * Domain binds chain + escrow so a signature for one deployment is useless for another.
 */
export const CLAIMS_EIP712_NAME = "Everpiece Claims";
export const CLAIMS_EIP712_VERSION = "1";

export function claimsDomain(escrow: Address, chainId: number = MONAD_MAINNET_CHAIN_ID) {
  return { name: CLAIMS_EIP712_NAME, version: CLAIMS_EIP712_VERSION, chainId, verifyingContract: escrow } as const;
}

export const claimsTypes = {
  /** Sender registers the phone that must receive the verification code for a LINK payment. */
  InviteRegistration: [
    { name: "paymentId", type: "bytes32" },
    { name: "phoneHash", type: "bytes32" },
    { name: "deadline", type: "uint256" },
  ],
  /**
   * Email channel: the sender registers the email that must receive the verification code. A separate type (not a
   * field on InviteRegistration), so a phone signature can never be replayed as an email one or vice versa.
   */
  EmailInviteRegistration: [
    { name: "paymentId", type: "bytes32" },
    { name: "emailHash", type: "bytes32" },
    { name: "deadline", type: "uint256" },
  ],
  /** Link holder (claim key) asks for a code to be sent, binding the wallet that will receive the approval. */
  ClaimStart: [
    { name: "paymentId", type: "bytes32" },
    { name: "recipient", type: "address" },
    { name: "deadline", type: "uint256" },
  ],
} as const;

/** E.164 only (no local formats); normalization is the client's job. */
export const E164 = /^\+[1-9][0-9]{7,14}$/;

/** phoneHash = keccak256(utf8(E.164)). Signed off-chain only; never put on-chain (master §12.3). */
export function phoneHash(e164: string): Hex {
  if (!E164.test(e164)) throw new Error("phone must be E.164, e.g. +2348000000000");
  return keccak256(stringToHex(e164));
}

/** Lowercase ASCII only (no homoglyphs); normalizeEmail produces this form. */
export const EMAIL = /^[a-z0-9._%+-]{1,64}@[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}$/;

/** " Mama.Ngozi@Example.com " → "mama.ngozi@example.com"; null if it can't be a valid address. */
export function normalizeEmail(input: string): string | null {
  const e = input.trim().toLowerCase();
  return e.length <= 254 && EMAIL.test(e) ? e : null;
}

/** emailHash = keccak256(utf8(normalized email)). Signed off-chain only; never put on-chain (master §12.3). */
export function emailHash(email: string): Hex {
  if (normalizeEmail(email) !== email) throw new Error("email must be normalized: trimmed, lowercase, e.g. mama@example.com");
  return keccak256(stringToHex(email));
}

export function emailInviteRegistration(escrow: Address, m: { paymentId: Hex; emailHash: Hex; deadline: bigint }, chainId: number = MONAD_MAINNET_CHAIN_ID) {
  return { domain: claimsDomain(escrow, chainId), types: claimsTypes, primaryType: "EmailInviteRegistration" as const, message: m };
}

export function inviteRegistration(escrow: Address, m: { paymentId: Hex; phoneHash: Hex; deadline: bigint }, chainId: number = MONAD_MAINNET_CHAIN_ID) {
  return { domain: claimsDomain(escrow, chainId), types: claimsTypes, primaryType: "InviteRegistration" as const, message: m };
}

export function claimStart(escrow: Address, m: { paymentId: Hex; recipient: Address; deadline: bigint }, chainId: number = MONAD_MAINNET_CHAIN_ID) {
  return { domain: claimsDomain(escrow, chainId), types: claimsTypes, primaryType: "ClaimStart" as const, message: m };
}
