// Everpiece Earn (docs/EARN.md): verified AUSD ERC-4626 vaults reached gaslessly through EverpieceEarn, and the
// principal/yield accounting Automate relies on ("Earn → Invest never touches principal"). Amounts: bigint base units.
import { hashTypedData, type Address, type Hex } from "viem";
import { AUSD_EIP712_NAME, AUSD_EIP712_VERSION, MONAD_MAINNET_CHAIN_ID } from "./constants.ts";

export const MONAD_TESTNET_CHAIN_ID_EARN = 10143;

// ── opportunities ───────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * How a vault's value evolves, which decides whether "redeemable − net principal" is a sound measure of yield.
 * ERC4626_MONOTONIC: share price never decreases in normal operation (Aave's normalized income; the test vault's
 * donations), so the measure holds; any shortfall is treated as zero yield and never as negative principal.
 */
export type AccountingModel = "ERC4626_MONOTONIC";

export type EarnOpportunity = {
  id: string;
  chainId: number;
  provider: string;
  name: string;
  /** AUSD for every Everpiece vault: no swap needed. */
  asset: Address;
  vault: Address;
  accounting: AccountingModel;
  /** Where the live rate comes from (never a hardcoded APY). */
  rateSource: { kind: "AAVE_V3_LIQUIDITY_RATE"; pool: Address; reserve: Address } | { kind: "SIMULATED" };
  simulated: boolean;
  /** Plain-language risks shown before any deposit. */
  risks: string[];
  source: string;
};

const AUSD_MAINNET = "0x00000000eFE302BEAA2b3e6e1b18d08D69a9012a" as Address;

/** VERIFIED §4.17. Every address here was read back on-chain; see docs/INTEGRATION_VERIFICATION.md. */
export const EARN_OPPORTUNITIES: readonly EarnOpportunity[] = [
  {
    id: "aave-v3-ausd",
    chainId: MONAD_MAINNET_CHAIN_ID,
    provider: "Aave V3",
    name: "Aave · Dollars (AUSD)",
    asset: AUSD_MAINNET,
    vault: "0x9e1AcC5BFbf34e2E579763cE14042d957719fE76",
    accounting: "ERC4626_MONOTONIC",
    rateSource: { kind: "AAVE_V3_LIQUIDITY_RATE", pool: "0x69a5F9AD4f96ebf0a0C792dD42a01cC5C0102fef", reserve: AUSD_MAINNET },
    simulated: false,
    risks: [
      "The rate changes all the time; it is what borrowers pay, minus Aave's share.",
      "Withdrawals need free liquidity in the market: if most of it is borrowed, a full withdrawal can have to wait.",
      "Smart-contract and oracle risk of Aave. Not insured, not a bank deposit.",
    ],
    source: "https://github.com/bgd-labs/aave-address-book/blob/main/src/AaveV3Monad.sol",
  },
  {
    // VERIFIED §4.18: "Wrapped Aave Monad USDC" (EIP-712 v1, 6 dp), asset() = USDC, aToken 0x35a7…6042.
    id: "aave-v3-usdc",
    chainId: MONAD_MAINNET_CHAIN_ID,
    provider: "Aave V3",
    name: "Aave · USDC",
    asset: "0x754704Bc059F8C67012fEd69BC8A327a5aafb603",
    vault: "0xC554aFfE2f581F5E0811e0D42D484ECaC5c6B8e2",
    accounting: "ERC4626_MONOTONIC",
    rateSource: { kind: "AAVE_V3_LIQUIDITY_RATE", pool: "0x69a5F9AD4f96ebf0a0C792dD42a01cC5C0102fef", reserve: "0x754704Bc059F8C67012fEd69BC8A327a5aafb603" },
    simulated: false,
    risks: [
      "The rate changes all the time; it is what borrowers pay, minus Aave's share.",
      "Withdrawals need free liquidity in the market: if most of it is borrowed, a full withdrawal can have to wait.",
      "Smart-contract and oracle risk of Aave. Not insured, not a bank deposit.",
    ],
    source: "https://github.com/bgd-labs/aave-address-book/blob/main/src/AaveV3Monad.sol",
  },
];

/** The testnet vault is deployed by the test stack; its address comes from config, never guessed. */
export function testnetOpportunity(vault: Address, asset: Address): EarnOpportunity {
  return {
    id: "test-vault",
    chainId: MONAD_TESTNET_CHAIN_ID_EARN,
    provider: "Everpiece test vault",
    name: "Test vault · Dollars (SIMULATED yield)",
    asset,
    vault,
    accounting: "ERC4626_MONOTONIC",
    rateSource: { kind: "SIMULATED" },
    simulated: true,
    risks: ["Test money only. The yield is simulated: test Dollars are added to the vault by the test site, not earned."],
    source: "contracts/src/testnet/TestYieldVault.sol",
  };
}

