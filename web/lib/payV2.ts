import { decodeEventLog, getAddress, type Address, type Hex } from "viem";
import {
  defaultSettlementAsset,
  everpiecePayV2Abi,
  paymentV2Authorization,
  paymentV2Id,
  paymentV2Problem,
  routeOf,
  settlementAsset,
  settlementAssetsFor,
  type ConversionQuote,
  type PaymentV2,
  type SettlementAsset,
} from "@everpiece/shared";
import { config, flags } from "./config";
import { chainTime, client } from "./chain";
import { relayer, waitForRequest, type RelayStatus } from "./api";
import { randomBytes32 } from "./link";
import { withSigner, type Account } from "./mera";
import { PayError, balanceOfToken } from "./pay";

/**
 * USDC + AUSD instant payments (EverpiecePayV2). The recipient receives EXACTLY the amount of the asset they chose.
 * Same asset = direct. Other asset = converted on-chain (Agora when it has approved Everpiece, else the fixed Uniswap v4
 * pool), with an optional truthful fallback: if no conversion can deliver, the recipient gets the payer's asset and
 * every screen says so. One passkey prompt; the relayer can't change any term.
 */

export const payV2Available = () => Boolean(config.payV2);

/** Assets this deployment can settle in, honouring the USDC/AUSD feature flags (USDC first: the default). */
export function enabledAssets(): SettlementAsset[] {
  return settlementAssetsFor(config.chainId).filter((a) => (a.symbol === "USDC" ? flags.USDC_PAYMENTS_ENABLED : flags.AUSD_PAYMENTS_ENABLED));
}
export const defaultAsset = (): SettlementAsset | undefined => {
  const d = defaultSettlementAsset(config.chainId);
  return d && enabledAssets().includes(d) ? d : enabledAssets()[0];
};
export const assetSymbol = (address: string) => settlementAsset(config.chainId, address)?.symbol ?? "Dollars";

export type QuoteV2 = {
  route: "DIRECT" | "CONVERTED";
  available: boolean;
  provider: "AGORA" | "UNISWAP_V4" | null;
  sourceAmount: bigint | null;
  maxSourceAmount: bigint | null;
  /** When conversion is unavailable: the most the payer authorizes for the fallback (= amount, 1:1 in the source). */
  fallbackMaxSourceAmount?: bigint;
  providers: ConversionQuote[];
  expiresAt: number;
};

const big = (v: unknown) => (v === null || v === undefined ? null : BigInt(v as string));

/** A real quote from the relayer (on-chain Agora quote + Uniswap's own v4 Quoter). Never computed in the browser. */
export async function quoteV2(sourceToken: Address, asset: Address, amount: bigint): Promise<QuoteV2> {
  if (routeOf(asset, sourceToken) === "DIRECT") {
    return { route: "DIRECT", available: true, provider: null, sourceAmount: amount, maxSourceAmount: amount, providers: [], expiresAt: Math.floor(Date.now() / 1000) + 600 };
  }
  const r = await relayer("/v1/quotes/v2", { sourceToken, asset, amount }).catch(() => null);
  if (!r) throw new PayError("NETWORK_UNAVAILABLE");
  if (r.status !== 200) throw new PayError(r.body.error ?? "PROVIDER_UNAVAILABLE");
  const q = r.body.quote as Record<string, unknown>;
  return {
    route: q.route as QuoteV2["route"],
    available: Boolean(q.available),
    provider: (q.provider as QuoteV2["provider"]) ?? null,
    sourceAmount: big(q.sourceAmount),
    maxSourceAmount: big(q.maxSourceAmount),
    fallbackMaxSourceAmount: big(q.fallbackMaxSourceAmount) ?? undefined,
    providers: ((q.providers as Record<string, unknown>[]) ?? []).map((p) => ({ ...(p as ConversionQuote), sourceAmount: big(p.sourceAmount) })),
    expiresAt: Number(q.expiresAt),
  };
}

export type PayV2Result = {
  paymentId: Hex;
  payment: PaymentV2;
  txHash: Hex | null;
  /** What the recipient actually received, read from the on-chain Paid event (never assumed). */
  deliveredAsset: Address;
  sourceSpent: bigint;
  provider: Address;
  fellBack: boolean;
};

/**
 * Pay `amount` of `asset` to `recipient` from `sourceToken`. Converted payments need a live quote; with
 * `allowFallback`, an unavailable conversion delivers the source asset instead (the payer sees this before signing).
 */
