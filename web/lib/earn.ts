import { getAddress, hexToSignature, parseAbi, type Address, type Hex } from "viem";
import {
  aaveRates,
  earnAusdAuthorization,
  earnAuthorization,
  settlementAsset,
  earnDepositId,
  earnPosition,
  earnWithdrawalTyped,
  erc4626Abi,
  everpieceEarnAbi,
  harvestProblem,
  harvestRef,
  ledgerFromEvents,
  withOnchainPrincipal,
  sharePermitTyped,
  testnetOpportunity,
  EARN_OPPORTUNITIES,
  type EarnOpportunity,
  type EarnPosition,
} from "@everpiece/shared";
import { config } from "./config";
import { chainTime, client } from "./chain";
import { relayer, waitForRequest, type RelayStatus } from "./api";
import { randomBytes32 } from "./link";
import { withSigner, type Account } from "./mera";
import { PayError } from "./pay";

/**
 * Earn (docs/EARN.md): the owner's AUSD into a verified ERC-4626 vault through EverpieceEarn, gasless. Mainnet: Aave V3
 * "Wrapped Aave Monad AUSD". Testnet: a SIMULATED-yield test vault (Aave has no Monad testnet). Shares and assets
 * always belong to the owner; nothing here is custodial.
 */

export const earnAvailable = () => Boolean(config.earn && (config.earnVault || config.chainId === 143)) || usdcEarnAvailable();
const usdcEarnAvailable = () => Boolean(config.earnUsdc) && config.chainId === 143;
const USDC_OPP = () => EARN_OPPORTUNITIES.find((o) => o.id === "aave-v3-usdc" && o.chainId === config.chainId);

/** Which EverpieceEarn router holds this opportunity: USDC → EverpieceEarnUsdc, AUSD (or the test vault) → EverpieceEarn. */
export const routerFor = (o: EarnOpportunity): Address => (o.id === "aave-v3-usdc" ? config.earnUsdc : config.earn);
const isUsdc = (o: EarnOpportunity) => o.id === "aave-v3-usdc";

/** Every Earn opportunity this deployment can use (USDC first when enabled). */
export function opportunities(): EarnOpportunity[] {
  const out: EarnOpportunity[] = [];
  const u = USDC_OPP();
  if (usdcEarnAvailable() && u) out.push(u);
  if (config.chainId === 143 && config.earn) {
    // mainnet AUSD Earn: every verified AUSD vault in the registry (Aave and Morpho), all held by the one EverpieceEarn
    out.push(...EARN_OPPORTUNITIES.filter((o) => o.chainId === 143 && o.asset.toLowerCase() === AUSD_LOWER && o.id !== "aave-v3-usdc"));
  } else {
    const a = config.earn && config.earnVault ? opportunity() : null;
    if (a) out.push(a);
  }
  return out;
}
const AUSD_LOWER = "0x00000000efe302beaa2b3e6e1b18d08d69a9012a";

export function opportunity(): EarnOpportunity | null {
  if (!(config.earn && config.earnVault)) return USDC_OPP() && usdcEarnAvailable() ? USDC_OPP()! : null;
  const known = EARN_OPPORTUNITIES.find((o) => o.chainId === config.chainId && o.vault.toLowerCase() === config.earnVault.toLowerCase());
  if (known) return known;
  // only the testnet may use a vault outside the verified registry, and it is always labelled SIMULATED
  return config.chainId === 10143 ? testnetOpportunity(getAddress(config.earnVault), getAddress(config.dollar.address)) : null;
}

const permitNames = parseAbi(["function nonces(address owner) view returns (uint256)", "function eip712Domain() view returns (bytes1, string, string, uint256, address, bytes32, uint256[])"]);
const aavePool = parseAbi([
  "function getReserveData(address asset) view returns ((uint256 configuration, uint128 liquidityIndex, uint128 currentLiquidityRate, uint128 variableBorrowIndex, uint128 currentVariableBorrowRate, uint128 currentStableBorrowRate, uint40 lastUpdateTimestamp, uint16 id, address aTokenAddress, address stableDebtTokenAddress, address variableDebtTokenAddress, address interestRateStrategyAddress, uint128 accruedToTreasury, uint128 unbacked, uint128 isolationModeTotalDebt))",
]);

