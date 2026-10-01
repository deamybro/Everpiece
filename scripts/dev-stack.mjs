#!/usr/bin/env node
// Everpiece LOCAL TEST STACK — test Dollars only, nothing touches mainnet.
//   anvil fork of Monad mainnet (real AUSD code, Monad-like finality: finalized = latest-2)
//   + freshly deployed EverpieceEscrow + relayer + claims server (SIMULATED SMS) + username directory + dev faucet + web (next dev)
// Fresh random dev keys every run, held in memory only. Usage: npm run dev:stack   (then open http://localhost:3000)
// Container use (deploy/test-stack): STACK_BIND_HOST=0.0.0.0 listens on the container's interfaces (Docker publishes
// them on the host's 127.0.0.1 only); STACK_WEB=prod runs next build + next start instead of next dev (far less memory);
// STACK_WEB_BUILDER=webpack builds with webpack (peak ~0.75 GB vs >1.15 GB for Turbopack, measured on the test host).
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createPublicClient, createTestClient, createWalletClient, defineChain, encodeAbiParameters, http, keccak256, parseEther, toHex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const FORK_URL = process.env.MONAD_RPC ?? "https://rpc.monad.xyz";
const P = { anvil: 8545, relayer: 8787, claims: 8788, directory: 8789, faucet: 8790, web: 3000 };
const BIND = process.env.STACK_BIND_HOST ?? "127.0.0.1";
const WEB_PROD = process.env.STACK_WEB === "prod";
// Container use: where to publish this run's escrow for the indexer (deploy/test-stack). Removed at start, so a stale
// file never points the indexer at a previous run's chain.
const INFO_FILE = process.env.STACK_INFO_FILE;
if (INFO_FILE) rmSync(INFO_FILE, { force: true });
// Browser-facing ports. STACK_PUBLIC_PORT_BASE (container use) moves them to base+0..5 (web, anvil, relayer, claims,
// directory, faucet), so an SSH tunnel can use the same numbers on both ends without clashing with other local
// tunnels. Services still listen on P inside.
const BASE = process.env.STACK_PUBLIC_PORT_BASE ? Number(process.env.STACK_PUBLIC_PORT_BASE) : null;
const PUB = BASE === null ? P : { web: BASE, anvil: BASE + 1, relayer: BASE + 2, claims: BASE + 3, directory: BASE + 4, faucet: BASE + 5 };
// Public test site (deploy/test-stack behind Caddy): STACK_PUBLIC_ORIGIN puts everything on one HTTPS origin, services
// under /svc/<name> (Caddy strips the prefix). The raw fork RPC is never public: the browser uses the faucet's filtered
// /rpc (read-only methods, escrow + AUSD only), because anvil's own methods could set balances or impersonate accounts.
const ORIGIN = process.env.STACK_PUBLIC_ORIGIN ? process.env.STACK_PUBLIC_ORIGIN.replace(/\/$/, "") : null;
const pubUrl = (svc, port) => (ORIGIN ? `${ORIGIN}/svc/${svc}` : `http://127.0.0.1:${port}`);
const WEB_ORIGIN = ORIGIN ?? `http://localhost:${PUB.web}`;
const RPC = `http://127.0.0.1:${P.anvil}`;
const AUSD = "0x00000000eFE302BEAA2b3e6e1b18d08D69a9012a";
const CORE_SLOT = "0x455730fed596673e69db1907be2e521374ba893f1a04cc5f5dd931616cd6b700"; // VERIFIED §2.12
const children = [];
const smsOutbox = [];

