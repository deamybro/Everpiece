import type { Address, Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  MAX_EXPIRY_SECONDS,
  NO_METADATA,
  PaymentMode,
  cancelIntent,
  claimIntent,
  claimStart,
  fundingAuthorization,
  inviteRegistration,
  linkClaimIntent,
  paymentIdOf,
  phoneHash,
  recipientCommitment,
  type PaymentIntent,
} from "@everpiece/shared";
import { config } from "./config";
import { chainTime, claimApprover } from "./chain";
import { claims, directory, relayer, waitForRequest, type RelayStatus } from "./api";
import { newClaimPackage, randomBytes32, type ClaimPackage } from "./link";
import { withSigner, type Account } from "./mera";
import { pin, type Recipient } from "./username";

export class FlowError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(code);
    this.code = code;
  }
}

const SENT_KEY = "everpiece.sent.v1";
export type SentPayment = {
  paymentId: Hex;
  amount: string;
  to: string;
  createdAt: number;
  expiresAt: string;
  /** Username payments only: kept until the directory has the recipient's inbox entry (the salt is not a theft secret, ESCROW_SPEC §3.1). */
  delivery?: { recipient: Address; recipientSalt: Hex; delivered: boolean };
};

export function loadSent(): SentPayment[] {
  try {
    return JSON.parse(localStorage.getItem(SENT_KEY) ?? "[]") as SentPayment[];
  } catch {
    return [];
  }
}
function rememberSent(p: SentPayment) {
  localStorage.setItem(SENT_KEY, JSON.stringify([p, ...loadSent().filter((x) => x.paymentId !== p.paymentId)].slice(0, 50)));
}
function markDelivered(paymentId: Hex) {
  localStorage.setItem(SENT_KEY, JSON.stringify(loadSent().map((x) => (x.paymentId === paymentId && x.delivery ? { ...x, delivery: { ...x.delivery, delivered: true } } : x))));
}

/**
 * Send by link (LINK mode). ONE fingerprint prompt signs both the AUSD funding authorization and the
 * InviteRegistration (the recipient phone). The link secret is created locally and returned — never stored.
 */
export async function sendByLink(
  account: Account,
  amount: bigint,
  phoneE164: string,
  onStatus: (s: RelayStatus | "SIGNING") => void,
): Promise<{ paymentId: Hex; pkg: ClaimPackage }> {
  const pkg = newClaimPackage();
  const claimKey = privateKeyToAccount(pkg.claimPrivateKey).address;
  const [t, approver] = await Promise.all([chainTime(), claimApprover()]);
  const intent: PaymentIntent = {
    sender: account.address,
    mode: PaymentMode.LINK,
    recipientCommitment: recipientCommitment(PaymentMode.LINK, claimKey, pkg.recipientSalt),
    metadataCommitment: NO_METADATA,
    approver,
    amount,
    // expiry is checked at execution time (≤ now + 30 d); signing slightly earlier keeps it inside the window.
    expiresAt: t + MAX_EXPIRY_SECONDS,
    validAfter: 0n,
    validBefore: t + 3600n,
    salt: randomBytes32(),
  };
  const paymentId = paymentIdOf(config.escrow, intent, config.chainId);
  // The claims server accepts request deadlines at most 10 minutes ahead (REQUEST_DEADLINE_MAX_SEC = 600).
  const inviteDeadline = t + 540n;

  onStatus("SIGNING");
  const { ausdSignature, senderSig } = await withSigner(account, async (signer) => ({
    ausdSignature: await signer.signTypedData(fundingAuthorization(config.escrow, intent, config.chainId)),
    senderSig: await signer.signTypedData(
      inviteRegistration(config.escrow, { paymentId, phoneHash: phoneHash(phoneE164), deadline: inviteDeadline }, config.chainId),
    ),
  }));

  const r = await relayer("/v1/payments/create", { intent, ausdSignature });
  if (r.status !== 202 && r.status !== 200) throw new FlowError(r.body.error);
  const done = await waitForRequest(r.body.requestId, onStatus);
  if (done.status !== "CONFIRMED") throw new FlowError(done.error ?? "PaymentNotConfirmed");

  // The money is now protected on-chain. From here on, never let the user "try again" into a second payment.
  rememberSent({ paymentId, amount: amount.toString(), to: phoneE164, createdAt: Date.now(), expiresAt: intent.expiresAt.toString() });
  let lastError = "";
  for (let attempt = 0; attempt < 3; attempt++) {
    const inv = await claims("/v1/invites", { paymentId, phone: phoneE164, deadline: inviteDeadline, senderSig }).catch(() => null);
    if (inv && (inv.status === 201 || inv.status === 200)) return { paymentId, pkg };
    lastError = inv?.body.error ?? "network";
    await new Promise((r) => setTimeout(r, 1500));
  }
  throw new FlowError(`InviteFailedAfterPayment:${lastError}`);
}

