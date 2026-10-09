import { encodeFunctionData, getAddress, recoverTypedDataAddress, type Address, type Hex } from "viem";
import {
  everpiecePayV2Abi,
  paymentV2Authorization,
  paymentV2Id,
  paymentV2Problem,
  routeOf,
  settlementAsset,
  AUSD_EIP712_NAME,
  PaymentMode,
  PaymentStatus,
  cancelIntent,
  claimApproval,
  claimIntent,
  everpieceEscrowAbi,
  everpiecePayAbi,
  fundingAuthorization,
  instantAusdAuthorization,
  instantPaymentId,
  instantPaymentTyped,
  tokenFor,
  linkClaimIntent,
  paymentIdOf,
  earnAusdAuthorization,
  earnDepositId,
  earnWithdrawalId,
  earnWithdrawalTyped,
  everpieceEarnAbi,
} from "@everpiece/shared";
import type { Method, RelayerConfig } from "./config.ts";
import { readPayment, type Chain } from "./chain.ts";
import { parseCancel, parseClaimLink, parseClaimUsername, parseCreate, parseEarnDeposit, parseEarnWithdraw, parsePayAusd, parsePayToken, parsePayV2, parseRefund } from "./validate.ts";

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

export type EscrowEvent = "PaymentCreated" | "PaymentClaimed" | "PaymentCancelled" | "PaymentRefunded" | "Paid" | "EarnDeposited" | "EarnWithdrawn";

export type Prepared = {
  method: Method;
  /** Contract function name when it differs from the relayer method (EverpieceEarn: deposit / withdraw). */
  fn?: string;
  args: readonly unknown[];
  data: Hex;
  signer: Address | null;
  paymentId: Hex;
  idemKey: string;
  expectedEvent: EscrowEvent;
  /** On-chain Status that must be observed at "finalized" for CONFIRMED (EverpiecePay: 1 = settled). */
  expectedStatus: number;
  /** Contract the transaction goes to (escrow or EverpiecePay), from config; never client-chosen. */
  target: Address;
  /** What the policy engine needs for money-moving actions. */
  money?: {
    sender: Address;
    recipient: Address | null;
    amount: bigint;
    sourceToken: Address;
    route: "DIRECT_AUSD" | "AGORA_INSTANT_SETTLEMENT" | "ESCROW" | "DIRECT" | "CONVERTED";
    mode: "INSTANT" | "PROTECTED";
  };
};

async function signedBy(expected: Address, typed: Parameters<typeof recoverTypedDataAddress>[0]): Promise<boolean> {
  try {
    return getAddress(await recoverTypedDataAddress(typed)) === getAddress(expected);
  } catch {
    return false;
  }
}

function encode(method: Method, args: readonly unknown[]): Hex {
  if (method === "earnDeposit" || method === "earnWithdraw") {
    const functionName = method === "earnDeposit" ? "deposit" : "withdraw";
    return encodeFunctionData({ abi: everpieceEarnAbi, functionName, args } as Parameters<typeof encodeFunctionData>[0]);
  }
  if (method === "payV2Direct" || method === "payV2Convert") {
    return encodeFunctionData({ abi: everpiecePayV2Abi, functionName: "pay", args } as Parameters<typeof encodeFunctionData>[0]);
  }
  const abi = method === "payWithAusd" || method === "payWithToken" ? everpiecePayAbi : everpieceEscrowAbi;
  return encodeFunctionData({ abi, functionName: method, args } as Parameters<typeof encodeFunctionData>[0]);
}

