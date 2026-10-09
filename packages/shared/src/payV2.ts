import { hashTypedData, type Address, type Hex } from "viem";
import { AUSD_ADDRESS, AUSD_EIP712_NAME, AUSD_EIP712_VERSION, MONAD_MAINNET_CHAIN_ID } from "./constants.ts";
import { USDC_MAINNET_ADDRESS, AGORA_MAINNET } from "./pay.ts";

// =====================================================================================================================
// EverpiecePayV2 (contracts/src/EverpiecePayV2.sol): USDC and AUSD are both first-class settlement assets.
// The recipient receives EXACTLY `amount` of `asset`. Same asset = DIRECT (no conversion, nobody's permission);
// the other asset = CONVERTED through the Agora pair (needs Agora's APPROVED_SWAPPER grant; otherwise UNAVAILABLE).
// =====================================================================================================================

export type SettlementAsset = {
  chainId: number;
  address: Address;
  symbol: "USDC" | "AUSD";
  decimals: 6;
  /** The token's own EIP-712 domain: the payer's ERC-3009 ReceiveWithAuthorization is signed in it. */
  eip712: { name: string; version: string };
  /** Default receiving asset (mandate: USDC). */
  isDefault: boolean;
};

/** Mainnet settlement assets. USDC domain "USDC"/"2" (VERIFIED §4.18), AUSD "Agora Dollar"/"1" (§2.4). */
export const SETTLEMENT_ASSETS: readonly SettlementAsset[] = [
  { chainId: MONAD_MAINNET_CHAIN_ID, address: USDC_MAINNET_ADDRESS, symbol: "USDC", decimals: 6, eip712: { name: "USDC", version: "2" }, isDefault: true },
  { chainId: MONAD_MAINNET_CHAIN_ID, address: AUSD_ADDRESS, symbol: "AUSD", decimals: 6, eip712: { name: AUSD_EIP712_NAME, version: AUSD_EIP712_VERSION }, isDefault: false },
];

export const settlementAssetsFor = (chainId: number) => SETTLEMENT_ASSETS.filter((a) => a.chainId === chainId);
export const settlementAsset = (chainId: number, address: string) =>
  settlementAssetsFor(chainId).find((a) => a.address.toLowerCase() === address.toLowerCase());
export const defaultSettlementAsset = (chainId: number) => settlementAssetsFor(chainId).find((a) => a.isDefault);

/** Conversion pairs EverpiecePayV2 is deployed with (both directions). */
export const CONVERSION_PAIRS: readonly { chainId: number; tokenA: Address; tokenB: Address; pair: Address; provider: "AGORA" }[] = [
  { chainId: MONAD_MAINNET_CHAIN_ID, tokenA: AUSD_ADDRESS, tokenB: USDC_MAINNET_ADDRESS, pair: AGORA_MAINNET.ausdUsdcPair, provider: "AGORA" },
];

export type PayV2Route = "DIRECT" | "CONVERTED";
export const routeOf = (asset: Address, sourceToken: Address): PayV2Route =>
  asset.toLowerCase() === sourceToken.toLowerCase() ? "DIRECT" : "CONVERTED";

export const PAY_V2_EIP712_NAME = "Everpiece Pay";
export const PAY_V2_EIP712_VERSION = "2";
export const payV2Types = {
  Payment: [
    { name: "ref", type: "bytes32" },
    { name: "sender", type: "address" },
    { name: "recipient", type: "address" },
    { name: "asset", type: "address" },
    { name: "amount", type: "uint256" },
    { name: "sourceToken", type: "address" },
    { name: "maxSourceAmount", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
} as const;

export type PaymentV2 = {
  ref: Hex;
  sender: Address;
  recipient: Address;
  asset: Address;
  amount: bigint;
  sourceToken: Address;
  maxSourceAmount: bigint;
  deadline: bigint;
};

export const payV2Domain = (pay: Address, chainId: number) =>
  ({ name: PAY_V2_EIP712_NAME, version: PAY_V2_EIP712_VERSION, chainId, verifyingContract: pay }) as const;

/** The payment id (EIP-712 digest of every term) = the ERC-3009 nonce the payer signs. */
export function paymentV2Id(pay: Address, p: PaymentV2, chainId: number): Hex {
  return hashTypedData({ domain: payV2Domain(pay, chainId), types: payV2Types, primaryType: "Payment", message: p });
}

/** Structural checks the contract also enforces; null = OK. Never a substitute for the on-chain checks. */
export function paymentV2Problem(p: PaymentV2, chainId: number, now: bigint): string | null {
  if (!settlementAsset(chainId, p.asset)) return "UNSUPPORTED_ASSET";
  if (!settlementAsset(chainId, p.sourceToken)) return "UNSUPPORTED_ROUTE";
  if (p.amount <= 0n) return "ZERO_AMOUNT";
  if (routeOf(p.asset, p.sourceToken) === "DIRECT" && p.maxSourceAmount !== p.amount) return "DIRECT_AMOUNT_MISMATCH";
  if (routeOf(p.asset, p.sourceToken) === "CONVERTED" && p.maxSourceAmount <= 0n) return "ZERO_AMOUNT";
  if (p.deadline <= now) return "EXPIRED";
  return null;
}

/** The ONE signature the payer makes: ERC-3009 ReceiveWithAuthorization in the SOURCE token's domain, to = pay,
 *  value = maxSourceAmount, validAfter = 0, validBefore = deadline, nonce = payment id. */
export function paymentV2Authorization(pay: Address, p: PaymentV2, chainId: number) {
  const source = settlementAsset(chainId, p.sourceToken);
  if (!source) throw new Error("UNSUPPORTED_ROUTE");
  return {
    domain: { name: source.eip712.name, version: source.eip712.version, chainId, verifyingContract: source.address } as const,
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
    message: { from: p.sender, to: pay, value: p.maxSourceAmount, validAfter: 0n, validBefore: p.deadline, nonce: paymentV2Id(pay, p, chainId) },
  };
}
