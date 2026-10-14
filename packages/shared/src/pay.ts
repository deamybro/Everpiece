import { hashTypedData, type Address, type Hex } from "viem";
import { AUSD_DECIMALS, AUSD_EIP712_NAME, AUSD_EIP712_VERSION, MONAD_MAINNET_CHAIN_ID, MONAD_TESTNET_CHAIN_ID } from "./constants.ts";
import { directoryDomain } from "./directory.ts";

// =====================================================================================================================
// Network references (docs/INTEGRATION_VERIFICATION.md — each value verified on-chain and in official docs)
// =====================================================================================================================

/** Agora AUSD on Monad testnet (Agora "Contract Deployments", eip712Domain "Agora Dollar" v1 on 10143). */
export const AUSD_TESTNET_ADDRESS = "0xa9012a055bd4e0eDfF8Ce09f960291C09D5322dC" as const;
/** Agora Instant Settlement on Monad testnet ("Protocol Deployments"). */
export const AGORA_TESTNET = {
  factory: "0x8468587Af422ad440F58a57E955eCA6A970b5375",
  ctkAusdPair: "0x1Aa8958Aa34cEC8096EF4381cb335effe977b0ae",
  whitelister: "0x7c10F56d6f04a51376393a1C3670e966863F6BD5",
  ausdFaucet: "0xd236c18D274E54FAccC3dd9DDA4b27965a73ee6C",
} as const;
/** USDC on Monad mainnet (Circle; docs/VERIFIED.md §4.14: name "USDC", version "2", 6 decimals, ERC-2612 domain checked). */
const AUSD_MAINNET = "0x00000000efe302beaa2b3e6e1b18d08d69a9012a";
export const USDC_MAINNET_ADDRESS = "0x754704Bc059F8C67012fEd69BC8A327a5aafb603" as const;
/** Agora Instant Settlement AUSD/USDC pair on Monad mainnet ("Protocol Deployments"; on-chain name "AUSD/USDC",
 *  token0 AUSD, token1 USDC). Swappers need APPROVED_SWAPPER, granted by Agora (KYC) on mainnet. */
export const AGORA_MAINNET = { factory: "0x8468587Af422ad440F58a57E955eCA6A970b5375", ausdUsdcPair: "0xf33286E3222D1c829dACeac48c0Ec651F6452470" } as const;
/** CTK ("ConstantToken"), Agora's demo token, token0 of the testnet CTK/AUSD pair. ERC-2612 permit verified by simulation. */
export const CTK_TESTNET_ADDRESS = "0x7BEb5D9DB0d85cBEa543C04f0dE8c23c2176cd9D" as const;

// =====================================================================================================================
// Token registry: "pay with what you have" = pay with a token Everpiece can ACTUALLY route right now
// =====================================================================================================================

export type RouteType = "DIRECT_AUSD" | "AGORA_INSTANT_SETTLEMENT" | "ZEROX";
export type TokenInfo = {
  chainId: number;
  address: Address;
  symbol: string;
  name: string;
  decimals: number;
  route: RouteType;
  /** How the payer authorizes without gas: AUSD uses ERC-3009, permit tokens use ERC-2612. */
  authorization: "ERC3009" | "ERC2612";
  eip712: { name: string; version: string };
  /** Agora pair for AGORA_INSTANT_SETTLEMENT routes. */
  pair?: Address;
  testnet: boolean;
  enabled: boolean;
};

export const TOKENS: readonly TokenInfo[] = [
  {
    chainId: MONAD_TESTNET_CHAIN_ID, address: AUSD_TESTNET_ADDRESS, symbol: "AUSD", name: "Agora Dollar", decimals: AUSD_DECIMALS,
    route: "DIRECT_AUSD", authorization: "ERC3009", eip712: { name: AUSD_EIP712_NAME, version: AUSD_EIP712_VERSION }, testnet: true, enabled: true,
  },
  {
    chainId: MONAD_TESTNET_CHAIN_ID, address: CTK_TESTNET_ADDRESS, symbol: "CTK", name: "Test CTK (Agora demo token)", decimals: 18,
    route: "AGORA_INSTANT_SETTLEMENT", authorization: "ERC2612", eip712: { name: "ConstantToken", version: "1" },
    pair: AGORA_TESTNET.ctkAusdPair, testnet: true, enabled: true,
  },
  {
    chainId: MONAD_MAINNET_CHAIN_ID, address: "0x00000000eFE302BEAA2b3e6e1b18d08D69a9012a", symbol: "AUSD", name: "Agora Dollar", decimals: AUSD_DECIMALS,
    route: "DIRECT_AUSD", authorization: "ERC3009", eip712: { name: AUSD_EIP712_NAME, version: AUSD_EIP712_VERSION }, testnet: false, enabled: true,
  },
  {
    chainId: MONAD_MAINNET_CHAIN_ID, address: USDC_MAINNET_ADDRESS, symbol: "USDC", name: "USD Coin", decimals: 6,
    route: "AGORA_INSTANT_SETTLEMENT", authorization: "ERC2612", eip712: { name: "USDC", version: "2" },
    pair: AGORA_MAINNET.ausdUsdcPair, testnet: false, enabled: true,
  },
];

