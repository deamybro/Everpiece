import { createPublicClient, getAddress, http, keccak256, parseAbi, toBytes, type Address, type Hex, type PublicClient } from "viem";
import { EARN_OPPORTUNITIES, everpieceAutomateAbi, grantIdOf, grantMatchesRule, type AutomationRule, type Grant } from "@everpiece/shared";
import type { ModuleExecutor } from "./service.ts";
import { log } from "./log.ts";

/**
 * BOUNDED_MODULE executor (docs/AUTOMATE.md §5): reads EverpieceAutomate at "finalized" and asks the relayer's
 * internal route to execute. The contract enforces vault, caps, expiry, executor and idempotency on-chain; this
 * service holds no keys and can't move money anywhere but the owner's own Earn position.
 */
export type ModuleConfig = {
  rpcUrl: string;
  chainId: number;
  automate: Address;
  /** The relayer EOA named as executor in grants. */
  executor: Address;
  relayerUrl: string;
  relayerInternalKey: string;
  /** Share-price tolerance between plan and execution (Aave static aTokens only appreciate). */
  minSharesBps?: bigint;
  pollMs?: number;
  timeoutMs?: number;
};

const erc4626 = parseAbi(["function previewDeposit(uint256) view returns (uint256)"]);

export function moduleExecutor(cfg: ModuleConfig, client?: PublicClient, fetchFn: typeof fetch = fetch): ModuleExecutor {
  const c = client ?? (createPublicClient({ transport: http(cfg.rpcUrl, { timeout: 20_000, retryCount: 3 }) }) as PublicClient);
  const tol = cfg.minSharesBps ?? 10n;

  return {
    async verifyGrant(rule: AutomationRule, grant: Grant) {
      if (!grantMatchesRule(grant, rule)) return { problem: "GRANT_DOES_NOT_MATCH_RULE" };
      if (getAddress(grant.executor) !== getAddress(cfg.executor)) return { problem: "WRONG_EXECUTOR" };
      // the grant's vault must be the Earn target the rule names (a verified opportunity on this chain)
      const vaults = rule.actions
        .filter((a): a is Extract<typeof a, { kind: "DEPOSIT_YIELD" }> => a.kind === "DEPOSIT_YIELD")
        .map((a) => EARN_OPPORTUNITIES.find((o) => o.id === a.opportunityId && o.chainId === cfg.chainId)?.vault)
        .filter((v): v is Address => Boolean(v))
        .map((v) => getAddress(v));
      if (!vaults.includes(getAddress(grant.vault))) return { problem: "GRANT_VAULT_NOT_IN_RULE" };
      const grantId = grantIdOf(cfg.automate, cfg.chainId, grant);
      const st = (await c.readContract({ address: cfg.automate, abi: everpieceAutomateAbi, functionName: "grants", args: [grantId], blockTag: "finalized" })) as readonly unknown[];
      if (/^0x0{40}$/i.test(st[0] as string)) return { problem: "GRANT_NOT_ACTIVE" };
      if (getAddress(st[0] as Address) !== getAddress(grant.owner)) return { problem: "GRANT_DOES_NOT_MATCH_RULE" };
      if (st[8] === true) return { problem: "GRANT_REVOKED" };
      return { grantId, vault: getAddress(grant.vault) };
    },

    async execute(grantId: Hex, legKey: string, assets: bigint, vault: Address) {
      try {
        const executionId = keccak256(toBytes(legKey)); // the leg's idempotency key, as the on-chain execution id
        // already ran (a retry after a timeout, or a restart): report the real transaction, never run twice
        const done = await c.readContract({ address: cfg.automate, abi: everpieceAutomateAbi, functionName: "executed", args: [executionId], blockTag: "finalized" });
        if (done) {
          const logs = await c.getContractEvents({ address: cfg.automate, abi: everpieceAutomateAbi, eventName: "Executed", args: { grantId, executionId }, fromBlock: "earliest", toBlock: "finalized" });
          const tx = logs[0]?.transactionHash;
          return tx ? { ok: true, txHash: tx } : { ok: false, reason: "EXECUTION_STILL_PENDING" };
        }
        const preview = await c.readContract({ address: vault, abi: erc4626, functionName: "previewDeposit", args: [assets] });
        const minShares = (preview * (10_000n - tol)) / 10_000n;
        const r = await fetchFn(`${cfg.relayerUrl}/v1/internal/automate/execute`, {
          method: "POST",
          headers: { "content-type": "application/json", "x-internal-key": cfg.relayerInternalKey },
          body: JSON.stringify({ grantId, executionId, assets: assets.toString(), minShares: minShares.toString() }),
        });
        const body = (await r.json().catch(() => ({}))) as Record<string, unknown>;
        if (r.status !== 200 && r.status !== 202) return { ok: false, reason: String(body.error ?? `RELAYER_${r.status}`) };
        const until = Date.now() + (cfg.timeoutMs ?? 180_000);
        for (;;) {
          const s = (await (await fetchFn(`${cfg.relayerUrl}/v1/requests/${String(body.requestId)}`)).json()) as Record<string, unknown>;
          if (s.status === "CONFIRMED" && typeof s.txHash === "string") return { ok: true, txHash: s.txHash as Hex };
          if (s.status === "FAILED" || s.status === "REJECTED") return { ok: false, reason: String(s.error ?? "EXECUTION_FAILED") };
          if (Date.now() > until) return { ok: false, reason: "EXECUTION_STILL_PENDING" };
          await new Promise((res) => setTimeout(res, cfg.pollMs ?? 1_500));
        }
      } catch (e) {
        log("warn", "module.execute_error", { err: String(e).slice(0, 160) });
        return { ok: false, reason: "RELAYER_UNREACHABLE" };
      }
    },
  };
}