const say = (m) => process.stdout.write(`\x1b[35m[dev-stack]\x1b[0m ${m}\n`);
function run(name, cmd, args, opts = {}) {
  const c = spawn(cmd, args, { cwd: root, env: { ...process.env, ...opts.env }, stdio: ["ignore", "pipe", "pipe"], ...opts.spawn });
  children.push(c);
  const onLine = (buf) => {
    for (const line of buf.toString().split(/\r?\n/)) {
      if (!line.trim()) continue;
      if (line.startsWith("SIMULATED_SMS ") || line.startsWith("SIMULATED_EMAIL ")) {
        const kind = line.startsWith("SIMULATED_SMS ") ? "text" : "email";
        smsOutbox.unshift({ kind, ...JSON.parse(line.slice(line.indexOf(" ") + 1)) });
        say(`simulated ${kind} to ${smsOutbox[0].to} — see ${pubUrl("faucet", PUB.faucet)}/sms`);
      } else if (!opts.quiet) process.stdout.write(`\x1b[2m[${name}]\x1b[0m ${line}\n`);
    }
  };
  c.stdout.on("data", onLine);
  c.stderr.on("data", onLine);
  c.on("exit", (code) => code && say(`${name} exited with ${code}`));
  return c;
}
function shutdown() {
  for (const c of children) c.kill();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

async function waitFor(url, body) {
  for (let i = 0; i < 160; i++) {
    try {
      const r = await fetch(url, body ? { method: "POST", headers: { "content-type": "application/json" }, body } : undefined);
      if (r.ok || r.status < 500) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`timeout waiting for ${url}`);
}

// 1. contracts artifact
if (!existsSync(join(root, "contracts/out/EverpieceEscrow.sol/EverpieceEscrow.json"))) {
  say("building contracts (forge build)…");
  const b = spawnSync("forge", ["build"], { cwd: join(root, "contracts"), stdio: "inherit", shell: process.platform === "win32" });
  if (b.status !== 0) throw new Error("forge build failed — install Foundry 1.8.3 (see README.md)");
}

// 2. anvil fork with Monad-like finality
say(`starting local fork of Monad mainnet (${FORK_URL})…`);
run("anvil", "anvil", ["--network", "monad", "--fork-url", FORK_URL, "--port", String(P.anvil), "--host", BIND, "--slots-in-an-epoch", "1", "--block-time", "1", "--silent"], {
  spawn: { shell: process.platform === "win32" },
});
await waitFor(RPC, '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}');

const chain = defineChain({ id: 143, name: "monad-fork", nativeCurrency: { name: "MON", symbol: "MON", decimals: 18 }, rpcUrls: { default: { http: [RPC] } } });
const pub = createPublicClient({ chain, transport: http(RPC) });
const test = createTestClient({ chain, mode: "anvil", transport: http(RPC) });

// 3. fresh dev keys (memory only) and deployment
const keys = { deployer: generatePrivateKey(), owner: generatePrivateKey(), approver: generatePrivateKey(), relayer: generatePrivateKey() };
const acct = Object.fromEntries(Object.entries(keys).map(([k, v]) => [k, privateKeyToAccount(v)]));
for (const a of [acct.deployer, acct.relayer]) await test.setBalance({ address: a.address, value: parseEther("100") });
const artifact = JSON.parse(readFileSync(join(root, "contracts/out/EverpieceEscrow.sol/EverpieceEscrow.json"), "utf8"));
const wallet = createWalletClient({ chain, transport: http(RPC), account: acct.deployer });
const hash = await wallet.deployContract({ abi: artifact.abi, bytecode: artifact.bytecode.object, args: [AUSD, acct.owner.address, acct.approver.address] });
const receipt = await pub.waitForTransactionReceipt({ hash });
const escrow = receipt.contractAddress;
say(`EverpieceEscrow deployed on the local fork at ${escrow}`);

// 4. web config
writeFileSync(
  join(root, "web/.env.local"),
  [
    "# written by scripts/dev-stack.mjs — LOCAL TEST STACK (not mainnet)",
    "NEXT_PUBLIC_CHAIN_ID=143",
    `NEXT_PUBLIC_MONAD_RPC=${ORIGIN ? `${ORIGIN}/svc/faucet/rpc` : `http://127.0.0.1:${PUB.anvil}`}`,
    `NEXT_PUBLIC_ESCROW_ADDRESS=${escrow}`,
    `NEXT_PUBLIC_RELAYER_URL=${pubUrl("relayer", PUB.relayer)}`,
    `NEXT_PUBLIC_CLAIMS_URL=${pubUrl("claims", PUB.claims)}`,
    `NEXT_PUBLIC_DIRECTORY_URL=${pubUrl("directory", PUB.directory)}`,
    `NEXT_PUBLIC_DEV_FAUCET_URL=${pubUrl("faucet", PUB.faucet)}`,
    "",
  ].join("\n"),
);

// 4b. production web build, before the services start so the build's memory peak doesn't stack on theirs
const nextBin = join(root, "node_modules/next/dist/bin/next");
if (WEB_PROD) {
  say("building the web app (next build)…");
  const b = spawnSync(process.execPath, [nextBin, "build", ...(process.env.STACK_WEB_BUILDER === "webpack" ? ["--webpack"] : [])], { cwd: join(root, "web"), stdio: "inherit", env: { ...process.env, NEXT_TELEMETRY_DISABLED: "1" } });
  if (b.status !== 0) throw new Error("next build failed");
}

// 5. services
const common = { MONAD_RPC: RPC, EXPECTED_CHAIN_ID: "143", ESCROW_ADDRESS: escrow, ALLOWED_ORIGIN: WEB_ORIGIN, LOG_LEVEL: "info", HOST: BIND,
  // Behind Caddy every request arrives from the proxy: rate-limit on the visitor's address it forwards instead.
  ...(ORIGIN ? { TRUST_PROXY: "1" } : {}) };
run("relayer", process.execPath, ["server/relayer/src/main.ts"], {
  env: { ...common, RELAYER_PRIVATE_KEY: keys.relayer, RELAYER_DB_PATH: ":memory:", PORT: String(P.relayer), MIN_RELAYER_BALANCE_WEI: parseEther("1").toString(), POLL_INTERVAL_MS: "300" },
});
run("claims", process.execPath, ["server/claims/src/main.ts"], {
  env: {
    ...common, APPROVER_PRIVATE_KEY: keys.approver, PHONE_ENC_KEY: generatePrivateKey(), CLAIMS_DB_PATH: ":memory:", PORT: String(P.claims),
    SMS_PROVIDER: "simulated", ALLOW_SIMULATED_SMS: "1", SIMULATED_SMS_STDOUT: "1",
    // Real email when a Resend key + From address are provided (deploy/test-stack: the host's .env); simulated otherwise.
    ...(process.env.RESEND_API_KEY && process.env.EMAIL_FROM
      ? { EMAIL_PROVIDER: "resend", RESEND_API_KEY: process.env.RESEND_API_KEY, EMAIL_FROM: process.env.EMAIL_FROM }
      : { EMAIL_PROVIDER: "simulated", ALLOW_SIMULATED_EMAIL: "1", SIMULATED_EMAIL_STDOUT: "1" }),
  },
});

run("directory", process.execPath, ["server/directory/src/main.ts"], {
  env: { ...common, DIRECTORY_DB_PATH: ":memory:", PORT: String(P.directory) },
});

// 6. dev faucet + simulated SMS outbox (LOCAL ONLY)
// Filtered, read-only JSON-RPC for the public test site: only what the web app reads, only for the escrow and AUSD.
const RPC_METHODS = new Set(["eth_chainId", "eth_blockNumber", "net_version", "eth_getBlockByNumber", "eth_call"]);
const BLOCK_TAGS = new Set(["latest", "safe", "finalized", "pending"]);
function rpcAllowed(m) {
  if (!m || m.jsonrpc !== "2.0" || !RPC_METHODS.has(m.method)) return false;
  const p = Array.isArray(m.params) ? m.params : [];
  if (m.method === "eth_getBlockByNumber") return BLOCK_TAGS.has(p[0]) && p[1] === false;
  if (m.method === "eth_call") {
    const to = typeof p[0]?.to === "string" ? p[0].to.toLowerCase() : "";
    return (to === escrow.toLowerCase() || to === AUSD.toLowerCase()) && (p[1] === undefined || BLOCK_TAGS.has(p[1]));
  }
  return true;
}
async function publicRpc(req, res) {
  let body = "";
  for await (const c of req) {
    body += c;
    if (body.length > 16_384) return res.writeHead(413).end();
  }
  let msg;
  try {
    msg = JSON.parse(body);
  } catch {
    return res.writeHead(400).end();
  }
  const batch = Array.isArray(msg) ? msg : [msg];
  if (batch.length === 0 || batch.length > 20 || !batch.every(rpcAllowed)) {
    res.writeHead(403, { "content-type": "application/json" });
    return res.end(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32601, message: "method not allowed on the public test RPC" } }));
  }
  const r = await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body }).catch(() => null);
  res.writeHead(r?.status ?? 502, { "content-type": "application/json" });
  return res.end(r ? await r.text() : "");
}

