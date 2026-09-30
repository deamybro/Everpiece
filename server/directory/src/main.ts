import { loadConfig } from "./config.ts";
import { DirectoryService } from "./directory.ts";
import { createDirectoryServer } from "./server.ts";
import { log } from "./log.ts";

const cfg = loadConfig();
const svc = new DirectoryService(cfg);
await svc.start();
const server = createDirectoryServer(svc);
server.listen(cfg.port, cfg.host, () => log("info", "http.listening", { host: cfg.host, port: cfg.port }));
const shutdown = () => {
  server.close();
  svc.store.close();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
