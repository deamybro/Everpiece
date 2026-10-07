import { loadConfig } from "./config.ts";
import { AutomateService, type LegVerifier, type TargetRegistry, type WorldReader } from "./service.ts";
import { createAutomateServer } from "./server.ts";
import { log } from "./log.ts";

// Wiring of the outside world. Until the verified Earn/Invest providers are registered (docs/EARN.md, docs/INVEST.md),
// every target is UNAVAILABLE and no leg can be proven: rules can be created and planned, and nothing moves.
const world: WorldReader = {
  balance: async () => 0n,
  reserved: async () => 0n,
  harvestable: async () => 0n,
};
const targets: TargetRegistry = { availability: () => ({ status: "UNAVAILABLE", reason: "PROVIDER_NOT_REGISTERED" }) };
const verifier: LegVerifier = { verify: async () => "MISMATCH" };

const cfg = loadConfig();
const svc = new AutomateService(cfg, world, targets, verifier);
const server = createAutomateServer(svc);
server.listen(cfg.port, cfg.host, () => log("info", "automate.startup", { host: cfg.host, port: cfg.port, chainId: cfg.expectedChainId }));
const sweeper = setInterval(() => svc.sweep(), 60_000);
const shutdown = () => {
  clearInterval(sweeper);
  server.close();
  svc.store.close();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