export async function cancelPayment(account: Account, paymentId: Hex, onStatus: (s: RelayStatus | "SIGNING") => void): Promise<void> {
  const actionNonce = randomBytes32();
  const deadline = (await chainTime()) + 600n;
  onStatus("SIGNING");
  const senderSig = await withSigner(account, (signer) =>
    signer.signTypedData(cancelIntent(config.escrow, { paymentId, sender: account.address, actionNonce, deadline }, config.chainId)),
  );
  const r = await relayer("/v1/payments/cancel", { paymentId, actionNonce, deadline, senderSig });
  if (r.status !== 202 && r.status !== 200) throw new FlowError(r.body.error);
  const done = await waitForRequest(r.body.requestId, onStatus);
  if (done.status !== "CONFIRMED") throw new FlowError(done.error ?? "NotConfirmed");
}

/** Anyone may return an expired payment to its sender; no signature needed. */
export async function returnExpired(paymentId: Hex, onStatus: (s: RelayStatus) => void): Promise<void> {
  const r = await relayer("/v1/payments/refund", { paymentId });
  if (r.status !== 202 && r.status !== 200) throw new FlowError(r.body.error);
  const done = await waitForRequest(r.body.requestId, onStatus);
  if (done.status !== "CONFIRMED") throw new FlowError(done.error ?? "NotConfirmed");
}

/** Step 1 of a link claim: the link's claim key asks the claims server to text the code (binds the recipient wallet). */
export async function requestCode(paymentId: Hex, pkg: ClaimPackage, recipient: Address): Promise<{ maskedPhone: string; simulated: boolean }> {
  const claimKey = privateKeyToAccount(pkg.claimPrivateKey);
  const deadline = (await chainTime()) + 300n;
  const claimKeySig = await claimKey.signTypedData(claimStart(config.escrow, { paymentId, recipient, deadline }, config.chainId));
  const r = await claims("/v1/claims/start", {
    paymentId, recipient, claimKey: claimKey.address, recipientSalt: pkg.recipientSalt, deadline, claimKeySig,
  });
  if (r.status !== 200) throw new FlowError(r.body.error);
  return { maskedPhone: r.body.maskedPhone, simulated: Boolean(r.body.simulated) };
}

/** Step 2: code → approval → claim-key signature → relayer. Both capabilities are bound to `recipient`. */
export async function claimWithCode(
  paymentId: Hex,
  pkg: ClaimPackage,
  recipient: Address,
  code: string,
  onStatus: (s: RelayStatus) => void,
): Promise<void> {
  const v = await claims("/v1/claims/verify", { paymentId, recipient, code });
  if (v.status !== 200) throw Object.assign(new FlowError(v.body.error), { attemptsLeft: v.body.attemptsLeft });
  const claimKey = privateKeyToAccount(pkg.claimPrivateKey);
  const actionNonce = randomBytes32();
  const deadline = (await chainTime()) + 600n;
  const claimKeySig = await claimKey.signTypedData(linkClaimIntent(config.escrow, { paymentId, recipient, actionNonce, deadline }, config.chainId));
  const r = await relayer("/v1/payments/claim-link", {
    paymentId, recipient, claimKey: claimKey.address, recipientSalt: pkg.recipientSalt, actionNonce, deadline, claimKeySig,
    approvalNonce: v.body.approvalNonce, approvalDeadline: v.body.approvalDeadline, approverSig: v.body.approverSig,
  });
  if (r.status !== 202 && r.status !== 200) throw new FlowError(r.body.error);
  const done = await waitForRequest(r.body.requestId, onStatus);
  if (done.status !== "CONFIRMED") throw new FlowError(done.error ?? "NotConfirmed");
}

