import { hashTypedData, keccak256, toHex, type Address, type Hex } from "viem";
import { directoryDomain } from "./directory.ts";

/**
 * The last mile (docs/PAYOUT.md): a recipient receives at least ₦X in their own Nigerian bank account.
 * V1: NGN bank payouts through Paycrest (VERIFIED §4.15). The test site uses a SIMULATED Paycrest.
 *
 * Owner decisions P1–P4 (2026-10-06): nobody custodies the money (mainnet: one EverpiecePayout transaction);
 * promise "at least ₦X" until rate locking is verified; refunds go to the sender's own address; bank details are
 * encrypted at rest and senders only see the bank, a masked number and the verified name.
 */

export const PAYOUT_CURRENCIES = ["NGN"] as const;
export type PayoutCurrency = (typeof PAYOUT_CURRENCIES)[number];
/** Minor units per major unit (kobo per naira). */
export const MINOR_UNITS: Record<PayoutCurrency, bigint> = { NGN: 100n };
export const PAYOUT_REQUEST_VERSION = 1;
/** QR/deep link for a bank-payout request: an opaque id, like /pay/<id>. */
export const PAYOUT_REQUEST_LINK = /^\/payout\/(0x[0-9a-f]{64})$/;

// ── signed records (same EIP-712 domain as the directory's @username records) ───────────────────────────────────

/**
 * "My money may be paid out to this bank account": signed by the recipient's own Everpiece account.
 * `accountHash` = keccak256(salt ‖ institution ‖ ":" ‖ accountNumber); the salt stays on the server, so the public
 * record can't be brute-forced back to the 10-digit account number.
 */
export type PayoutAccount = {
  account: Address;
  currency: PayoutCurrency;
  institution: string;
  accountHash: Hex;
  accountName: string;
  last4: string;
  deadline: bigint;
};
/** "Pay me at least this much in this currency, to that signed bank destination." */
export type PayoutRequest = {
  version: number;
  requestId: Hex;
  recipient: Address;
  currency: PayoutCurrency;
  /** Minor units (kobo). */
  fiatAmount: bigint;
  /** Hash of the recipient's signed PayoutAccount (binds the request to exactly that destination). */
  payoutAccountHash: Hex;
  expiresAt: bigint;
};

const payoutTypes = {
  PayoutAccount: [
    { name: "account", type: "address" },
    { name: "currency", type: "string" },
    { name: "institution", type: "string" },
    { name: "accountHash", type: "bytes32" },
    { name: "accountName", type: "string" },
    { name: "last4", type: "string" },
    { name: "deadline", type: "uint256" },
  ],
  PayoutRequest: [
    { name: "version", type: "uint8" },
    { name: "requestId", type: "bytes32" },
    { name: "recipient", type: "address" },
    { name: "currency", type: "string" },
    { name: "fiatAmount", type: "uint256" },
    { name: "payoutAccountHash", type: "bytes32" },
    { name: "expiresAt", type: "uint256" },
  ],
} as const;

export const payoutAccountTyped = (domainAddress: Address, a: PayoutAccount, chainId: number) => ({
  domain: directoryDomain(domainAddress, chainId), types: { PayoutAccount: payoutTypes.PayoutAccount }, primaryType: "PayoutAccount" as const, message: a,
});
export const payoutRequestTyped = (domainAddress: Address, r: PayoutRequest, chainId: number) => ({
  domain: directoryDomain(domainAddress, chainId), types: { PayoutRequest: payoutTypes.PayoutRequest }, primaryType: "PayoutRequest" as const, message: r,
});
/** The id a PayoutRequest commits to (EIP-712 hash of the signed account record). */
export const payoutAccountHashOf = (domainAddress: Address, a: PayoutAccount, chainId: number): Hex => hashTypedData(payoutAccountTyped(domainAddress, a, chainId));

/** keccak256(salt ‖ institution ‖ ":" ‖ number): the server keeps `salt`, the public record only this hash. */
export const bankAccountHash = (salt: Hex, institution: string, accountNumber: string): Hex =>
  keccak256(`${salt}${toHex(`${institution}:${accountNumber}`).slice(2)}` as Hex);

/** Nigerian NUBAN: exactly 10 digits. */
export const NUBAN = /^[0-9]{10}$/;
export const INSTITUTION_CODE = /^[A-Z0-9]{4,12}$/;
export function payoutAccountProblem(a: PayoutAccount, nowSec: bigint): string | null {
  if (!(PAYOUT_CURRENCIES as readonly string[]).includes(a.currency)) return "UNSUPPORTED_CURRENCY";
  if (!INSTITUTION_CODE.test(a.institution)) return "INVALID_INSTITUTION";
  if (!/^0x[0-9a-f]{64}$/i.test(a.accountHash)) return "INVALID_ACCOUNT";
  if (!/^[0-9]{4}$/.test(a.last4)) return "INVALID_ACCOUNT";
  if (a.accountName.trim().length < 2 || a.accountName.length > 100) return "INVALID_ACCOUNT_NAME";
  if (a.deadline < nowSec) return "SIGNATURE_EXPIRED";
  return null;
}
export function payoutRequestProblem(r: PayoutRequest, nowSec: bigint): string | null {
  if (r.version !== PAYOUT_REQUEST_VERSION) return "UNKNOWN_VERSION";
  if (!/^0x[0-9a-f]{64}$/i.test(r.requestId)) return "INVALID_REQUEST";
  if (!(PAYOUT_CURRENCIES as readonly string[]).includes(r.currency)) return "UNSUPPORTED_CURRENCY";
  // ₦2,000 (above the relayer's $1 minimum payment) to ₦5,000,000 per request (V1 bounds; the provider's apply too)
  if (r.fiatAmount < 2_000n * MINOR_UNITS.NGN || r.fiatAmount > 5_000_000n * MINOR_UNITS.NGN) return "INVALID_AMOUNT";
  if (nowSec >= r.expiresAt) return "REQUEST_EXPIRED";
  return null;
}

