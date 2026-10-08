import { createPublicClient, getAddress, http, parseAbi, parseEventLogs, type Address, type Hex, type PublicClient } from "viem";
import { everpieceEarnAbi, HARVEST_ROUNDING_MARGIN, type Action } from "@everpiece/shared";
import type { LegVerifier, TargetRegistry, WorldReader } from "./service.ts";

/**
 * The outside world for Automate, read from the chain at "finalized" (VERIFIED §1.14): balances, Earn principal and
 * value, and proof that a reported transaction did exactly one leg. Nothing here signs or sends anything.
 */
export type WorldConfig = {
  rpcUrl: string;
  ausd: Address;
  /** EverpieceEarn + its vault, and the Earn opportunity id rules refer to (docs/EARN.md). Empty = Earn unavailable. */
  earn?: Address;
  earnVault?: Address;
  earnOpportunityId?: string;
};

const erc20 = parseAbi(["function balanceOf(address) view returns (uint256)"]);
const erc4626 = parseAbi(["function balanceOf(address) view returns (uint256)", "function convertToAssets(uint256) view returns (uint256)"]);

export function chainWorld(cfg: WorldConfig, client?: PublicClient): { world: WorldReader; targets: TargetRegistry; verifier: LegVerifier } {
  const c = client ?? (createPublicClient({ transport: http(cfg.rpcUrl, { timeout: 20_000, retryCount: 3 }) }) as PublicClient);
  const earnReady = Boolean(cfg.earn && cfg.earnVault && cfg.earnOpportunityId);

  const world: WorldReader = {
    balance: (owner) => c.readContract({ address: cfg.ausd, abi: erc20, functionName: "balanceOf", args: [owner], blockTag: "finalized" }),
    // pending bank payouts are reserved by the payout server; not wired yet on the test stack (no rule moves them)
    reserved: async () => 0n,
    async harvestable(owner, positionId) {
      if (!earnReady || positionId !== cfg.earnOpportunityId) return 0n;
      const [shares, principal] = await Promise.all([
        c.readContract({ address: cfg.earnVault!, abi: erc4626, functionName: "balanceOf", args: [owner], blockTag: "finalized" }),
        c.readContract({ address: cfg.earn!, abi: everpieceEarnAbi, functionName: "principalOf", args: [owner, cfg.earnVault!], blockTag: "finalized" }),
      ]);
      const value = await c.readContract({ address: cfg.earnVault!, abi: erc4626, functionName: "convertToAssets", args: [shares], blockTag: "finalized" });
      const excess = value - principal; // principal from the contract that enforces it at harvest time
      return excess > HARVEST_ROUNDING_MARGIN ? excess - HARVEST_ROUNDING_MARGIN : 0n;
    },
  };

  const targets: TargetRegistry = {
    availability(a) {
      if (a.kind === "DEPOSIT_YIELD") {
        return earnReady && a.opportunityId === cfg.earnOpportunityId ? { status: "AVAILABLE" } : { status: "UNAVAILABLE", reason: "EARN_PROVIDER_UNAVAILABLE" };
      }
      // docs/INVEST.md: no stock route has passed the quote-quality policy yet (KURU_ASTOCK_EXECUTION = NOT_AVAILABLE)
      return { status: "UNAVAILABLE", reason: "INVESTMENT_ROUTE_UNAVAILABLE" };
    },
  };

  const verifier: LegVerifier = {
    async verify(owner: Address, action: Action, amount: bigint, txHash: Hex) {
      if (action.kind !== "DEPOSIT_YIELD" || !earnReady) return "MISMATCH";
      const receipt = await c.getTransactionReceipt({ hash: txHash }).catch(() => null);
      if (!receipt) return "NOT_FINAL";
      const finalized = await c.getBlock({ blockTag: "finalized" });
      if (receipt.blockNumber > finalized.number) return "NOT_FINAL";
      if (receipt.status !== "success") return "MISMATCH";
      const events = parseEventLogs({ abi: everpieceEarnAbi, eventName: "EarnDeposited", logs: receipt.logs.filter((l) => getAddress(l.address) === getAddress(cfg.earn!)) });
      const ok = events.some((e) => getAddress(e.args.owner) === getAddress(owner) && getAddress(e.args.vault) === getAddress(cfg.earnVault!) && e.args.assets === amount);
      return ok ? "OK" : "MISMATCH";
    },
  };
  return { world, targets, verifier };
}
