import { loadConfig } from "./config.ts";
import { Relayer } from "./relayer.ts";
import { createHttpServer } from "./server.ts";
import { log } from "./log.ts";

const cfg = loadConfig();
const relayer = new Relayer(cfg);
await relayer.start();
const server = createHttpServer(relayer);
server.listen(cfg.port, cfg.host, () => log("info", "http.listening", { host: cfg.host, port: cfg.port }));

const shutdown = async () => {
  server.close();
  await relayer.stop();
  relayer.store.close();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
