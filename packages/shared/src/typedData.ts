import { hashTypedData, type Address, type Hex } from "viem";
import {
  AUSD_ADDRESS,
  AUSD_EIP712_NAME,
  AUSD_EIP712_VERSION,
  ESCROW_EIP712_NAME,
  ESCROW_EIP712_VERSION,
  MONAD_MAINNET_CHAIN_ID,
} from "./constants.ts";

/** EIP-712 types signed against the EverpieceEscrow domain (ESCROW_SPEC §6.2). */
export const escrowTypes = {
  PaymentIntent: [
    { name: "sender", type: "address" },
    { name: "mode", type: "uint8" },
    { name: "recipientCommitment", type: "bytes32" },
    { name: "metadataCommitment", type: "bytes32" },
    { name: "approver", type: "address" },
    { name: "amount", type: "uint256" },
    { name: "expiresAt", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "salt", type: "bytes32" },
  ],
  ClaimIntent: [
    { name: "paymentId", type: "bytes32" },
    { name: "recipient", type: "address" },
    { name: "actionNonce", type: "bytes32" },
    { name: "deadline", type: "uint256" },
  ],
  LinkClaimIntent: [
    { name: "paymentId", type: "bytes32" },
    { name: "recipient", type: "address" },
    { name: "actionNonce", type: "bytes32" },
    { name: "deadline", type: "uint256" },
  ],
  ClaimApproval: [
    { name: "paymentId", type: "bytes32" },
    { name: "recipient", type: "address" },
    { name: "approvalNonce", type: "bytes32" },
    { name: "deadline", type: "uint256" },
  ],
  CancelIntent: [
    { name: "paymentId", type: "bytes32" },
    { name: "sender", type: "address" },
    { name: "actionNonce", type: "bytes32" },
    { name: "deadline", type: "uint256" },
  ],
} as const;

/** The ONLY funding signature a sender makes (ESCROW_SPEC §7.1), in the AUSD domain. */
export const ausdTypes = {
  ReceiveWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
} as const;

export type PaymentIntent = {
  sender: Address;
  mode: number;
  recipientCommitment: Hex;
  metadataCommitment: Hex;
  approver: Address;
  amount: bigint;
  expiresAt: bigint;
  validAfter: bigint;
  validBefore: bigint;
  salt: Hex;
};

export function escrowDomain(escrow: Address, chainId: number = MONAD_MAINNET_CHAIN_ID) {
  return { name: ESCROW_EIP712_NAME, version: ESCROW_EIP712_VERSION, chainId, verifyingContract: escrow } as const;
}

export function ausdDomain(chainId: number = MONAD_MAINNET_CHAIN_ID, ausd: Address = AUSD_ADDRESS) {
  return { name: AUSD_EIP712_NAME, version: AUSD_EIP712_VERSION, chainId, verifyingContract: ausd } as const;
}

/** paymentId = EIP-712 digest of the PaymentIntent under the escrow domain; also the ERC-3009 nonce. */
export function paymentIdOf(escrow: Address, intent: PaymentIntent, chainId: number = MONAD_MAINNET_CHAIN_ID): Hex {
  return hashTypedData({ domain: escrowDomain(escrow, chainId), types: escrowTypes, primaryType: "PaymentIntent", message: intent });
}

/**
 * Typed data the sender signs to fund a payment. Every field is derived from the intent — the contract re-derives
 * them identically, so a signature over anything else is useless (ESCROW_SPEC §7.2).
 */
export function fundingAuthorization(escrow: Address, intent: PaymentIntent, chainId: number = MONAD_MAINNET_CHAIN_ID, ausd: Address = AUSD_ADDRESS) {
  return {
    domain: ausdDomain(chainId, ausd),
    types: ausdTypes,
    primaryType: "ReceiveWithAuthorization" as const,
    message: {
      from: intent.sender,
      to: escrow,
      value: intent.amount,
      validAfter: intent.validAfter,
      validBefore: intent.validBefore,
      nonce: paymentIdOf(escrow, intent, chainId),
    },
  };
}

type Action = { paymentId: Hex; deadline: bigint };

export function claimIntent(escrow: Address, m: Action & { recipient: Address; actionNonce: Hex }, chainId: number = MONAD_MAINNET_CHAIN_ID) {
  return { domain: escrowDomain(escrow, chainId), types: escrowTypes, primaryType: "ClaimIntent" as const, message: m };
}

export function linkClaimIntent(escrow: Address, m: Action & { recipient: Address; actionNonce: Hex }, chainId: number = MONAD_MAINNET_CHAIN_ID) {
  return { domain: escrowDomain(escrow, chainId), types: escrowTypes, primaryType: "LinkClaimIntent" as const, message: m };
}

export function claimApproval(escrow: Address, m: Action & { recipient: Address; approvalNonce: Hex }, chainId: number = MONAD_MAINNET_CHAIN_ID) {
  return { domain: escrowDomain(escrow, chainId), types: escrowTypes, primaryType: "ClaimApproval" as const, message: m };
}

export function cancelIntent(escrow: Address, m: Action & { sender: Address; actionNonce: Hex }, chainId: number = MONAD_MAINNET_CHAIN_ID) {
  return { domain: escrowDomain(escrow, chainId), types: escrowTypes, primaryType: "CancelIntent" as const, message: m };
}