/** The live rate, from its source (never a constant). null = simulated or unreadable. */
export async function currentRate(o: EarnOpportunity): Promise<{ aprBps: number; apyBps: number } | null> {
  if (o.rateSource.kind === "MORPHO_API") {
    try {
      const r = await fetch("https://api.morpho.org/graphql", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ query: `{ vaultByAddress(address: "${o.rateSource.vault}", chainId: ${o.rateSource.chainId}) { state { netApy apy } } }` }),
      });
      const s = ((await r.json()) as { data?: { vaultByAddress?: { state?: { netApy?: number; apy?: number } } } }).data?.vaultByAddress?.state;
      if (!s || typeof s.netApy !== "number" || !Number.isFinite(s.netApy) || s.netApy < 0 || s.netApy > 5) return null; // implausible = unavailable
      return { aprBps: Math.round((s.apy ?? s.netApy) * 10_000), apyBps: Math.round(s.netApy * 10_000) };
    } catch {
      return null;
    }
  }
  if (o.rateSource.kind !== "AAVE_V3_LIQUIDITY_RATE") return null;
  try {
    const r = await client.readContract({ address: o.rateSource.pool, abi: aavePool, functionName: "getReserveData", args: [o.rateSource.reserve] });
    return aaveRates(BigInt(r.currentLiquidityRate));
  } catch {
    return null;
  }
}

type IndexedEarn = { id: string; kind: string; ref: string; vault: string; assets: string; timestamp: number; txHash: string };
async function indexedEvents(owner: Address): Promise<IndexedEarn[]> {
  if (!config.indexerUrl) return [];
  const r = await fetch(config.indexerUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query: "query($me: String!) { EarnEvent(where: { owner: { _eq: $me } }, order_by: { block: asc }) { id kind ref vault assets timestamp txHash } }", variables: { me: owner } }),
  });
  if (!r.ok) throw new Error(`indexer HTTP ${r.status}`);
  const j = (await r.json()) as { data?: { EarnEvent: IndexedEarn[] } };
  if (!j.data) throw new Error("indexer: no data");
  return j.data.EarnEvent;
}

export type EarnView = { position: EarnPosition; shares: bigint; maxWithdraw: bigint; history: IndexedEarn[] };

/** Position = the vault's own numbers (shares, redeemable) folded with the indexed ledger (principal, harvests). */
export async function readPosition(o: EarnOpportunity, owner: Address): Promise<EarnView> {
  const [shares, history] = await Promise.all([
    client.readContract({ address: o.vault, abi: erc4626Abi, functionName: "balanceOf", args: [owner] }),
    indexedEvents(owner),
  ]);
  const [redeemable, maxWithdraw, principal] = await Promise.all([
    client.readContract({ address: o.vault, abi: erc4626Abi, functionName: "convertToAssets", args: [shares] }),
    client.readContract({ address: o.vault, abi: erc4626Abi, functionName: "maxWithdraw", args: [owner] }),
    // the contract's own principal (enforced at harvest), never the possibly-lagging indexed ledger
    client.readContract({ address: routerFor(o), abi: everpieceEarnAbi, functionName: "principalOf", args: [owner, o.vault] }),
  ]);
  const entries = ledgerFromEvents(history.map((h) => ({ ...h, assets: BigInt(h.assets) })), o.vault);
  return { position: withOnchainPrincipal(earnPosition(o.accounting, entries, redeemable), principal), shares, maxWithdraw, history };
}