// ── amounts: "at least ₦X" (P2) ─────────────────────────────────────────────────────────────────────────────────

/** "50000" or "50,000.50" → kobo; null if not a positive amount with ≤ 2 decimals. */
export function parseNaira(input: string): bigint | null {
  const s = input.trim().replace(/^₦/, "").replace(/,/g, "");
  const m = /^(0|[1-9][0-9]{0,9})(?:\.([0-9]{1,2}))?$/.exec(s);
  if (!m) return null;
  const v = BigInt(m[1]) * 100n + BigInt((m[2] ?? "").padEnd(2, "0") || "0");
  return v > 0n ? v : null;
}
export function formatNaira(kobo: bigint): string {
  const n = kobo / 100n;
  const k = kobo % 100n;
  return `₦${n.toLocaleString("en-NG")}${k ? `.${k.toString().padStart(2, "0")}` : ""}`;
}

/**
 * Stablecoin (6 decimals) the payout provider must receive so the bank gets at least `fiatAmount`, at `rate` naira
 * per unit (a decimal string as the provider returns it), plus `bufferBps` against the rate moving before payout.
 * Rounded UP to the unit: never less than needed.
 */
export function stableNeededFor(fiatAmountKobo: bigint, rate: string, bufferBps: number): bigint {
  const m = /^([0-9]{1,12})(?:\.([0-9]{1,12}))?$/.exec(rate.trim());
  if (!m) throw new Error("bad rate");
  const scale = 10n ** BigInt((m[2] ?? "").length);
  const rateScaled = BigInt(m[1]) * scale + BigInt(m[2] || "0"); // naira per unit × scale
  if (rateScaled === 0n) throw new Error("bad rate");
  // units(6dp) = kobo/100 / (rateScaled/scale) × 1e6 = kobo × scale × 1e4 / rateScaled
  const base = (fiatAmountKobo * scale * 10_000n + rateScaled - 1n) / rateScaled;
  return base + (base * BigInt(bufferBps) + 9_999n) / 10_000n;
}

// ── the provider (Paycrest Sender API v2) ────────────────────────────────────────────────────────────────────────

/** Everpiece's view of a payout (docs/PAYOUT.md §3). Never DELIVERED before the provider confirms the bank payout. */
export type PayoutState = "AWAITING_PAYMENT" | "PAYOUT_FUNDED" | "BANK_PROCESSING" | "DELIVERED" | "REFUNDING" | "REFUNDED" | "EXPIRED";
const ORDER: Record<PayoutState, number> = { AWAITING_PAYMENT: 0, PAYOUT_FUNDED: 1, BANK_PROCESSING: 2, DELIVERED: 3, REFUNDING: 3, REFUNDED: 4, EXPIRED: 4 };
export const isFinalPayout = (s: PayoutState) => s === "DELIVERED" || s === "REFUNDED" || s === "EXPIRED";

/** Paycrest status or webhook event → Everpiece state; null for anything unknown (never guessed). */
export function payoutStateOf(statusOrEvent: string): PayoutState | null {
  switch (statusOrEvent.replace(/^payment_order\./, "")) {
    case "initiated":
      return "AWAITING_PAYMENT";
    case "deposited":
      return "PAYOUT_FUNDED";
    case "pending":
      return "BANK_PROCESSING";
    case "validated": // "fiat payout confirmed by provider"
    case "settling":
    case "settled":
      return "DELIVERED";
    case "refunding":
      return "REFUNDING";
    case "refunded":
      return "REFUNDED";
    case "expired":
      return "EXPIRED";
    default:
      return null;
  }
}
/** States only move forward; DELIVERED/REFUNDED/EXPIRED are final (a late or replayed event never undoes them). */
export function nextPayoutState(current: PayoutState, incoming: PayoutState): PayoutState {
  if (isFinalPayout(current)) return current;
  if (current === "REFUNDING" && incoming === "DELIVERED") return current;
  return ORDER[incoming] >= ORDER[current] ? incoming : current;
}
// Webhook signatures (HMAC) live in server/payout: this package also runs in the browser.

/**
 * Never pay a payout order more than the price the payer was shown: the quote + 3% (or at least $0.50, 6 dp) for the
 * provider's fee and rate drift. Anything above is refused before signing (audit 2026-10-06).
 */
export function payoutWithinQuote(orderUnits: bigint, quotedUnits: bigint): boolean {
  const tolerance = quotedUnits * 3n / 100n > 500_000n ? quotedUnits * 3n / 100n : 500_000n;
  return orderUnits > 0n && orderUnits <= quotedUnits + tolerance;
}
