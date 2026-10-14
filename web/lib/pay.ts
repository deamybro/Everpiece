import { getAddress, hexToSignature, recoverTypedDataAddress, type Address, type Hex } from "viem";
import {
  RequestMode,
  instantAusdAuthorization,
  instantPaymentId,
  instantPaymentTyped,
  payableTokens,
  paymentRequestTyped,
  permitTyped,
  requestProblem,
  type InstantPayment,
  type PaymentRequest,
  type RouteQuote,
  type TokenInfo,
} from "@everpiece/shared";
import { config } from "./config";
import { chainTime, client } from "./chain";
import { directory, relayer, waitForRequest, type RelayStatus } from "./api";
import { randomBytes32 } from "./link";
import { withSigner, type Account } from "./mera";
import { verifiedRecord, type Recipient } from "./username";

/**
 * Instant payments (EverpiecePay) and payment requests. The recipient always receives EXACTLY the AUSD amount; the
 * payer pays in AUSD, or in a token with a live Agora Instant Settlement route (testnet: CTK). Instant = final, no undo.
 */

export class PayError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(code);
    this.code = code;
  }
}

export const instantAvailable = () => Boolean(config.pay);
/** Tokens this deployment can actually route (anything else is never offered). */
export const payTokens = (): TokenInfo[] =>
  payableTokens(config.chainId).filter((t) => t.route === "DIRECT_AUSD" ? t.address.toLowerCase() === config.dollar.address.toLowerCase() : instantAvailable());

const erc20 = [
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "nonces", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] },
] as const;
export const balanceOfToken = (token: Address, who: Address) => client.readContract({ address: token, abi: erc20, functionName: "balanceOf", args: [who] });

type WireQuote = Record<keyof RouteQuote, string | number | boolean>;
/** A real quote from the relayer (pair getAmountsIn on-chain); never computed in the browser. */
export async function getQuote(token: TokenInfo, buyAmount: bigint, recipient: Address, sender: Address): Promise<RouteQuote> {
  const r = await relayer("/v1/quotes", { sellToken: token.address, buyAmount, recipient, sender }).catch(() => null);
  if (!r) throw new PayError("NETWORK_UNAVAILABLE");
  if (r.status !== 200) throw new PayError(r.body.error ?? "PROVIDER_UNAVAILABLE");
  const q = r.body.quote as WireQuote;
  return {
    ...(q as unknown as RouteQuote),
    buyAmount: BigInt(q.buyAmount as string), sellAmount: BigInt(q.sellAmount as string), maxSellAmount: BigInt(q.maxSellAmount as string),
    providerFee: BigInt(q.providerFee as string), networkFee: BigInt(q.networkFee as string),
  };
}

/**
 * Pay `amount` AUSD to `recipient` now, from `token`. One passkey prompt signs everything: for AUSD a single ERC-3009
 * authorization bound to the whole payment; for a token its permit plus the payment itself (the permit alone doesn't
 * name the recipient). `ref` ties the payment to a request (or is random). Resolves only once CONFIRMED at finality.
 */
export async function payInstant(
  account: Account,
  args: { recipient: Address; amount: bigint; token: TokenInfo; ref?: Hex; quote?: RouteQuote },
  onStatus: (s: RelayStatus | "SIGNING") => void,
): Promise<{ paymentId: Hex; payment: InstantPayment; txHash: Hex | null; sourceAmountMax: bigint }> {
  if (!config.pay) throw new PayError("PROVIDER_UNAVAILABLE");
  const { recipient, amount, token } = args;
  const direct = token.route === "DIRECT_AUSD";
  if (!direct && !args.quote) throw new PayError("NO_ROUTE");
  if (args.quote && args.quote.expiresAt * 1000 < Date.now()) throw new PayError("QUOTE_EXPIRED");
  const maxSource = direct ? amount : args.quote!.maxSellAmount;
  const have = await balanceOfToken(token.address, account.address);
  if (have < maxSource) throw new PayError("INSUFFICIENT_BALANCE");

  const deadline = (await chainTime()) + 600n;
  const payment: InstantPayment = {
    ref: args.ref ?? randomBytes32(), sender: account.address, recipient: getAddress(recipient), amount,
    sourceToken: token.address, maxSourceAmount: maxSource, deadline,
  };
  const paymentId = instantPaymentId(config.pay, payment, config.chainId);
  onStatus("SIGNING");
  let r;
  if (direct) {
    const ausdSignature = await withSigner(account, (signer) => signer.signTypedData(instantAusdAuthorization(config.pay, payment, config.chainId, token.address)), { spend: payment.amount });
    r = await relayer("/v1/pay/ausd", { payment, ausdSignature });
  } else {
    const nonce = await client.readContract({ address: token.address, abi: erc20, functionName: "nonces", args: [account.address] });
    const { permitSig, payerSignature } = await withSigner(account, async (signer) => ({
      permitSig: await signer.signTypedData(permitTyped(token, account.address, config.pay, maxSource, nonce, deadline)),
      payerSignature: await signer.signTypedData(instantPaymentTyped(config.pay, payment, config.chainId)),
    }), { spend: maxSource });
    const { r: pr, s: ps, v } = hexToSignature(permitSig);
    r = await relayer("/v1/pay/token", { payment, payerSignature, permit: { deadline, v: Number(v), r: pr, s: ps } });
  }
  if (r.status !== 202 && r.status !== 200) throw new PayError(r.body.error ?? "TRANSACTION_REVERTED");
  const done = await waitForRequest(r.body.requestId, onStatus);
  if (done.status !== "CONFIRMED") throw new PayError(done.error ?? "TRANSACTION_REVERTED");
  return { paymentId, payment, txHash: (done.txHash as Hex) ?? null, sourceAmountMax: maxSource };
}