/** Aave V3 liquidity rate (ray, APR) → APR and APY in basis points, for display only (never used to move money). */
export function aaveRates(liquidityRateRay: bigint): { aprBps: number; apyBps: number } {
  const apr = Number(liquidityRateRay) / 1e27;
  const apy = Math.expm1(Math.log1p(apr / 31_536_000) * 31_536_000);
  return { aprBps: Math.round(apr * 10_000), apyBps: Math.round(apy * 10_000) };
}

// ── signed actions (EverpieceEarn domain) ───────────────────────────────────────────────────────────────────────────

export const earnDomain = (earn: Address, chainId: number) => ({ name: "Everpiece Earn", version: "1", chainId, verifyingContract: earn });
export const earnTypes = {
  Deposit: [
    { name: "ref", type: "bytes32" }, { name: "owner", type: "address" }, { name: "vault", type: "address" },
    { name: "assets", type: "uint256" }, { name: "minShares", type: "uint256" }, { name: "deadline", type: "uint256" },
  ],
  Withdrawal: [
    { name: "ref", type: "bytes32" }, { name: "owner", type: "address" }, { name: "vault", type: "address" },
    { name: "assets", type: "uint256" }, { name: "maxShares", type: "uint256" }, { name: "deadline", type: "uint256" },
  ],
} as const;
export type EarnDeposit = { ref: Hex; owner: Address; vault: Address; assets: bigint; minShares: bigint; deadline: bigint };
export type EarnWithdrawal = { ref: Hex; owner: Address; vault: Address; assets: bigint; maxShares: bigint; deadline: bigint };
export const earnDepositTyped = (earn: Address, chainId: number, d: EarnDeposit) =>
  ({ domain: earnDomain(earn, chainId), types: { Deposit: earnTypes.Deposit }, primaryType: "Deposit" as const, message: d });
export const earnWithdrawalTyped = (earn: Address, chainId: number, w: EarnWithdrawal) =>
  ({ domain: earnDomain(earn, chainId), types: { Withdrawal: earnTypes.Withdrawal }, primaryType: "Withdrawal" as const, message: w });

/** The deposit id: EIP-712 digest of every Deposit term; also the AUSD ERC-3009 nonce (binds vault/amount/minShares). */
export const earnDepositId = (earn: Address, chainId: number, d: EarnDeposit): Hex => hashTypedData(earnDepositTyped(earn, chainId, d));
export const earnWithdrawalId = (earn: Address, chainId: number, w: EarnWithdrawal): Hex => hashTypedData(earnWithdrawalTyped(earn, chainId, w));

/** What the owner signs to fund a deposit: AUSD ReceiveWithAuthorization to EverpieceEarn, nonce = deposit id. */
/** The deposit authorization in ANY settlement asset's own domain (USDC "USDC"/"2", AUSD "Agora Dollar"/"1"). */
export function earnAuthorization(earn: Address, chainId: number, d: EarnDeposit, token: { address: Address; eip712Name: string; eip712Version: string }) {
  const a = earnAusdAuthorization(earn, chainId, d, token.address, token.eip712Name);
  return { ...a, domain: { ...a.domain, version: token.eip712Version } } as const;
}

export function earnAusdAuthorization(earn: Address, chainId: number, d: EarnDeposit, ausd: Address, ausdName: string = AUSD_EIP712_NAME) {
  return {
    domain: { name: ausdName, version: AUSD_EIP712_VERSION, chainId, verifyingContract: ausd },
    types: {
      ReceiveWithAuthorization: [
        { name: "from", type: "address" }, { name: "to", type: "address" }, { name: "value", type: "uint256" },
        { name: "validAfter", type: "uint256" }, { name: "validBefore", type: "uint256" }, { name: "nonce", type: "bytes32" },
      ],
    },
    primaryType: "ReceiveWithAuthorization" as const,
    message: { from: d.owner, to: earn, value: d.assets, validAfter: 0n, validBefore: d.deadline, nonce: earnDepositId(earn, chainId, d) },
  } as const;
}

/** ERC-2612 permit on the vault's shares (Aave waMonAUSD: "Wrapped Aave Monad AUSD" v1; test vault: its own name). */
export const sharePermitTyped = (vault: { address: Address; eip712Name: string }, chainId: number, owner: Address, spender: Address, value: bigint, nonce: bigint, deadline: bigint) => ({
  domain: { name: vault.eip712Name, version: "1", chainId, verifyingContract: vault.address },
  types: { Permit: [{ name: "owner", type: "address" }, { name: "spender", type: "address" }, { name: "value", type: "uint256" }, { name: "nonce", type: "uint256" }, { name: "deadline", type: "uint256" }] },
  primaryType: "Permit" as const,
  message: { owner, spender, value, nonce, deadline },
});

// ── principal / yield accounting ───────────────────────────────────────────────────────────────────────────────────

/**
 * A withdrawal is a HARVEST (earnings only) when its on-chain `ref` starts with the 4 bytes "HRV1"; everything else
 * is an owner withdrawal. The ref is part of the signed Withdrawal, so the label can't be changed after signing.
 */
