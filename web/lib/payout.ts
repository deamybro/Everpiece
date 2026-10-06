import { getAddress, recoverTypedDataAddress, type Address, type Hex } from "viem";
import {
  PAYOUT_REQUEST_VERSION, payoutAccountHashOf, payoutWithinQuote, payoutAccountProblem, payoutAccountTyped, payoutRequestProblem, payoutRequestTyped,
  type PayoutAccount, type PayoutRequest, type PayoutState,
} from "@everpiece/shared";
import { config } from "./config";
import { chainTime } from "./chain";
import { randomBytes32 } from "./link";
import { withSigner, type Account } from "./mera";
import { PayError, payInstant, payTokens } from "./pay";
import type { RelayStatus } from "./api";

/**
 * The last mile (docs/PAYOUT.md): "Maris receives at least ₦50,000 in her bank account". The recipient signs where
 * their money may go and how much they ask for; the sender's app checks both signatures before showing anything.
 */
export const payoutAvailable = () => Boolean(config.payoutUrl && config.pay);
export const payoutSimulated = () => config.payoutSimulated;

export type Institution = { name: string; code: string; type: string };
export type SignedAccount = { record: PayoutAccount; sig: Hex; institutionName: string | null };
export type PublicOrder = {
  orderId: string; requestId: Hex; state: PayoutState; receiveAddress: Address; amountToTransfer: string; amountToTransferUnits: string | null;
  currency: string; validUntil: string; simulated: boolean;
  recipient?: Address | null; fiatAmount?: string | null;
  /** Every state with the time it was first seen: the progress timeline. */
  history?: { state: PayoutState; at: number }[];
};
export type LoadedPayoutRequest = { request: PayoutRequest; sig: Hex; account: SignedAccount; order: PublicOrder | null };

async function api(method: "GET" | "POST", path: string, body?: unknown, retried = false): Promise<Record<string, any>> {
  const r = await fetch(`${config.payoutUrl}${path}`, {
    method, headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body, (_k, v) => (typeof v === "bigint" ? v.toString() : v)) : undefined,
  }).catch(() => null);
  if (!r) throw new PayError("NETWORK_UNAVAILABLE");
  const j = (await r.json().catch(() => ({}))) as Record<string, any>;
  // a 429 is refused before anything happens: safe to retry once
  if (r.status === 429 && !retried) {
    await new Promise((res) => setTimeout(res, 1500));
    return api(method, path, body, true);
  }
  if (r.status >= 300) throw new PayError(String(j.error ?? "PROVIDER_UNAVAILABLE"));
  return j;
}
const accountOf = (w: Record<string, any>): PayoutAccount => ({ ...w, account: getAddress(w.account), deadline: BigInt(w.deadline) }) as PayoutAccount;
const requestOf = (w: Record<string, any>): PayoutRequest => ({
  version: Number(w.version), requestId: String(w.requestId).toLowerCase() as Hex, recipient: getAddress(w.recipient), currency: w.currency,
  fiatAmount: BigInt(w.fiatAmount), payoutAccountHash: w.payoutAccountHash, expiresAt: BigInt(w.expiresAt),
});

export const institutions = async (): Promise<Institution[]> => (await api("GET", "/v1/payout/institutions?currency=NGN")).institutions;

/** Recipient: check the account with the bank (returns the verified name to confirm). */
export async function checkBankAccount(account: Account, institution: string, accountNumber: string) {
  const r = await api("POST", "/v1/payout/accounts/prepare", { account: account.address, institution, accountNumber });
  return { prepareId: String(r.prepareId), record: accountOf(r.record), institutionName: String(r.institutionName) };
}
/** Recipient: one prompt signs "my money may be paid out to this account". */
export async function saveBankAccount(account: Account, prepareId: string, record: PayoutAccount): Promise<SignedAccount> {
  const sig = await withSigner(account, (s) => s.signTypedData(payoutAccountTyped(config.directoryDomain, record, config.chainId)));
  await api("POST", "/v1/payout/accounts", { prepareId, record, sig });
  return { record, sig, institutionName: null };
}

