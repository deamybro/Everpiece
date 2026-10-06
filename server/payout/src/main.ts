import { loadConfig } from "./config.ts";
import { PayoutService } from "./service.ts";
import { createPayoutServer } from "./server.ts";
import { log } from "./log.ts";

const cfg = loadConfig();
const svc = new PayoutService(cfg);
const server = createPayoutServer(svc);
server.listen(cfg.port, cfg.host, () => log("info", "payout.startup", { host: cfg.host, port: cfg.port, network: cfg.sourceNetwork, simulated: cfg.simulated }));
const shutdown = () => {
  server.close();
  svc.store.close();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