const HARVEST_TAG = "48525631"; // "HRV1"
export const harvestRef = (random28: Hex): Hex => {
  if (!/^0x[0-9a-fA-F]{56}$/.test(random28)) throw new Error("harvestRef: need 28 random bytes");
  return `0x${HARVEST_TAG}${random28.slice(2).toLowerCase()}` as Hex;
};
export const isHarvestRef = (ref: string) => ref.toLowerCase().startsWith(`0x${HARVEST_TAG}`);

/** Indexed EverpieceEarn events (indexer `EarnEvent`) → ledger entries, for one vault. */
export function ledgerFromEvents(events: readonly { id: string; kind: string; ref: string; vault: string; assets: bigint }[], vault: Address): LedgerEntry[] {
  return events
    .filter((e) => e.vault.toLowerCase() === vault.toLowerCase())
    .map((e) => ({ id: e.id, assets: e.assets, kind: e.kind === "DEPOSIT" ? "DEPOSIT" : isHarvestRef(e.ref) ? "HARVEST" : "WITHDRAW" }) as LedgerEntry);
}

export type LedgerEntry =
  | { kind: "DEPOSIT"; id: string; assets: bigint }
  /** The owner taking money out (principal first, then earnings). */
  | { kind: "WITHDRAW"; id: string; assets: bigint }
  /** Automate (or the owner) harvesting earnings: counts as yield, never principal. */
  | { kind: "HARVEST"; id: string; assets: bigint };

export type EarnPosition = {
  principalDeposited: bigint;
  principalWithdrawn: bigint;
  yieldAlreadyHarvested: bigint;
  /** Earnings the owner took out in a WITHDRAW that exceeded the principal. */
  yieldWithdrawn: bigint;
  currentRedeemableValue: bigint;
  netPrincipal: bigint;
  harvestableYield: bigint;
};

/**
 * ERC-4626 rounding (previewWithdraw rounds shares up, convertToAssets rounds down) can cost a unit or two per
 * operation; harvesting this much less than the computed yield keeps principal whole.
 */
export const HARVEST_ROUNDING_MARGIN = 2n;

/**
 * Fold the owner's recorded Earn events (from EverpieceEarn's EarnDeposited/EarnWithdrawn, tagged HARVEST by their
 * Automate ref) with the vault's current redeemable value. Entries are de-duplicated by id. Pure.
 */
export function earnPosition(model: AccountingModel, entries: readonly LedgerEntry[], currentRedeemableValue: bigint): EarnPosition {
  if (model !== "ERC4626_MONOTONIC") throw new Error("UNSUPPORTED_ACCOUNTING_MODEL");
  const seen = new Set<string>();
  let deposited = 0n, principalOut = 0n, harvested = 0n, yieldOut = 0n;
  for (const e of entries) {
    if (seen.has(e.id) || e.assets <= 0n) continue;
    seen.add(e.id);
    if (e.kind === "DEPOSIT") deposited += e.assets;
    else if (e.kind === "HARVEST") harvested += e.assets;
    else {
      const net = deposited - principalOut;
      const fromPrincipal = e.assets <= net ? e.assets : net > 0n ? net : 0n;
      principalOut += fromPrincipal;
      yieldOut += e.assets - fromPrincipal;
    }
  }
  const netPrincipal = deposited - principalOut;
  const excess = currentRedeemableValue - netPrincipal; // ≤ 0 after a loss: no yield, principal is never "harvested"
  const harvestableYield = excess > HARVEST_ROUNDING_MARGIN ? excess - HARVEST_ROUNDING_MARGIN : 0n;
  return {
    principalDeposited: deposited, principalWithdrawn: principalOut, yieldAlreadyHarvested: harvested, yieldWithdrawn: yieldOut,
    currentRedeemableValue, netPrincipal, harvestableYield,
  };
}

/**
 * The authoritative numbers come from EverpieceEarn's on-chain `principalOf` (enforced at harvest time), not from the
 * indexed ledger, which can lag behind a fresh deposit: a lagging ledger must never make principal look harvestable.
 * The ledger still supplies history (deposited, withdrawn, harvested totals).
 */
export function withOnchainPrincipal(p: EarnPosition, onchainPrincipal: bigint): EarnPosition {
  const excess = p.currentRedeemableValue - onchainPrincipal;
  return { ...p, netPrincipal: onchainPrincipal, harvestableYield: excess > HARVEST_ROUNDING_MARGIN ? excess - HARVEST_ROUNDING_MARGIN : 0n };
}

/** A harvest may never exceed the harvestable yield (principal protection, enforced again before signing). */
export function harvestProblem(p: EarnPosition, amount: bigint): "ZERO" | "EXCEEDS_YIELD" | null {
  if (amount <= 0n) return "ZERO";
  return amount > p.harvestableYield ? "EXCEEDS_YIELD" : null;
}