/** A signed payout destination, checked here: the account itself signed exactly this record. */
async function verifiedAccount(w: Record<string, any> | null | undefined, expected: Address): Promise<SignedAccount> {
  if (!w?.record || !w.sig) throw new PayError("NO_PAYOUT_ACCOUNT");
  const record = accountOf(w.record);
  if (record.account !== getAddress(expected)) throw new PayError("REQUEST_TAMPERED");
  const signer = await recoverTypedDataAddress({ ...payoutAccountTyped(config.directoryDomain, record, config.chainId), signature: w.sig }).catch(() => null);
  if (!signer || getAddress(signer) !== record.account) throw new PayError("REQUEST_TAMPERED");
  // the record's own deadline only limited when it could be first saved; validity now is about the fields
  if (payoutAccountProblem({ ...record, deadline: 2n ** 64n }, 0n)) throw new PayError("REQUEST_TAMPERED");
  return { record, sig: w.sig, institutionName: w.institutionName ?? null };
}
/** Anyone's payout destination, verified here (it must be signed by that account itself); null if they have none. */
export async function bankAccountOf(address: Address): Promise<SignedAccount | null> {
  try {
    return await verifiedAccount(await api("GET", `/v1/payout/accounts/${address}`), address);
  } catch (e) {
    if (e instanceof PayError && e.code === "NO_PAYOUT_ACCOUNT") return null;
    throw e;
  }
}
export const myBankAccount = (account: Account) => bankAccountOf(account.address);
export const bankLine = (b: SignedAccount) => `${b.institutionName ?? b.record.institution} ••${b.record.last4}`;

/** "≈ $X" for a naira amount (live provider rate + the at-least buffer). */
export async function nairaEstimate(kobo: bigint): Promise<{ rate: string; stableAmount: bigint }> {
  const r = await api("GET", `/v1/payout/rate?amount=${kobo}`);
  return { rate: String(r.rate), stableAmount: BigInt(r.stableAmount) };
}

/**
 * "Send to their bank" / "cash out to my bank": the sender picks the amount; the destination is only ever the one the
 * recipient signed (checked by the caller with bankAccountOf). One prompt pays the provider order's exact amount.
 */
/**
 * The order's amount must match the price the payer was shown (+3% or $0.50 for the provider's fee and rate drift).
 * A payout server or provider asking for more is refused before anything is signed (audit 2026-10-06).
 */
export function checkOrderAmount(order: PublicOrder, quotedUnits: bigint): bigint {
  if (!order.amountToTransferUnits) throw new PayError("BAD_QUOTE");
  const units = BigInt(order.amountToTransferUnits);
  if (!payoutWithinQuote(units, quotedUnits)) throw new PayError("PRICE_CHANGED");
  return units;
}

export async function sendToBank(account: Account, recipient: Address, kobo: bigint, quotedUnits: bigint, onStatus: (s: RelayStatus | "SIGNING" | "ORDERING") => void): Promise<PublicOrder> {
  onStatus("ORDERING");
  const { order } = (await api("POST", "/v1/payout/orders", { recipient, fiatAmount: kobo.toString(), sender: account.address })) as { order: PublicOrder };
  const units = checkOrderAmount(order, quotedUnits);
  const dollars = payTokens().find((t) => t.route === "DIRECT_AUSD");
  if (!dollars) throw new PayError("PROVIDER_UNAVAILABLE");
  await payInstant(account, { recipient: order.receiveAddress, amount: units, token: dollars, ref: order.requestId }, onStatus);
  return order;
}