// One handler for the faucet port. Every failure — including a client that disconnects mid-request ("aborted",
// ECONNRESET) — is answered or dropped here: an unhandled rejection would take the whole stack (and its chain) down.
async function faucetHandler(req, res) {
  res.setHeader("access-control-allow-origin", WEB_ORIGIN);
  res.setHeader("access-control-allow-headers", "content-type");
  if (req.method === "OPTIONS") return res.writeHead(204).end();
  if (req.method === "GET" && req.url === "/sms") {
    const rows = smsOutbox.map((m) => `<li><b>${m.code}</b> → ${m.to} <small>(${m.kind}) ${m.at}</small></li>`).join("") || "<li>No texts or emails yet.</li>";
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    return res.end(`<!doctype html><meta name=viewport content="width=device-width"><title>Simulated texts and emails</title><body style="font-family:system-ui;padding:16px"><h2>Simulated texts and emails (local test network — nothing was sent)</h2><p>Latest first. The real app texts or emails the recipient instead.</p><ul>${rows}</ul><p><a href="/sms">Refresh</a></p>`);
  }
  if (req.method === "POST" && req.url === "/rpc") return publicRpc(req, res);
  if (req.method === "POST" && req.url === "/faucet") {
    let body = "";
    for await (const c of req) {
      body += c;
      if (body.length > 4096) return res.writeHead(413).end();
    }
    try {
      const { address } = JSON.parse(body);
      if (!/^0x[0-9a-fA-F]{40}$/.test(address)) throw new Error("bad address");
      const bal = await pub.readContract({ address: AUSD, abi: [{ type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] }], functionName: "balanceOf", args: [address] });
      const slot = keccak256(encodeAbiParameters([{ type: "address" }, { type: "bytes32" }], [address, CORE_SLOT]));
      await test.setStorageAt({ address: AUSD, index: slot, value: toHex((bal + 100_000_000n) << 8n, { size: 32 }) });
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ ok: true }));
    } catch (e) {
      res.writeHead(400, { "content-type": "application/json" });
      return res.end(JSON.stringify({ error: String(e) }));
    }
  }
  res.writeHead(404).end();
}
const faucetServer = createServer((req, res) => {
  faucetHandler(req, res).catch((e) => {
    if (!res.headersSent && !res.destroyed) res.writeHead(500).end();
    else res.destroy();
    if (!(e instanceof Error && e.message === "aborted")) say(`faucet request failed: ${String(e).slice(0, 120)}`);
  });
});
faucetServer.on("clientError", (_e, socket) => socket.destroy());
faucetServer.listen(P.faucet, BIND);

await waitFor(`http://127.0.0.1:${P.relayer}/healthz`);
await waitFor(`http://127.0.0.1:${P.claims}/healthz`);
await waitFor(`http://127.0.0.1:${P.directory}/healthz`);

// 7. web
const webArgs = [nextBin, WEB_PROD ? "start" : "dev", "--port", String(P.web), ...(process.env.STACK_BIND_HOST ? ["--hostname", BIND] : [])];
run("web", process.execPath, webArgs, { spawn: { cwd: join(root, "web") }, quiet: false });
await waitFor(`http://localhost:${P.web}`);
if (INFO_FILE) writeFileSync(INFO_FILE, JSON.stringify({ escrow, deployBlock: Number(receipt.blockNumber), startedAt: new Date().toISOString() }) + "\n");
say("");
say(`✅ Everpiece local test stack is up → open ${WEB_ORIGIN}`);
say(`   Test Dollars: "Get 100 test Dollars" button on Home. Simulated texts: ${pubUrl("faucet", PUB.faucet)}/sms`);
say("   Everything runs on a local fork of Monad mainnet; nothing is real money. Ctrl+C to stop.");
