import { encodeFunctionData, getAddress, recoverTypedDataAddress, type Address, type Hex } from "viem";
import {
  PaymentMode,
  PaymentStatus,
  cancelIntent,
  claimApproval,
  claimIntent,
  everpieceEscrowAbi,
  fundingAuthorization,
  linkClaimIntent,
  paymentIdOf,
} from "@everpiece/shared";
import type { Method, RelayerConfig } from "./config.ts";
import { readPayment, type Chain } from "./chain.ts";
import { parseCancel, parseClaimLink, parseClaimUsername, parseCreate, parseRefund } from "./validate.ts";

/** Refused before any RPC-costly step; `code` is returned to the client. */
export class PrecheckError extends Error {
  readonly httpStatus: number;
  readonly code: string;
  constructor(httpStatus: number, code: string) {
    super(code);
    this.httpStatus = httpStatus;
    this.code = code;
  }
}

export type EscrowEvent = "PaymentCreated" | "PaymentClaimed" | "PaymentCancelled" | "PaymentRefunded";

export type Prepared = {
  method: Method;
  args: readonly unknown[];
  data: Hex;
  signer: Address | null;
  paymentId: Hex;
  idemKey: string;
  expectedEvent: EscrowEvent;
  /** On-chain Status that must be observed at "finalized" for CONFIRMED. */
  expectedStatus: number;
};

async function signedBy(expected: Address, typed: Parameters<typeof recoverTypedDataAddress>[0]): Promise<boolean> {
  try {
    return getAddress(await recoverTypedDataAddress(typed)) === getAddress(expected);
  } catch {
    return false;
  }
}

function encode(method: Method, args: readonly unknown[]): Hex {
  return encodeFunctionData({ abi: everpieceEscrowAbi, functionName: method, args } as Parameters<typeof encodeFunctionData>[0]);
}

export async function prepare(method: Method, body: unknown, cfg: RelayerConfig, chain: Chain): Promise<Prepared> {
  const escrow = cfg.escrow;
  const chainId = chain.chainId;

  switch (method) {
    case "createPayment": {
      const { intent, ausdSignature } = parseCreate(body);
      if (intent.amount < cfg.minPaymentAmount) throw new PrecheckError(422, "BelowMinimumPayment");
      const funding = fundingAuthorization(escrow, intent, chainId, cfg.ausd);
      if (!(await signedBy(intent.sender, { ...funding, signature: ausdSignature }))) {
        throw new PrecheckError(401, "InvalidFundingSignature");
      }
      const paymentId = paymentIdOf(escrow, intent, chainId);
      const args = [intent, ausdSignature] as const;
      return {
        method, args, data: encode(method, args), signer: intent.sender, paymentId,
        idemKey: `${method}:${paymentId}`, expectedEvent: "PaymentCreated", expectedStatus: PaymentStatus.ACTIVE,
      };
    }

    case "claimUsernamePayment": {
      const p = parseClaimUsername(body);
      const typed = claimIntent(escrow, { paymentId: p.paymentId, recipient: p.recipient, actionNonce: p.actionNonce, deadline: p.deadline }, chainId);
      if (!(await signedBy(p.recipient, { ...typed, signature: p.recipientSig }))) {
        throw new PrecheckError(401, "InvalidRecipientSignature");
      }
      const args = [p.paymentId, p.recipient, p.recipientSalt, p.actionNonce, p.deadline, p.recipientSig] as const;
      return {
        method, args, data: encode(method, args), signer: p.recipient, paymentId: p.paymentId,
        idemKey: `${method}:${p.paymentId}:${p.recipient}:${p.actionNonce}`,
        expectedEvent: "PaymentClaimed", expectedStatus: PaymentStatus.CLAIMED,
      };
    }

    case "claimLinkPayment": {
      const p = parseClaimLink(body);
      const payment = await readPayment(cfg, chain, p.paymentId);
      if (payment.status !== PaymentStatus.ACTIVE || payment.mode !== PaymentMode.LINK) throw new PrecheckError(422, "PaymentNotClaimableByLink");
      const lc = linkClaimIntent(escrow, { paymentId: p.paymentId, recipient: p.recipient, actionNonce: p.actionNonce, deadline: p.deadline }, chainId);
      if (!(await signedBy(p.claimKey, { ...lc, signature: p.claimKeySig }))) throw new PrecheckError(401, "InvalidClaimKeySignature");
      const ap = claimApproval(escrow, { paymentId: p.paymentId, recipient: p.recipient, approvalNonce: p.approvalNonce, deadline: p.approvalDeadline }, chainId);
      if (!(await signedBy(payment.approver, { ...ap, signature: p.approverSig }))) throw new PrecheckError(401, "InvalidApproverSignature");
      const args = [
        p.paymentId, p.recipient, p.claimKey, p.recipientSalt, p.actionNonce, p.deadline,
        p.claimKeySig, p.approvalNonce, p.approvalDeadline, p.approverSig,
      ] as const;
      return {
        method, args, data: encode(method, args), signer: p.recipient, paymentId: p.paymentId,
        idemKey: `${method}:${p.paymentId}:${p.recipient}:${p.actionNonce}:${p.approvalNonce}`,
        expectedEvent: "PaymentClaimed", expectedStatus: PaymentStatus.CLAIMED,
      };
    }

    case "cancel": {
      const p = parseCancel(body);
      const payment = await readPayment(cfg, chain, p.paymentId);
      if (payment.status !== PaymentStatus.ACTIVE) throw new PrecheckError(422, "PaymentNotActive");
      const typed = cancelIntent(escrow, { paymentId: p.paymentId, sender: payment.sender, actionNonce: p.actionNonce, deadline: p.deadline }, chainId);
      if (!(await signedBy(payment.sender, { ...typed, signature: p.senderSig }))) throw new PrecheckError(401, "InvalidSenderSignature");
      const args = [p.paymentId, p.actionNonce, p.deadline, p.senderSig] as const;
      return {
        method, args, data: encode(method, args), signer: payment.sender, paymentId: p.paymentId,
        idemKey: `${method}:${p.paymentId}:${p.actionNonce}`, expectedEvent: "PaymentCancelled", expectedStatus: PaymentStatus.CANCELLED,
      };
    }

    case "refundExpired": {
      const p = parseRefund(body);
      const args = [p.paymentId] as const;
      return {
        method, args, data: encode(method, args), signer: null, paymentId: p.paymentId,
        idemKey: `${method}:${p.paymentId}`, expectedEvent: "PaymentRefunded", expectedStatus: PaymentStatus.REFUNDED,
      };
    }
  }
}