export async function prepare(method: Method, body: unknown, cfg: RelayerConfig, chain: Chain): Promise<Prepared> {
  const escrow = cfg.escrow;
  const chainId = chain.chainId;

  switch (method) {
    case "createPayment": {
      const { intent, ausdSignature } = parseCreate(body);
      if (intent.amount < cfg.minPaymentAmount) throw new PrecheckError(422, "BelowMinimumPayment");
      const funding = fundingAuthorization(escrow, intent, chainId, { address: cfg.ausd, eip712Name: cfg.ausdEip712Name ?? AUSD_EIP712_NAME, eip712Version: "1" });
      if (!(await signedBy(intent.sender, { ...funding, signature: ausdSignature }))) {
        throw new PrecheckError(401, "InvalidFundingSignature");
      }
      const paymentId = paymentIdOf(escrow, intent, chainId);
      const args = [intent, ausdSignature] as const;
      return {
        method, args, data: encode(method, args), signer: intent.sender, paymentId,
        idemKey: `${method}:${paymentId}`, expectedEvent: "PaymentCreated", expectedStatus: PaymentStatus.ACTIVE, target: escrow,
        money: { sender: intent.sender, recipient: null, amount: intent.amount, sourceToken: cfg.ausd, route: "ESCROW", mode: "PROTECTED" },
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
        expectedEvent: "PaymentClaimed", expectedStatus: PaymentStatus.CLAIMED, target: escrow,
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
        expectedEvent: "PaymentClaimed", expectedStatus: PaymentStatus.CLAIMED, target: escrow,
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
        idemKey: `${method}:${p.paymentId}:${p.actionNonce}`, expectedEvent: "PaymentCancelled", expectedStatus: PaymentStatus.CANCELLED, target: escrow,
      };
    }

    case "refundExpired": {
      const p = parseRefund(body);
      const args = [p.paymentId] as const;
      return {
        method, args, data: encode(method, args), signer: null, paymentId: p.paymentId,
        idemKey: `${method}:${p.paymentId}`, expectedEvent: "PaymentRefunded", expectedStatus: PaymentStatus.REFUNDED, target: escrow,
      };
    }

    case "payWithAusd": {
      if (!cfg.pay) throw new PrecheckError(503, "InstantPaymentsUnavailable");
      const { payment, ausdSignature } = parsePayAusd(body);
      if (payment.sourceToken !== cfg.ausd) throw new PrecheckError(422, "UNSUPPORTED_TOKEN");
      if (payment.amount < cfg.minPaymentAmount) throw new PrecheckError(422, "BelowMinimumPayment");
      const auth = instantAusdAuthorization(cfg.pay, payment, chainId, cfg.ausd);
      if (!(await signedBy(payment.sender, { ...auth, signature: ausdSignature }))) throw new PrecheckError(401, "InvalidFundingSignature");
      const paymentId = instantPaymentId(cfg.pay, payment, chainId);
      const args = [payment, ausdSignature] as const;
      return {
        method, args, data: encode(method, args), signer: payment.sender, paymentId, idemKey: `${method}:${paymentId}`,
        expectedEvent: "Paid", expectedStatus: 1, target: cfg.pay,
        money: { sender: payment.sender, recipient: payment.recipient, amount: payment.amount, sourceToken: cfg.ausd, route: "DIRECT_AUSD", mode: "INSTANT" },
      };
    }

    case "payWithToken": {
      if (!cfg.pay) throw new PrecheckError(503, "InstantPaymentsUnavailable");
      const { payment, payerSignature, permit } = parsePayToken(body);
      const token = tokenFor(chainId, payment.sourceToken);
      if (!token || token.route !== "AGORA_INSTANT_SETTLEMENT") throw new PrecheckError(422, "UNSUPPORTED_TOKEN");
      if (payment.amount < cfg.minPaymentAmount) throw new PrecheckError(422, "BelowMinimumPayment");
      // the permit alone doesn't bind the recipient: the payer signs the whole Payment too
      const typed = instantPaymentTyped(cfg.pay, payment, chainId);
      if (!(await signedBy(payment.sender, { ...typed, signature: payerSignature }))) throw new PrecheckError(401, "InvalidPayerSignature");
      const paymentId = instantPaymentId(cfg.pay, payment, chainId);
      const args = [payment, payerSignature, permit.deadline, permit.v, permit.r, permit.s] as const;
      return {
        method, args, data: encode(method, args), signer: payment.sender, paymentId, idemKey: `${method}:${paymentId}`,
        expectedEvent: "Paid", expectedStatus: 1, target: cfg.pay,
        money: { sender: payment.sender, recipient: payment.recipient, amount: payment.amount, sourceToken: payment.sourceToken, route: "AGORA_INSTANT_SETTLEMENT", mode: "INSTANT" },
      };
    }

    // EverpiecePayV2: USDC and AUSD first-class. DIRECT = same asset; CONVERTED = Agora / fixed v4 converter, with an
    // optional truthful fallback to the source asset. The payer's one signature binds every term (nonce = payment id).
    case "payV2Direct":
    case "payV2Convert": {
      if (!cfg.payV2) throw new PrecheckError(503, "InstantPaymentsUnavailable");
      const { payment, signature } = parsePayV2(body);
      const problem = paymentV2Problem(payment, chainId, BigInt(Math.floor(Date.now() / 1000)));
      if (problem) throw new PrecheckError(422, problem);
      const route = routeOf(payment.asset, payment.sourceToken);
      if ((method === "payV2Direct") !== (route === "DIRECT")) throw new PrecheckError(422, "WRONG_ROUTE_ENDPOINT");
      if (payment.amount < cfg.minPaymentAmount) throw new PrecheckError(422, "BelowMinimumPayment");
      const assetSymbol = settlementAsset(chainId, payment.asset)?.symbol;
      const sourceSymbol = settlementAsset(chainId, payment.sourceToken)?.symbol;
      for (const sym of [assetSymbol, sourceSymbol]) {
        if (sym === "USDC" && !cfg.flags.USDC_PAYMENTS_ENABLED) throw new PrecheckError(503, "USDC_PAYMENTS_DISABLED");
        if (sym === "AUSD" && !cfg.flags.AUSD_PAYMENTS_ENABLED) throw new PrecheckError(503, "AUSD_PAYMENTS_DISABLED");
      }
      // conversions switched off: only the truthful fallback (deliver the source asset) remains
      if (route === "CONVERTED" && !cfg.flags.AGORA_SETTLEMENT_ENABLED && !cfg.flags.DEX_AUSD_FALLBACK_ENABLED && !payment.fallbackToSource) {
        throw new PrecheckError(503, "CONVERSION_DISABLED");
      }
      if (route === "CONVERTED" && payment.maxSourceAmount * 10_000n > payment.amount * (10_000n + cfg.maxConvertSlippageBps)) {
        throw new PrecheckError(422, "SLIPPAGE_ABOVE_LIMIT");
      }
      const auth = paymentV2Authorization(cfg.payV2, payment, chainId);
      if (!(await signedBy(payment.sender, { ...auth, signature }))) throw new PrecheckError(401, "InvalidFundingSignature");
      const paymentId = paymentV2Id(cfg.payV2, payment, chainId);
      const args = [payment, signature] as const;
      return {
        method, fn: "pay", args, data: encode(method, args), signer: payment.sender, paymentId, idemKey: `payV2:${paymentId}`,
        expectedEvent: "Paid", expectedStatus: 1, target: cfg.payV2,
        money: { sender: payment.sender, recipient: payment.recipient, amount: payment.amount, sourceToken: payment.sourceToken, route, mode: "INSTANT" },
      };
    }

    // Earn: the owner's own money into / out of the owner's own position (EverpieceEarn hard-wires shares and assets
    // to the owner). The vault list is fixed in the contract; simulation refuses any other vault.
    case "earnDeposit": {
      if (!cfg.earn) throw new PrecheckError(503, "EarnUnavailable");
      const { deposit, ausdSignature } = parseEarnDeposit(body);
      if (deposit.assets < cfg.minPaymentAmount) throw new PrecheckError(422, "BelowMinimumPayment");
      const auth = earnAusdAuthorization(cfg.earn, chainId, deposit, cfg.ausd, cfg.ausdEip712Name);
      if (!(await signedBy(deposit.owner, { ...auth, signature: ausdSignature }))) throw new PrecheckError(401, "InvalidFundingSignature");
      const id = earnDepositId(cfg.earn, chainId, deposit);
      const args = [deposit, ausdSignature] as const;
      return {
        method, fn: "deposit", args, data: encode(method, args), signer: deposit.owner, paymentId: id, idemKey: `${method}:${id}`,
        expectedEvent: "EarnDeposited", expectedStatus: 1, target: cfg.earn,
      };
    }

    case "earnWithdraw": {
      if (!cfg.earn) throw new PrecheckError(503, "EarnUnavailable");
      const { withdrawal, ownerSignature, permit } = parseEarnWithdraw(body);
      const typed = earnWithdrawalTyped(cfg.earn, chainId, withdrawal);
      if (!(await signedBy(withdrawal.owner, { ...typed, signature: ownerSignature }))) throw new PrecheckError(401, "InvalidOwnerSignature");
      const id = earnWithdrawalId(cfg.earn, chainId, withdrawal);
      const args = [withdrawal, ownerSignature, permit.v, permit.r, permit.s] as const;
      return {
        method, fn: "withdraw", args, data: encode(method, args), signer: withdrawal.owner, paymentId: id, idemKey: `${method}:${id}`,
        expectedEvent: "EarnWithdrawn", expectedStatus: 1, target: cfg.earn,
      };
    }
  }
}
