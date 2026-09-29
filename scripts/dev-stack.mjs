#!/usr/bin/env node
// Everpiece LOCAL TEST STACK — test Dollars only, nothing touches mainnet.
//   anvil fork of Monad mainnet (real AUSD code, Monad-like finality: finalized = latest-2)
//   + freshly deployed EverpieceEscrow + relayer + claims server (SIMULATED SMS) + dev faucet + web (next dev)
// Fresh random dev keys every run, held in memory only. Usage: npm run dev:stack   (then open http://localhost:3000)
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createPublicClient, createTestClient, createWalletClient, defineChain, encodeAbiParameters, http, keccak256, parseEther, toHex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const FORK_URL = process.env.MONAD_RPC ?? "https://rpc.monad.xyz";
const P = { anvil: 8545, relayer: 8787, claims: 8788, faucet: 8790, web: 3000 };
const WEB_ORIGIN = `http://localhost:${P.web}`;
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
      if (line.startsWith("SIMULATED_SMS ")) {
        smsOutbox.unshift(JSON.parse(line.slice(14)));
        say(`simulated text to ${smsOutbox[0].to} — see http://127.0.0.1:${P.faucet}/sms`);
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
run("anvil", "anvil", ["--network", "monad", "--fork-url", FORK_URL, "--port", String(P.anvil), "--slots-in-an-epoch", "1", "--block-time", "1", "--silent"], {
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
const escrow = (await pub.waitForTransactionReceipt({ hash })).contractAddress;
say(`EverpieceEscrow deployed on the local fork at ${escrow}`);

// 4. web config
writeFileSync(
  join(root, "web/.env.local"),
  [
    "# written by scripts/dev-stack.mjs — LOCAL TEST STACK (not mainnet)",
    "NEXT_PUBLIC_CHAIN_ID=143",
    `NEXT_PUBLIC_MONAD_RPC=${RPC}`,
    `NEXT_PUBLIC_ESCROW_ADDRESS=${escrow}`,
    `NEXT_PUBLIC_RELAYER_URL=http://127.0.0.1:${P.relayer}`,
    `NEXT_PUBLIC_CLAIMS_URL=http://127.0.0.1:${P.claims}`,
    `NEXT_PUBLIC_DEV_FAUCET_URL=http://127.0.0.1:${P.faucet}`,
    "",
  ].join("\n"),
);

// 5. services
const common = { MONAD_RPC: RPC, EXPECTED_CHAIN_ID: "143", ESCROW_ADDRESS: escrow, ALLOWED_ORIGIN: WEB_ORIGIN, LOG_LEVEL: "info" };
run("relayer", process.execPath, ["server/relayer/src/main.ts"], {
  env: { ...common, RELAYER_PRIVATE_KEY: keys.relayer, RELAYER_DB_PATH: ":memory:", PORT: String(P.relayer), MIN_RELAYER_BALANCE_WEI: parseEther("1").toString(), POLL_INTERVAL_MS: "300" },
});
run("claims", process.execPath, ["server/claims/src/main.ts"], {
  env: {
    ...common, APPROVER_PRIVATE_KEY: keys.approver, PHONE_ENC_KEY: generatePrivateKey(), CLAIMS_DB_PATH: ":memory:", PORT: String(P.claims),
    SMS_PROVIDER: "simulated", ALLOW_SIMULATED_SMS: "1", SIMULATED_SMS_STDOUT: "1",
  },
});

// 6. dev faucet + simulated SMS outbox (LOCAL ONLY)
createServer(async (req, res) => {
  res.setHeader("access-control-allow-origin", WEB_ORIGIN);
  res.setHeader("access-control-allow-headers", "content-type");
  if (req.method === "OPTIONS") return res.writeHead(204).end();
  if (req.method === "GET" && req.url === "/sms") {
    const rows = smsOutbox.map((m) => `<li><b>${m.code}</b> → ${m.to} <small>${m.at}</small></li>`).join("") || "<li>No texts yet.</li>";
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    return res.end(`<!doctype html><meta name=viewport content="width=device-width"><title>Simulated SMS</title><body style="font-family:system-ui;padding:16px"><h2>Simulated texts (local test network — nothing was sent)</h2><p>Latest first. The real app texts the recipient's phone instead.</p><ul>${rows}</ul><p><a href="/sms">Refresh</a></p>`);
  }
  if (req.method === "POST" && req.url === "/faucet") {
    let body = "";
    for await (const c of req) body += c;
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
}).listen(P.faucet, "127.0.0.1");

await waitFor(`http://127.0.0.1:${P.relayer}/healthz`);
await waitFor(`http://127.0.0.1:${P.claims}/healthz`);

// 7. web
run("web", process.execPath, [join(root, "node_modules/next/dist/bin/next"), "dev", "--port", String(P.web)], { spawn: { cwd: join(root, "web") }, quiet: false });
await waitFor(WEB_ORIGIN);
say("");
say(`✅ Everpiece local test stack is up → open ${WEB_ORIGIN}`);
say(`   Test Dollars: "Get 100 test Dollars" button on Home. Simulated texts: http://127.0.0.1:${P.faucet}/sms`);
say("   Everything runs on a local fork of Monad mainnet; nothing is real money. Ctrl+C to stop.");