/** Tokens that can be used to pay on this chain right now (anything else is UNSUPPORTED_ROUTE, never a fake quote). */
export const payableTokens = (chainId: number) => TOKENS.filter((t) => t.chainId === chainId && t.enabled);
export const tokenFor = (chainId: number, address: string) => payableTokens(chainId).find((t) => t.address.toLowerCase() === address.toLowerCase());
export const ausdFor = (chainId: number) => payableTokens(chainId).find((t) => t.route === "DIRECT_AUSD");

// =====================================================================================================================
// Exact amounts: never floating point
// =====================================================================================================================

/** "25.00" → 25_000_000n for 6 decimals. Rejects signs, exponents, more decimals than the token has, and overflow-ish input. */
export function toBaseUnits(input: string, decimals: number): bigint | null {
  const s = input.trim().replace(/^\$/, "");
  const m = /^(0|[1-9][0-9]{0,15})(?:\.([0-9]+))?$/.exec(s);
  if (!m) return null;
  const frac = m[2] ?? "";
  if (frac.length > decimals) return null;
  return BigInt(m[1]) * 10n ** BigInt(decimals) + BigInt(frac.padEnd(decimals, "0") || "0");
}

/** 25_000_000n (6 dp) → "25.00"; keeps significant extra digits ("0.000001"), never rounds. */
export function fromBaseUnits(units: bigint, decimals: number, minFraction = 2): string {
  const neg = units < 0n;
  const u = neg ? -units : units;
  const base = 10n ** BigInt(decimals);
  const whole = (u / base).toString();
  let frac = (u % base).toString().padStart(decimals, "0").replace(/0+$/, "");
  if (frac.length < minFraction) frac = frac.padEnd(minFraction, "0");
  return `${neg ? "-" : ""}${whole}${frac ? `.${frac}` : ""}`;
}

// =====================================================================================================================
// EverpiecePay (contracts/src/EverpiecePay.sol)
// =====================================================================================================================