export async function payV2(
  account: Account,
  args: { recipient: Address; asset: Address; amount: bigint; sourceToken: Address; quote?: QuoteV2; allowFallback?: boolean; ref?: Hex },
  onStatus: (s: RelayStatus | "SIGNING") => void,
): Promise<PayV2Result> {
  if (!config.payV2) throw new PayError("PROVIDER_UNAVAILABLE");
  const route = routeOf(args.asset, args.sourceToken);
  let maxSource = args.amount;
  let fallbackToSource = false;
  if (route === "CONVERTED") {
    const q = args.quote;
    if (!q) throw new PayError("NO_ROUTE");
    if (q.expiresAt * 1000 < Date.now()) throw new PayError("QUOTE_EXPIRED");
    if (q.available && q.maxSourceAmount) {
      maxSource = q.maxSourceAmount;
      fallbackToSource = Boolean(args.allowFallback);
      if (fallbackToSource && maxSource < args.amount) maxSource = args.amount; // the fallback must fit the authorization
    } else if (args.allowFallback) {
      maxSource = q.fallbackMaxSourceAmount ?? args.amount;
      fallbackToSource = true;
    } else {
      throw new PayError("NO_ROUTE");
    }
  }
  const have = await balanceOfToken(args.sourceToken, account.address);
  if (have < maxSource) throw new PayError("INSUFFICIENT_BALANCE");

  const payment: PaymentV2 = {
    ref: args.ref ?? randomBytes32(),
    sender: account.address,
    recipient: getAddress(args.recipient),
    asset: getAddress(args.asset),
    amount: args.amount,
    sourceToken: getAddress(args.sourceToken),
    maxSourceAmount: maxSource,
    deadline: (await chainTime()) + 600n,
    fallbackToSource,
  };
  const problem = paymentV2Problem(payment, config.chainId, (await chainTime()) - 1n);
  if (problem) throw new PayError(problem);
  const paymentId = paymentV2Id(config.payV2, payment, config.chainId);
  onStatus("SIGNING");
  const signature = await withSigner(account, (signer) => signer.signTypedData(paymentV2Authorization(config.payV2, payment, config.chainId)));
  const r = await relayer(route === "DIRECT" ? "/v1/pay/v2/direct" : "/v1/pay/v2/convert", { payment, signature });
  if (r.status !== 202 && r.status !== 200) throw new PayError(r.body.error ?? "TRANSACTION_REVERTED");
  const done = await waitForRequest(r.body.requestId, onStatus);
  if (done.status !== "CONFIRMED") throw new PayError(done.error ?? "TRANSACTION_REVERTED");
  const txHash = (done.txHash as Hex) ?? null;
  const paid = txHash ? await paidEvent(txHash, paymentId) : null;
  if (!paid) throw new PayError("RECEIPT_UNAVAILABLE");
  return describeDelivery({ paymentId, payment, txHash, ...paid });
}

/** The Paid event of `paymentId` in a transaction: the truth about what was delivered. */
export async function paidEvent(txHash: Hex, paymentId: Hex) {
  const receipt = await client.getTransactionReceipt({ hash: txHash });
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== config.payV2.toLowerCase()) continue;
    try {
      const ev = decodeEventLog({ abi: everpiecePayV2Abi, data: log.data, topics: log.topics });
      if (ev.eventName === "Paid" && ev.args.paymentId.toLowerCase() === paymentId.toLowerCase()) {
        const deliveredAsset = getAddress(ev.args.deliveredAsset);
        return { deliveredAsset, sourceSpent: ev.args.sourceAmount, provider: getAddress(ev.args.provider), fellBack: false };
      }
    } catch {
      /* another event */
    }
  }
  return null;
}

/** Fill in `fellBack` from the payment terms: delivered ≠ requested. */
export const describeDelivery = (r: PayV2Result) => ({ ...r, fellBack: r.deliveredAsset.toLowerCase() !== r.payment.asset.toLowerCase() });

/** Balances of every enabled asset (USDC first). */
export async function assetBalances(who: Address): Promise<{ asset: SettlementAsset; balance: bigint }[]> {
  return Promise.all(enabledAssets().map(async (asset) => ({ asset, balance: await balanceOfToken(asset.address, who).catch(() => 0n) })));
}
