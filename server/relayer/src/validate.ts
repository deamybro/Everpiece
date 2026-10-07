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

// ── EverpiecePay ─────────────────────────────────────────────────────────────────────────────────────────────────
export type PayPayment = {
  ref: Hex;
  sender: Address;
  recipient: Address;
  amount: bigint;
  sourceToken: Address;
  maxSourceAmount: bigint;
  deadline: bigint;
};
export type PayAusdParams = { payment: PayPayment; ausdSignature: Hex };
export type PayTokenParams = { payment: PayPayment; payerSignature: Hex; permit: { deadline: bigint; v: number; r: Hex; s: Hex } };

const PAYMENT_KEYS = ["ref", "sender", "recipient", "amount", "sourceToken", "maxSourceAmount", "deadline"] as const;

function parsePayment(v: unknown): PayPayment {
  const p = obj(v, "payment", PAYMENT_KEYS);
  return {
    ref: b32(p.ref, "payment.ref"),
    sender: addr(p.sender, "payment.sender"),
    recipient: addr(p.recipient, "payment.recipient"),
    amount: u256(p.amount, "payment.amount"),
    sourceToken: addr(p.sourceToken, "payment.sourceToken"),
    maxSourceAmount: u256(p.maxSourceAmount, "payment.maxSourceAmount"),
    deadline: u256(p.deadline, "payment.deadline"),
  };
}

export function parsePayAusd(body: unknown): PayAusdParams {
  const o = obj(body, "body", ["payment", "ausdSignature"]);
  return { payment: parsePayment(o.payment), ausdSignature: sig(o.ausdSignature, "ausdSignature") };
}

export function parsePayToken(body: unknown): PayTokenParams {
  const o = obj(body, "body", ["payment", "payerSignature", "permit"]);
  const pm = obj(o.permit, "permit", ["deadline", "v", "r", "s"]);
  if (pm.v !== 27 && pm.v !== 28) throw new ValidationError("permit.v: 27 or 28");
  return {
    payment: parsePayment(o.payment),
    payerSignature: sig(o.payerSignature, "payerSignature"),
    permit: { deadline: u256(pm.deadline, "permit.deadline"), v: pm.v, r: b32(pm.r, "permit.r"), s: b32(pm.s, "permit.s") },
  };
}

export type QuoteParams = { sellToken: Address; buyAmount: bigint; recipient: Address; sender: Address };
export function parseQuote(body: unknown): QuoteParams {
  const o = obj(body, "body", ["sellToken", "buyAmount", "recipient", "sender"]);
  return { sellToken: addr(o.sellToken, "sellToken"), buyAmount: u256(o.buyAmount, "buyAmount"), recipient: addr(o.recipient, "recipient"), sender: addr(o.sender, "sender") };
}

export type EarnDepositParams = { deposit: { ref: Hex; owner: Address; vault: Address; assets: bigint; minShares: bigint; deadline: bigint }; ausdSignature: Hex };
export function parseEarnDeposit(body: unknown): EarnDepositParams {
  const o = obj(body, "body", ["deposit", "ausdSignature"]);
  const d = obj(o.deposit, "deposit", ["ref", "owner", "vault", "assets", "minShares", "deadline"]);
  return {
    deposit: { ref: b32(d.ref, "deposit.ref"), owner: addr(d.owner, "deposit.owner"), vault: addr(d.vault, "deposit.vault"), assets: u256(d.assets, "deposit.assets"), minShares: u256(d.minShares, "deposit.minShares"), deadline: u256(d.deadline, "deposit.deadline") },
    ausdSignature: sig(o.ausdSignature, "ausdSignature"),
  };
}

export type EarnWithdrawParams = {
  withdrawal: { ref: Hex; owner: Address; vault: Address; assets: bigint; maxShares: bigint; deadline: bigint };
  ownerSignature: Hex;
  permit: { v: number; r: Hex; s: Hex };
};
export function parseEarnWithdraw(body: unknown): EarnWithdrawParams {
  const o = obj(body, "body", ["withdrawal", "ownerSignature", "permit"]);
  const w = obj(o.withdrawal, "withdrawal", ["ref", "owner", "vault", "assets", "maxShares", "deadline"]);
  const pm = obj(o.permit, "permit", ["v", "r", "s"]);
  if (pm.v !== 27 && pm.v !== 28) throw new ValidationError("permit.v: 27 or 28");
  return {
    withdrawal: { ref: b32(w.ref, "withdrawal.ref"), owner: addr(w.owner, "withdrawal.owner"), vault: addr(w.vault, "withdrawal.vault"), assets: u256(w.assets, "withdrawal.assets"), maxShares: u256(w.maxShares, "withdrawal.maxShares"), deadline: u256(w.deadline, "withdrawal.deadline") },
    ownerSignature: sig(o.ownerSignature, "ownerSignature"),
    permit: { v: pm.v, r: b32(pm.r, "permit.r"), s: b32(pm.s, "permit.s") },
  };
}