// ── payouts this device knows about, for Home (sent, cashed out, or received in naira) ─────────────────────────
export type LocalPayout = { key: string; role: "sent" | "received" | "cashout"; orderId?: string; requestId?: Hex; kobo: string; to: string; who?: string; at: number };
const PKEY = "everpiece.payouts.v1";
export function loadLocalPayouts(): LocalPayout[] {
  try {
    return JSON.parse(localStorage.getItem(PKEY) ?? "[]") as LocalPayout[];
  } catch {
    return [];
  }
}
export function rememberPayout(p: LocalPayout) {
  try {
    const all = loadLocalPayouts().filter((x) => x.key !== p.key);
    localStorage.setItem(PKEY, JSON.stringify([p, ...all].slice(0, 30)));
  } catch {
    /* storage unavailable */
  }
}

/** Recipient: "pay me at least ₦X to my signed bank account" (one prompt). */
export async function createPayoutRequest(account: Account, bank: SignedAccount, fiatAmountKobo: bigint, hours = 24): Promise<Hex> {
  const request: PayoutRequest = {
    version: PAYOUT_REQUEST_VERSION, requestId: randomBytes32(), recipient: account.address, currency: "NGN", fiatAmount: fiatAmountKobo,
    payoutAccountHash: payoutAccountHashOf(config.directoryDomain, bank.record, config.chainId), expiresAt: (await chainTime()) + BigInt(hours * 3600),
  };
  const problem = payoutRequestProblem(request, await chainTime());
  if (problem) throw new PayError(problem);
  const sig = await withSigner(account, (s) => s.signTypedData(payoutRequestTyped(config.directoryDomain, request, config.chainId)));
  await api("POST", "/v1/payout/requests", { request, sig });
  return request.requestId;
}

/** Sender (and recipient): load and VERIFY a payout request before anything is shown. */
export async function loadPayoutRequest(requestId: Hex): Promise<LoadedPayoutRequest> {
  const w = await api("GET", `/v1/payout/requests/${requestId}`);
  const request = requestOf(w.request);
  if (request.requestId !== requestId.toLowerCase()) throw new PayError("REQUEST_TAMPERED");
  const signer = await recoverTypedDataAddress({ ...payoutRequestTyped(config.directoryDomain, request, config.chainId), signature: w.sig }).catch(() => null);
  if (!signer || getAddress(signer) !== request.recipient) throw new PayError("REQUEST_TAMPERED");
  const account = await verifiedAccount(w.account, request.recipient);
  // the request names exactly this signed destination: a swapped bank account can't hide behind it
  if (payoutAccountHashOf(config.directoryDomain, account.record, config.chainId) !== request.payoutAccountHash) throw new PayError("ACCOUNT_CHANGED");
  return { request, sig: w.sig, account, order: (w.order as PublicOrder | null) ?? null };
}

export async function payoutQuote(requestId: Hex): Promise<{ rate: string; stableAmount: bigint; bufferBps: number }> {
  const q = await api("POST", "/v1/payout/quote", { requestId });
  return { rate: String(q.rate), stableAmount: BigInt(q.stableAmount), bufferBps: Number(q.bufferBps) };
}
export const payoutOrder = async (orderId: string): Promise<PublicOrder> => (await api("GET", `/v1/payout/orders/${encodeURIComponent(orderId)}`)).order;

/**
 * Sender: create (or resume) the provider order, then pay exactly what it asks, in Dollars, to its deposit address.
 * Refunds, if the bank payout fails, go back to this sender (P3).
 */
export async function payPayout(account: Account, requestId: Hex, quotedUnits: bigint, onStatus: (s: RelayStatus | "SIGNING" | "ORDERING") => void): Promise<PublicOrder> {
  onStatus("ORDERING");
  const { order } = (await api("POST", "/v1/payout/orders", { requestId, sender: account.address })) as { order: PublicOrder };
  if (order.state !== "AWAITING_PAYMENT") return order;
  const units = checkOrderAmount(order, quotedUnits);
  const dollars = payTokens().find((t) => t.route === "DIRECT_AUSD");
  if (!dollars) throw new PayError("PROVIDER_UNAVAILABLE");
  await payInstant(account, { recipient: order.receiveAddress, amount: units, token: dollars, ref: requestId }, onStatus);
  return order;
}
