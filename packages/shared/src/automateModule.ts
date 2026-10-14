import { hashTypedData, type Address, type Hex } from "viem";

// =====================================================================================================================
// EverpieceAutomate (contracts/src/EverpieceAutomate.sol; docs/AUTOMATE.md §5 BOUNDED_MODULE). The owner signs ONE grant:
// the named executor may move the owner's USDC/AUSD into ONE allow-listed Earn vault, in the owner's name, within
// per-execution / per-day / total caps until an expiry. Nothing else is possible on-chain.
// =====================================================================================================================

export const AUTOMATE_EIP712_NAME = "Everpiece Automate";
export const AUTOMATE_EIP712_VERSION = "1";
/** Same bound as an Automate rule's expiry (and the contract's MAX_GRANT_DURATION). */
export const MAX_GRANT_DURATION_SEC = 366n * 86_400n;

export type Grant = {
  ruleId: Hex;
  owner: Address;
  executor: Address;
  vault: Address;
  maxPerExecution: bigint;
  maxPerDay: bigint;
  total: bigint;
  expiresAt: bigint;
};

export const grantTypes = {
  Grant: [
    { name: "ruleId", type: "bytes32" },
    { name: "owner", type: "address" },
    { name: "executor", type: "address" },
    { name: "vault", type: "address" },
    { name: "maxPerExecution", type: "uint256" },
    { name: "maxPerDay", type: "uint256" },
    { name: "total", type: "uint256" },
    { name: "expiresAt", type: "uint256" },
  ],
} as const;
export const revokeTypes = { Revoke: [{ name: "grantId", type: "bytes32" }] } as const;

export const automateDomain = (automate: Address, chainId: number) =>
  ({ name: AUTOMATE_EIP712_NAME, version: AUTOMATE_EIP712_VERSION, chainId, verifyingContract: automate }) as const;

/** The grant id = EIP-712 digest the owner signs (raw ECDSA over the digest, like EverpiecePay v1's payer signature). */
export const grantIdOf = (automate: Address, chainId: number, g: Grant): Hex =>
  hashTypedData({ domain: automateDomain(automate, chainId), types: grantTypes, primaryType: "Grant", message: g });
export const grantTyped = (automate: Address, chainId: number, g: Grant) =>
  ({ domain: automateDomain(automate, chainId), types: grantTypes, primaryType: "Grant" as const, message: g });
export const revokeTyped = (automate: Address, chainId: number, grantId: Hex) =>
  ({ domain: automateDomain(automate, chainId), types: revokeTypes, primaryType: "Revoke" as const, message: { grantId } });

/** The contract's own bounds, checked before anything is signed or relayed (null = OK). */
export function grantProblem(g: Grant, nowSec: bigint): string | null {
  if (g.maxPerExecution <= 0n || g.maxPerExecution > g.maxPerDay || g.maxPerDay > g.total) return "INVALID_GRANT_CAPS";
  if (g.expiresAt <= nowSec || g.expiresAt > nowSec + MAX_GRANT_DURATION_SEC) return "INVALID_GRANT_EXPIRY";
  return null;
}

/** A grant matches its rule: same id, same owner, and caps no looser than the rule's own signed limits. */
export function grantMatchesRule(
  g: Grant,
  rule: { id: Hex; owner: Address; limits: { maxPerExecution: bigint; maxPerDay: bigint; expiresAt: bigint } },
): boolean {
  return (
    g.ruleId.toLowerCase() === rule.id.toLowerCase() &&
    g.owner.toLowerCase() === rule.owner.toLowerCase() &&
    g.maxPerExecution <= rule.limits.maxPerExecution &&
    g.maxPerDay <= rule.limits.maxPerDay &&
    g.expiresAt <= rule.limits.expiresAt
  );
}