/** Hand the recipient salt to the directory inbox. Idempotent; true once the directory has it. */
export async function deliver(p: SentPayment): Promise<boolean> {
  if (!p.delivery || p.delivery.delivered) return true;
  const r = await directory("/v1/inbox/deliver", { paymentId: p.paymentId, recipient: p.delivery.recipient, recipientSalt: p.delivery.recipientSalt }).catch(() => null);
  if (r && (r.status === 201 || r.status === 200)) {
    markDelivered(p.paymentId);
    return true;
  }
  return false;
}

/**
 * Send to @username (USERNAME mode, ESCROW_SPEC §3.1). ONE fingerprint prompt signs the AUSD funding authorization.
 * Only the recipient's own account can claim it (their signature is checked on-chain), so no code or link is needed.
 */
export async function sendToUsername(
  account: Account,
  amount: bigint,
  to: Recipient,
  onStatus: (s: RelayStatus | "SIGNING") => void,
): Promise<{ paymentId: Hex; delivered: boolean }> {
  if (to.account === account.address) throw new FlowError("CannotPaySelf");
  const recipientSalt = randomBytes32();
  const t = await chainTime();
  const intent: PaymentIntent = {
    sender: account.address,
    mode: PaymentMode.USERNAME,
    recipientCommitment: recipientCommitment(PaymentMode.USERNAME, to.account, recipientSalt),
    metadataCommitment: NO_METADATA,
    approver: "0x0000000000000000000000000000000000000000",
    amount,
    expiresAt: t + MAX_EXPIRY_SECONDS,
    validAfter: 0n,
    validBefore: t + 3600n,
    salt: randomBytes32(),
  };
  const paymentId = paymentIdOf(config.escrow, intent, config.chainId);

  onStatus("SIGNING");
  const ausdSignature = await withSigner(account, (signer) => signer.signTypedData(fundingAuthorization(config.escrow, intent, config.chainId)));
  const r = await relayer("/v1/payments/create", { intent, ausdSignature });
  if (r.status !== 202 && r.status !== 200) throw new FlowError(r.body.error);
  const done = await waitForRequest(r.body.requestId, onStatus);
  if (done.status !== "CONFIRMED") throw new FlowError(done.error ?? "PaymentNotConfirmed");

  // Money is protected on-chain. Pin the recipient (first successful interaction) and deliver the inbox entry;
  // if delivery fails, Home keeps retrying from the saved record — never offer a second send.
  pin(to);
  const sent: SentPayment = {
    paymentId, amount: amount.toString(), to: `@${to.username}`, createdAt: Date.now(), expiresAt: intent.expiresAt.toString(),
    delivery: { recipient: to.account, recipientSalt, delivered: false },
  };
  rememberSent(sent);
  for (let attempt = 0; attempt < 3; attempt++) {
    if (await deliver(sent)) return { paymentId, delivered: true };
    await new Promise((res) => setTimeout(res, 1500));
  }
  return { paymentId, delivered: false };
}

/** Claim a username payment into the signed-in account. One fingerprint prompt. */
export async function claimUsernamePayment(account: Account, paymentId: Hex, recipientSalt: Hex, onStatus: (s: RelayStatus | "SIGNING") => void): Promise<void> {
  const actionNonce = randomBytes32();
  const deadline = (await chainTime()) + 600n;
  onStatus("SIGNING");
  const recipientSig = await withSigner(account, (signer) =>
    signer.signTypedData(claimIntent(config.escrow, { paymentId, recipient: account.address, actionNonce, deadline }, config.chainId)),
  );
  const r = await relayer("/v1/payments/claim-username", { paymentId, recipient: account.address, recipientSalt, actionNonce, deadline, recipientSig });
  if (r.status !== 202 && r.status !== 200) throw new FlowError(r.body.error);
  const done = await waitForRequest(r.body.requestId, onStatus);
  if (done.status !== "CONFIRMED") throw new FlowError(done.error ?? "NotConfirmed");
}
