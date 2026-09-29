import { loadConfig } from "./config.ts";
import { ClaimsService } from "./claims.ts";
import { providerFromConfig } from "./providers.ts";
import { createClaimsServer } from "./server.ts";
import { log } from "./log.ts";

const cfg = loadConfig();
const svc = new ClaimsService(cfg, providerFromConfig(cfg));
await svc.start();
const server = createClaimsServer(svc);
server.listen(cfg.port, cfg.host, () => log("info", "http.listening", { host: cfg.host, port: cfg.port }));
const shutdown = () => {
  server.close();
  svc.store.close();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