/** Move `assets` AUSD from the balance into Earn: one signature (an AUSD authorization bound to this deposit). */
export async function deposit(account: Account, o: EarnOpportunity, assets: bigint, onStatus: (s: RelayStatus | "SIGNING") => void, ref?: Hex): Promise<{ id: Hex; txHash: Hex | null }> {
  if (!earnAvailable()) throw new PayError("PROVIDER_UNAVAILABLE");
  if (assets <= 0n) throw new PayError("INVALID_AMOUNT");
  const [minShares, deadline] = await Promise.all([
    client.readContract({ address: o.vault, abi: erc4626Abi, functionName: "previewDeposit", args: [assets] }),
    chainTime().then((t) => t + 600n),
  ]);
  const d = { ref: ref ?? randomBytes32(), owner: account.address, vault: o.vault, assets, minShares, deadline };
  onStatus("SIGNING");
  const router = routerFor(o);
  const usdc = isUsdc(o) ? settlementAsset(config.chainId, o.asset) : undefined;
  const typed = usdc
    ? earnAuthorization(router, config.chainId, d, { address: usdc.address, eip712Name: usdc.eip712.name, eip712Version: usdc.eip712.version })
    : earnAusdAuthorization(router, config.chainId, d, getAddress(config.dollar.address), config.dollar.eip712Name);
  const ausdSignature = await withSigner(account, (signer) => signer.signTypedData(typed));
  const r = await relayer(usdc ? "/v1/earn/usdc/deposit" : "/v1/earn/deposit", { deposit: d, ausdSignature });
  if (r.status !== 202 && r.status !== 200) throw new PayError(r.body.error ?? "TRANSACTION_REVERTED");
  const done = await waitForRequest(r.body.requestId, onStatus);
  if (done.status !== "CONFIRMED") throw new PayError(done.error ?? "TRANSACTION_REVERTED");
  return { id: earnDepositId(router, config.chainId, d), txHash: (done.txHash as Hex) ?? null };
}

/**
 * Take `assets` AUSD out of Earn back to the balance. `harvest`: earnings only — refused if it would touch principal,
 * and tagged on-chain (signed ref) so the ledger counts it as yield.
 */
export async function withdraw(account: Account, o: EarnOpportunity, assets: bigint, opts: { harvest: boolean; ref?: Hex }, onStatus: (s: RelayStatus | "SIGNING") => void): Promise<{ txHash: Hex | null }> {
  if (!earnAvailable()) throw new PayError("PROVIDER_UNAVAILABLE");
  if (opts.harvest) {
    const { position } = await readPosition(o, account.address);
    if (harvestProblem(position, assets)) throw new PayError("EXCEEDS_EARNINGS");
  }
  const [maxShares, nonce, domain, deadline] = await Promise.all([
    client.readContract({ address: o.vault, abi: erc4626Abi, functionName: "previewWithdraw", args: [assets] }),
    client.readContract({ address: o.vault, abi: permitNames, functionName: "nonces", args: [account.address] }),
    client.readContract({ address: o.vault, abi: permitNames, functionName: "eip712Domain" }),
    chainTime().then((t) => t + 600n),
  ]);
  const ref = opts.ref ?? (opts.harvest ? harvestRef(`0x${randomBytes32().slice(10)}` as Hex) : randomBytes32());
  const w = { ref, owner: account.address, vault: o.vault, assets, maxShares, deadline };
  onStatus("SIGNING");
  const { ownerSignature, permitSig } = await withSigner(account, async (signer) => ({
    ownerSignature: await signer.signTypedData(earnWithdrawalTyped(routerFor(o), config.chainId, w)),
    permitSig: await signer.signTypedData(sharePermitTyped({ address: o.vault, eip712Name: domain[1] }, config.chainId, account.address, routerFor(o), maxShares, nonce, deadline)),
  }));
  const { r: pr, s: ps, v } = hexToSignature(permitSig);
  const r = await relayer(isUsdc(o) ? "/v1/earn/usdc/withdraw" : "/v1/earn/withdraw", { withdrawal: w, ownerSignature, permit: { v: Number(v), r: pr, s: ps } });
  if (r.status !== 202 && r.status !== 200) throw new PayError(r.body.error ?? "TRANSACTION_REVERTED");
  const done = await waitForRequest(r.body.requestId, onStatus);
  if (done.status !== "CONFIRMED") throw new PayError(done.error ?? "TRANSACTION_REVERTED");
  return { txHash: (done.txHash as Hex) ?? null };
}
