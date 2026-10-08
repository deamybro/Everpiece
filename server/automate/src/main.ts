import { getAddress } from "viem";
import { loadConfig } from "./config.ts";
import { AutomateService, type LegVerifier, type TargetRegistry, type WorldReader } from "./service.ts";
import { createAutomateServer } from "./server.ts";
import { chainWorld } from "./world.ts";
import { startWatcher } from "./watcher.ts";
import { log } from "./log.ts";

// With MONAD_RPC + AUSD_ADDRESS the world is read from the chain at finality (balances, Earn principal/value, leg
// proofs); Earn is a target only when EARN_ADDRESS/EARN_VAULT_ADDRESS/EARN_OPPORTUNITY_ID are all set. Without them,
// every target is UNAVAILABLE and no leg can be proven: rules can be created and planned, and nothing moves.
const env = process.env;
const fromChain = env.MONAD_RPC && env.AUSD_ADDRESS
  ? chainWorld({
      rpcUrl: env.MONAD_RPC, ausd: getAddress(env.AUSD_ADDRESS),
      earn: env.EARN_ADDRESS ? getAddress(env.EARN_ADDRESS) : undefined,
      earnVault: env.EARN_VAULT_ADDRESS ? getAddress(env.EARN_VAULT_ADDRESS) : undefined,
      earnOpportunityId: env.EARN_OPPORTUNITY_ID || undefined,
    })
  : null;
const world: WorldReader = fromChain?.world ?? { balance: async () => 0n, reserved: async () => 0n, harvestable: async () => 0n };
const targets: TargetRegistry = fromChain?.targets ?? { availability: () => ({ status: "UNAVAILABLE", reason: "PROVIDER_NOT_REGISTERED" }) };
const verifier: LegVerifier = fromChain?.verifier ?? { verify: async () => "MISMATCH" };

const cfg = loadConfig();
const svc = new AutomateService(cfg, world, targets, verifier);
const server = createAutomateServer(svc);
server.listen(cfg.port, cfg.host, () => log("info", "automate.startup", { host: cfg.host, port: cfg.port, chainId: cfg.expectedChainId, chain: Boolean(fromChain), earn: Boolean(env.EARN_ADDRESS) }));
const sweeper = setInterval(() => svc.sweep(), 60_000);
const stopWatcher = env.INDEXER_URL
  ? startWatcher(svc, { indexerUrl: env.INDEXER_URL, pollMs: Number(env.WATCH_POLL_MS || 15_000), checkEverySec: Number(env.CHECK_EVERY_SEC || 600) })
  : () => {};
const shutdown = () => {
  clearInterval(sweeper);
  stopWatcher();
  server.close();
  svc.store.close();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
