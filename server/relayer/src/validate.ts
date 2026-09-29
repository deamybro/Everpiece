import { getAddress, isAddress, type Address, type Hex } from "viem";
import type { PaymentIntent } from "@everpiece/shared";

export class ValidationError extends Error {}

const UINT256_MAX = (1n << 256n) - 1n;

type Obj = Record<string, unknown>;

function obj(v: unknown, where: string, keys: readonly string[]): Obj {
  if (typeof v !== "object" || v === null || Array.isArray(v)) throw new ValidationError(`${where}: expected object`);
  const o = v as Obj;
  for (const k of Object.keys(o)) if (!keys.includes(k)) throw new ValidationError(`${where}: unknown field "${k}"`);
  for (const k of keys) if (!(k in o)) throw new ValidationError(`${where}: missing field "${k}"`);
  return o;
}

function addr(v: unknown, where: string): Address {
  if (typeof v !== "string" || !isAddress(v, { strict: false })) throw new ValidationError(`${where}: invalid address`);
  return getAddress(v);
}

function hexBytes(v: unknown, where: string, bytes: number): Hex {
  if (typeof v !== "string" || !new RegExp(`^0x[0-9a-fA-F]{${bytes * 2}}$`).test(v)) {
    throw new ValidationError(`${where}: expected ${bytes}-byte hex`);
  }
  return v.toLowerCase() as Hex;
}

const b32 = (v: unknown, w: string) => hexBytes(v, w, 32);
/** EOA 65-byte r‖s‖v only — the escrow rejects anything else (ESCROW_SPEC §6.4). AUSD funding sigs likewise. */
const sig = (v: unknown, w: string) => hexBytes(v, w, 65);

/** uint256 as a canonical decimal string (no floats, no JS numbers — master §39). */
function u256(v: unknown, where: string): bigint {
  if (typeof v !== "string" || !/^(0|[1-9][0-9]{0,77})$/.test(v)) throw new ValidationError(`${where}: expected decimal string`);
  const n = BigInt(v);
  if (n > UINT256_MAX) throw new ValidationError(`${where}: out of range`);
  return n;
}

function mode(v: unknown, where: string): 1 | 2 {
  if (v !== 1 && v !== 2) throw new ValidationError(`${where}: mode must be 1 (USERNAME) or 2 (LINK)`);
  return v;
}

export type CreateParams = { intent: PaymentIntent; ausdSignature: Hex };
export type ClaimUsernameParams = {
  paymentId: Hex;
  recipient: Address;
  recipientSalt: Hex;
  actionNonce: Hex;
  deadline: bigint;
  recipientSig: Hex;
};
export type ClaimLinkParams = {
  paymentId: Hex;
  recipient: Address;
  claimKey: Address;
  recipientSalt: Hex;
  actionNonce: Hex;
  deadline: bigint;
  claimKeySig: Hex;
  approvalNonce: Hex;
  approvalDeadline: bigint;
  approverSig: Hex;
};
export type CancelParams = { paymentId: Hex; actionNonce: Hex; deadline: bigint; senderSig: Hex };
export type RefundParams = { paymentId: Hex };

const INTENT_KEYS = [
  "sender", "mode", "recipientCommitment", "metadataCommitment", "approver",
  "amount", "expiresAt", "validAfter", "validBefore", "salt",
] as const;

export function parseCreate(body: unknown): CreateParams {
  const o = obj(body, "body", ["intent", "ausdSignature"]);
  const i = obj(o.intent, "intent", INTENT_KEYS);
  return {
    intent: {
      sender: addr(i.sender, "intent.sender"),
      mode: mode(i.mode, "intent.mode"),
      recipientCommitment: b32(i.recipientCommitment, "intent.recipientCommitment"),
      metadataCommitment: b32(i.metadataCommitment, "intent.metadataCommitment"),
      approver: addr(i.approver, "intent.approver"),
      amount: u256(i.amount, "intent.amount"),
      expiresAt: u256(i.expiresAt, "intent.expiresAt"),
      validAfter: u256(i.validAfter, "intent.validAfter"),
      validBefore: u256(i.validBefore, "intent.validBefore"),
      salt: b32(i.salt, "intent.salt"),
    },
    ausdSignature: sig(o.ausdSignature, "ausdSignature"),
  };
}

export function parseClaimUsername(body: unknown): ClaimUsernameParams {
  const o = obj(body, "body", ["paymentId", "recipient", "recipientSalt", "actionNonce", "deadline", "recipientSig"]);
  return {
    paymentId: b32(o.paymentId, "paymentId"),
    recipient: addr(o.recipient, "recipient"),
    recipientSalt: b32(o.recipientSalt, "recipientSalt"),
    actionNonce: b32(o.actionNonce, "actionNonce"),
    deadline: u256(o.deadline, "deadline"),
    recipientSig: sig(o.recipientSig, "recipientSig"),
  };
}

export function parseClaimLink(body: unknown): ClaimLinkParams {
  const o = obj(body, "body", [
    "paymentId", "recipient", "claimKey", "recipientSalt", "actionNonce", "deadline",
    "claimKeySig", "approvalNonce", "approvalDeadline", "approverSig",
  ]);
  return {
    paymentId: b32(o.paymentId, "paymentId"),
    recipient: addr(o.recipient, "recipient"),
    claimKey: addr(o.claimKey, "claimKey"),
    recipientSalt: b32(o.recipientSalt, "recipientSalt"),
    actionNonce: b32(o.actionNonce, "actionNonce"),
    deadline: u256(o.deadline, "deadline"),
    claimKeySig: sig(o.claimKeySig, "claimKeySig"),
    approvalNonce: b32(o.approvalNonce, "approvalNonce"),
    approvalDeadline: u256(o.approvalDeadline, "approvalDeadline"),
    approverSig: sig(o.approverSig, "approverSig"),
  };
}

export function parseCancel(body: unknown): CancelParams {
  const o = obj(body, "body", ["paymentId", "actionNonce", "deadline", "senderSig"]);
  return {
    paymentId: b32(o.paymentId, "paymentId"),
    actionNonce: b32(o.actionNonce, "actionNonce"),
    deadline: u256(o.deadline, "deadline"),
    senderSig: sig(o.senderSig, "senderSig"),
  };
}

export function parseRefund(body: unknown): RefundParams {
  const o = obj(body, "body", ["paymentId"]);
  return { paymentId: b32(o.paymentId, "paymentId") };
}
