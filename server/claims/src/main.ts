import { loadConfig } from "./config.ts";
import { ClaimsService } from "./claims.ts";
import { emailProviderFromConfig, providerFromConfig } from "./providers.ts";
import { createClaimsServer } from "./server.ts";
import { maskEmail, maskPhone } from "./phone.ts";
import { log } from "./log.ts";

const cfg = loadConfig();
// SIMULATED providers only (config already refuses them on a non-local RPC): optionally print the fake text/email so
// a local tester can read it. Real providers never expose codes.
const simulatedSink =
  cfg.smsProvider === "simulated" && process.env.SIMULATED_SMS_STDOUT === "1"
    ? (e164: string, code: string) => process.stdout.write(`SIMULATED_SMS ${JSON.stringify({ to: maskPhone(e164), code, at: new Date().toISOString() })}\n`)
    : undefined;
const simulatedEmailSink =
  cfg.emailProvider === "simulated" && process.env.SIMULATED_EMAIL_STDOUT === "1"
    ? (email: string, code: string) => process.stdout.write(`SIMULATED_EMAIL ${JSON.stringify({ to: maskEmail(email), code, at: new Date().toISOString() })}\n`)
    : undefined;
const svc = new ClaimsService(cfg, providerFromConfig(cfg, simulatedSink), { emailProvider: emailProviderFromConfig(cfg, simulatedEmailSink) });
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
