import { loadConfig } from "./config.ts";
import { VoiceService } from "./voice.ts";
import { createVoiceServer } from "./server.ts";
import { log } from "./log.ts";

const cfg = loadConfig();
const svc = new VoiceService(cfg);
await svc.start();
svc.sweep();
const sweeper = setInterval(() => svc.sweep(), 3_600_000);
const server = createVoiceServer(svc);
server.listen(cfg.port, cfg.host, () => log("info", "http.listening", { host: cfg.host, port: cfg.port }));
const shutdown = () => {
  clearInterval(sweeper);
  server.close();
  svc.store.close();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