// ── Payment requests ("Pay @maris $25" as a QR) ─────────────────────────────────────────────────────────────────
export type LoadedRequest = {
  request: PaymentRequest;
  recipient: Recipient;
  paid: { paymentId: Hex; kind: string } | null;
  /** Why it can't be paid (expired, wrong network, …), or null. */
  problem: string | null;
};

/** `asset`: what the requester receives. Instant requests may name USDC or AUSD (EverpiecePayV2); protected ones use
 *  the escrow's asset. */
export async function createRequest(account: Account, amount: bigint, mode: RequestMode, hours = 24, asset: Address = config.dollar.address): Promise<Hex> {
  const now = await chainTime();
  const request: PaymentRequest = {
    version: 1, requestId: randomBytes32(), recipient: account.address, asset: mode === RequestMode.PROTECTED ? config.dollar.address : asset, amount, mode,
    expiresAt: now + BigInt(hours * 3600), memoHash: `0x${"00".repeat(32)}`,
  };
  onlyAfter(requestProblem(request, now, config.chainId));
  const sig = await withSigner(account, (signer) => signer.signTypedData(paymentRequestTyped(config.directoryDomain, request, config.chainId)));
  const r = await directory("/v1/requests/create", { request, sig }).catch(() => null);
  if (!r) throw new PayError("NETWORK_UNAVAILABLE");
  if (r.status !== 201 && r.status !== 200) throw new PayError(r.body.error ?? "PROVIDER_UNAVAILABLE");
  return request.requestId;
}
function onlyAfter(problem: string | null) {
  if (problem) throw new PayError(problem);
}

/**
 * Resolve a scanned/opened request and verify it before anything is shown: the recipient's own signature over every
 * field, their signed @username record, then format/expiry/network. A tampered request is REQUEST_TAMPERED.
 */
export async function loadRequest(requestId: Hex): Promise<LoadedRequest> {
  const r = await directory("/v1/requests/get", { requestId }).catch(() => null);
  if (!r) throw new PayError("NETWORK_UNAVAILABLE");
  if (r.status === 404) throw new PayError("UNKNOWN_REQUEST");
  if (r.status !== 200) throw new PayError(r.body.error ?? "PROVIDER_UNAVAILABLE");
  const w = r.body.request as Record<string, string | number>;
  const request: PaymentRequest = {
    version: Number(w.version), requestId: w.requestId as Hex, recipient: getAddress(w.recipient as string), asset: getAddress(w.asset as string),
    amount: BigInt(w.amount), mode: Number(w.mode) as RequestMode, expiresAt: BigInt(w.expiresAt), memoHash: w.memoHash as Hex,
  };
  if (request.requestId.toLowerCase() !== requestId.toLowerCase()) throw new PayError("REQUEST_TAMPERED");
  const signer = await recoverTypedDataAddress({ ...paymentRequestTyped(config.directoryDomain, request, config.chainId), signature: r.body.sig as Hex }).catch(() => null);
  if (!signer || getAddress(signer) !== request.recipient) throw new PayError("REQUEST_TAMPERED");
  const recipient = await verifiedRecord(r.body.recipientRecord).catch(() => null);
  if (!recipient || recipient.account !== request.recipient) throw new PayError("REQUEST_TAMPERED");
  const now = await chainTime().catch(() => BigInt(Math.floor(Date.now() / 1000)));
  return { request, recipient, paid: (r.body.paid as LoadedRequest["paid"]) ?? null, problem: requestProblem(request, now, config.chainId) };
}

/** Tell the directory the request is paid, with the proof it checks on-chain. Best effort, retried; never throws. */
export async function reportPaid(body: Record<string, unknown>): Promise<boolean> {
  for (let i = 0; i < 4; i++) {
    const r = await directory("/v1/requests/paid", body).catch(() => null);
    if (r?.status === 200) return true;
    if (r && r.status !== 422 && r.status !== 503 && r.status !== 429) return false;
    await new Promise((res) => setTimeout(res, 2500));
  }
  return false;
}

export const requestLink = (requestId: Hex) => `${window.location.origin}/pay/${requestId}`;
export { RequestMode };