export const PAY_EIP712_NAME = "Everpiece Pay";
export const PAY_EIP712_VERSION = "1";
export const payTypes = {
  Payment: [
    { name: "ref", type: "bytes32" },
    { name: "sender", type: "address" },
    { name: "recipient", type: "address" },
    { name: "amount", type: "uint256" },
    { name: "sourceToken", type: "address" },
    { name: "maxSourceAmount", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
} as const;
export type InstantPayment = {
  ref: Hex;
  sender: Address;
  recipient: Address;
  amount: bigint;
  sourceToken: Address;
  maxSourceAmount: bigint;
  deadline: bigint;
};

export const payDomain = (pay: Address, chainId: number) => ({ name: PAY_EIP712_NAME, version: PAY_EIP712_VERSION, chainId, verifyingContract: pay }) as const;

/** The payment id (EIP-712 digest); also the ERC-3009 nonce for AUSD payments, and what the payer signs for token payments. */
export function instantPaymentId(pay: Address, p: InstantPayment, chainId: number): Hex {
  return hashTypedData({ domain: payDomain(pay, chainId), types: payTypes, primaryType: "Payment", message: p });
}
/** Token payments: the payer signs the Payment itself (the permit alone doesn't bind the recipient). */
export const instantPaymentTyped = (pay: Address, p: InstantPayment, chainId: number) =>
  ({ domain: payDomain(pay, chainId), types: payTypes, primaryType: "Payment" as const, message: p });

/** AUSD payments: one ERC-3009 ReceiveWithAuthorization to the pay contract, nonce = payment id, validBefore = deadline. */
export function instantAusdAuthorization(pay: Address, p: InstantPayment, chainId: number, ausd: Address) {
  return {
    domain: { name: AUSD_EIP712_NAME, version: AUSD_EIP712_VERSION, chainId, verifyingContract: ausd } as const,
    types: {
      ReceiveWithAuthorization: [
        { name: "from", type: "address" },
        { name: "to", type: "address" },
        { name: "value", type: "uint256" },
        { name: "validAfter", type: "uint256" },
        { name: "validBefore", type: "uint256" },
        { name: "nonce", type: "bytes32" },
      ],
    } as const,
    primaryType: "ReceiveWithAuthorization" as const,
    message: { from: p.sender, to: pay, value: p.amount, validAfter: 0n, validBefore: p.deadline, nonce: instantPaymentId(pay, p, chainId) },
  };
}

/** ERC-2612 permit for a source token (spender = the pay contract, value = maxSourceAmount). */
export function permitTyped(token: TokenInfo, owner: Address, spender: Address, value: bigint, nonce: bigint, deadline: bigint) {
  return {
    domain: { name: token.eip712.name, version: token.eip712.version, chainId: token.chainId, verifyingContract: token.address } as const,
    types: {
      Permit: [
        { name: "owner", type: "address" },
        { name: "spender", type: "address" },
        { name: "value", type: "uint256" },
        { name: "nonce", type: "uint256" },
        { name: "deadline", type: "uint256" },
      ],
    } as const,
    primaryType: "Permit" as const,
    message: { owner, spender, value, nonce, deadline },
  };
}

// =====================================================================================================================
// Payment requests ("Pay Maris $25" QR): signed by the recipient's Mera account
// =====================================================================================================================

export const REQUEST_VERSION = 1;
export const RequestMode = { INSTANT: 1, PROTECTED: 2 } as const;
export type RequestMode = (typeof RequestMode)[keyof typeof RequestMode];

/**
 * Integrity: the recipient signs every security-critical field (who gets paid, how much, which chain/asset via the
 * domain + `asset`, mode, expiry) with their own account key, in the same EIP-712 domain as their @username record.
 * A tampered QR ("pay attacker $250") fails verification before anything is shown.
 */
export const requestTypes = {
  PaymentRequest: [
    { name: "version", type: "uint8" },
    { name: "requestId", type: "bytes32" },
    { name: "recipient", type: "address" },
    { name: "asset", type: "address" },
    { name: "amount", type: "uint256" },
    { name: "mode", type: "uint8" },
    { name: "expiresAt", type: "uint256" },
    { name: "memoHash", type: "bytes32" },
  ],
} as const;
export type PaymentRequest = {
  version: number;
  requestId: Hex;
  recipient: Address;
  asset: Address;
  amount: bigint;
  mode: RequestMode;
  expiresAt: bigint;
  /** keccak256 of an optional memo/voice reference, or zero. Never the content. */
  memoHash: Hex;
};
/** `escrow` is the domain's verifyingContract (shared with the directory records). */
export const paymentRequestTyped = (escrow: Address, r: PaymentRequest, chainId: number) =>
  ({ domain: directoryDomain(escrow, chainId), types: requestTypes, primaryType: "PaymentRequest" as const, message: r });

/** Structural checks a scanned/fetched request must pass before its signature is even checked. */
export function requestProblem(r: PaymentRequest, now: bigint, chainId: number): string | null {
  if (r.version !== REQUEST_VERSION) return "UNKNOWN_VERSION";
  if (!/^0x[0-9a-f]{64}$/i.test(r.requestId)) return "INVALID_REQUEST";
  if (r.amount <= 0n) return "INVALID_AMOUNT";
  if (r.mode !== RequestMode.INSTANT && r.mode !== RequestMode.PROTECTED) return "INVALID_MODE";
  const dollar = ausdFor(chainId)?.address.toLowerCase();
  // Instant requests may ask for either first-class settlement asset (USDC or AUSD, EverpiecePayV2); protected requests
  // stay in the escrow's asset.
  const instantAssets = chainId === MONAD_MAINNET_CHAIN_ID ? [AUSD_MAINNET, USDC_MAINNET_ADDRESS.toLowerCase()] : [];
  const asset = r.asset.toLowerCase();
  const ok = asset === dollar || (r.mode === RequestMode.INSTANT && instantAssets.includes(asset));
  if (!dollar || !ok) return "UNSUPPORTED_NETWORK";
  if (now >= r.expiresAt) return "REQUEST_EXPIRED";
  return null;
}

/** QR/deep-link: an opaque id pointing at the canonical signed request (never amounts or addresses in the QR). */
export const REQUEST_LINK = /^\/pay\/(0x[0-9a-f]{64})$/;

// =====================================================================================================================
// Payment lifecycle (central transition rules; the chain stays the authority for money)
// =====================================================================================================================

export type PaymentState =
  | "DRAFT" | "CREATED" | "QUOTED" | "AWAITING_AUTHORIZATION" | "SUBMITTED"
  | "FUNDED" | "CLAIMABLE" | "CLAIMED" | "COMPLETED" | "CANCELLED" | "EXPIRED" | "REFUNDING" | "REFUNDED" | "FAILED";

const NEXT: Record<PaymentState, readonly PaymentState[]> = {
  DRAFT: ["CREATED", "FAILED"],
  CREATED: ["QUOTED", "AWAITING_AUTHORIZATION", "FAILED"],
  QUOTED: ["AWAITING_AUTHORIZATION", "QUOTED", "FAILED"],
  AWAITING_AUTHORIZATION: ["SUBMITTED", "FAILED"],
  SUBMITTED: ["COMPLETED", "FUNDED", "FAILED"],
  FUNDED: ["CLAIMABLE"],
  CLAIMABLE: ["CLAIMED", "CANCELLED", "EXPIRED"],
  CANCELLED: ["REFUNDED"],
  EXPIRED: ["REFUNDING", "REFUNDED"],
  REFUNDING: ["REFUNDED"],
  CLAIMED: [],
  COMPLETED: [],
  REFUNDED: [],
  FAILED: [],
};
export const canTransition = (from: PaymentState, to: PaymentState) => NEXT[from].includes(to);
export const isTerminal = (s: PaymentState) => NEXT[s].length === 0;

// =====================================================================================================================
// Quotes and policy
// =====================================================================================================================

export type RouteQuote = {
  quoteId: string;
  provider: RouteType;
  environment: "testnet" | "mainnet";
  chainId: number;
  sellToken: Address;
  sellTokenDecimals: number;
  buyToken: Address;
  /** Exactly what the recipient receives (AUSD base units). */
  buyAmount: bigint;
  /** What the provider charges now, and the most the payer authorizes (headroom for price moves; the rest is returned). */
  sellAmount: bigint;
  maxSellAmount: bigint;
  /** Provider purchase fee, in sell-token units, when the provider reports it (Agora pairs: from the fee rate). */
  providerFee: bigint;
  /** Network fee the payer pays. Everpiece's relayer pays gas, so 0. */
  networkFee: bigint;
  expiresAt: number;
  recipient: Address;
  simulated: false;
};

export type PolicyDecision = "ALLOW" | "DENY" | "REVIEW";
export type KycState = "NOT_REQUIRED" | "REQUIRED" | "PENDING" | "VERIFIED" | "REJECTED";
export type ComplianceResult = { decision: PolicyDecision; reasons: string[]; ruleVersion: string; provider: string };

/** User-facing error codes (mandate §41). Raw provider/chain errors stay in developer diagnostics. */
export const PAY_ERRORS = [
  "QUOTE_EXPIRED", "UNSUPPORTED_TOKEN", "UNSUPPORTED_NETWORK", "NO_ROUTE", "INSUFFICIENT_BALANCE", "ALLOWANCE_REQUIRED",
  "PROVIDER_UNAVAILABLE", "AGORA_NOT_WHITELISTED", "POLICY_DENIED", "POLICY_REVIEW", "CLAIM_EXPIRED", "CLAIM_ALREADY_USED",
  "PAYMENT_ALREADY_CLAIMED", "PAYMENT_ALREADY_REFUNDED", "PAYMENT_EXPIRED", "TRANSACTION_REVERTED", "NETWORK_UNAVAILABLE",
  "REQUEST_EXPIRED", "REQUEST_ALREADY_PAID", "REQUEST_TAMPERED", "UNKNOWN_VERSION",
] as const;
export type PayError = (typeof PAY_ERRORS)[number];
