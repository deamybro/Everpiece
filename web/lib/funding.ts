import { getAddress, type Address } from "viem";
import { tokenFor, type FundingPhase, type FundingSource, type RouteQuote, type TokenInfo } from "@everpiece/shared";
import { config } from "./config";
import { relayer, type RelayStatus } from "./api";
import { PayError, balanceOfToken, getQuote, payInstant } from "./pay";
import type { Account } from "./mera";

/**
 * "Add Dollars from another chain" (Aurora Intents; docs/FUNDING.md). USDC the payer holds elsewhere is moved by
 * Aurora to their OWN Everpiece account on Monad, then one prompt converts it to exactly the Dollars they asked for.
 * The test site runs a SIMULATED Aurora (config.funding === "simulated"): nothing crosses a chain there.
 */
export const fundingMode = () => config.funding;
export const fundingAvailable = () => config.funding !== "off" && Boolean(config.pay);

export type Sources = { sources: FundingSource[]; destination: TokenInfo };
export type TopUpQuote = {
  depositAddress: Address;
  amountIn: bigint;
  minAmountIn: bigint;
  amountOut: bigint;
  deadline: string;
  timeEstimateSec: number;
  amountInUsd: string | null;
  amountOutUsd: string | null;
};
export type TopUp = {
  depositAddress: Address;
  dollars: string; // base units
  origin: FundingSource;
  amountIn: string;
  deadline: string;
  createdAt: number;
  returnTo?: string;
  phase?: FundingPhase;
  done?: boolean;
};

async function get(path: string) {
  const r = await fetch(`${config.relayerUrl}${path}`).catch(() => null);
  if (!r) throw new PayError("NETWORK_UNAVAILABLE");
  const body = (await r.json().catch(() => ({}))) as Record<string, unknown>;
  if (r.status !== 200) throw new PayError(String(body.error ?? "PROVIDER_UNAVAILABLE"));
  return body;
}

export async function loadSources(): Promise<Sources> {
  const b = await get("/v1/funding/sources");
  const destination = tokenFor(config.chainId, String(b.destinationToken));
  // the relayer delivers only a token this app can convert; anything else is refused here too
  if (!destination || destination.route !== "AGORA_INSTANT_SETTLEMENT") throw new PayError("NO_ROUTE");
  return { sources: b.sources as FundingSource[], destination };
}

/** How much of the destination token must arrive so that converting gives `dollars` (what's already there counts). */
export async function plan(account: Account, dollars: bigint, destination: TokenInfo): Promise<{ conversion: RouteQuote; have: bigint; needed: bigint }> {
  const conversion = await getQuote(destination, dollars, account.address, account.address);
  const have = await balanceOfToken(destination.address, account.address);
  const needed = conversion.maxSellAmount > have ? conversion.maxSellAmount - have : 0n;
  return { conversion, have, needed };
}

export async function quoteTopUp(origin: FundingSource, amountOut: bigint, recipient: Address, refundTo: Address): Promise<TopUpQuote> {
  const r = await relayer("/v1/funding/quote", { originAssetId: origin.assetId, amountOut: amountOut.toString(), recipient, refundTo }).catch(() => null);
  if (!r) throw new PayError("NETWORK_UNAVAILABLE");
  if (r.status !== 200) throw new PayError(r.body.error ?? "PROVIDER_UNAVAILABLE");
  const q = r.body.quote as Record<string, string | number | null>;
  const out: TopUpQuote = {
    depositAddress: getAddress(String(q.depositAddress)), amountIn: BigInt(String(q.amountIn)), minAmountIn: BigInt(String(q.minAmountIn)),
    amountOut: BigInt(String(q.amountOut)), deadline: String(q.deadline), timeEstimateSec: Number(q.timeEstimateSec ?? 0),
    amountInUsd: (q.amountInUsd as string | null) ?? null, amountOutUsd: (q.amountOutUsd as string | null) ?? null,
  };
  // never show a quote that delivers anywhere but this account, or less than needed
  if (getAddress(String(q.recipient)) !== getAddress(recipient) || out.amountOut < amountOut) throw new PayError("BAD_QUOTE");
  return out;
}

export async function topUpStatus(depositAddress: Address): Promise<FundingPhase> {
  const b = await get(`/v1/funding/status?depositAddress=${depositAddress}`);
  return b.phase as FundingPhase;
}

/** Tell Aurora which transaction paid the deposit (optional, speeds detection). Simulated mode uses a dummy hash. */
export async function reportDeposit(depositAddress: Address, txHash: string): Promise<FundingPhase> {
  const r = await relayer("/v1/funding/deposit", { depositAddress, txHash }).catch(() => null);
  if (!r) throw new PayError("NETWORK_UNAVAILABLE");
  if (r.status !== 200) throw new PayError(r.body.error ?? "PROVIDER_UNAVAILABLE");
  return r.body.phase as FundingPhase;
}
export const simulatedDepositHash = () => `0x${Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) => b.toString(16).padStart(2, "0")).join("")}`;

/** One prompt: the arrived token → exactly `dollars` in this account (EverpiecePay through Agora, to yourself). */
export async function convertToDollars(account: Account, dollars: bigint, destination: TokenInfo, onStatus: (s: RelayStatus | "SIGNING") => void) {
  const quote = await getQuote(destination, dollars, account.address, account.address);
  return payInstant(account, { recipient: account.address, amount: dollars, token: destination, quote }, onStatus);
}

// ── in-progress top-ups survive reloads (this device) ──────────────────────────────────────────────────────────
const KEY = "everpiece.topups.v1";
export function loadTopUps(): TopUp[] {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? "[]") as TopUp[];
  } catch {
    return [];
  }
}
export function saveTopUp(t: TopUp) {
  try {
    const all = loadTopUps().filter((x) => x.depositAddress !== t.depositAddress);
    localStorage.setItem(KEY, JSON.stringify([t, ...all].slice(0, 20)));
  } catch {
    /* storage unavailable: the page still works while open */
  }
}
export const activeTopUps = () => loadTopUps().filter((t) => !t.done);
