#!/usr/bin/env node
// Everpiece on MONAD TESTNET (10143): the public test site's stack (deploy/test-stack, STACK_SCRIPT=testnet-stack.mjs).
// Unlike dev-stack.mjs there is no fork and nothing is deployed here: it runs against the deployed TestDollar + escrow
// (scripts/deploy-testnet.mjs) with PERSISTENT keys (host .env) and databases (/data), so accounts, usernames and
// payments survive restarts. Test money only: TestDollar is worthless and minted by this faucet.
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createPublicClient, createWalletClient, defineChain, getAddress, http, isAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { MONAD_TESTNET_CHAIN_ID, TEST_DOLLAR_EIP712_NAME } from "@everpiece/shared";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const env = (n, d) => {
  // compose passes unset settings as empty strings: treat "" as unset so defaults apply
  const v = process.env[n] || d;
  if (!v) throw new Error(`testnet-stack: ${n} is required`);
  return v;
};
const RPC = env("TESTNET_RPC", "https://testnet-rpc.monad.xyz");
const ORIGIN = env("STACK_PUBLIC_ORIGIN").replace(/\/$/, "");
const DOLLAR = getAddress(env("TESTNET_DOLLAR_ADDRESS"));
const ESCROW = getAddress(env("TESTNET_ESCROW_ADDRESS"));
const ESCROW_BLOCK = Number(env("TESTNET_ESCROW_BLOCK"));
const DATA = env("STACK_DATA_DIR", "/data");
const BIND = env("STACK_BIND_HOST", "0.0.0.0");
const INFO_FILE = process.env.STACK_INFO_FILE;
const P = { relayer: 8787, claims: 8788, directory: 8789, faucet: 8790, web: 3000 };
const svc = (name) => `${ORIGIN}/svc/${name}`;
const children = [];

const say = (m) => process.stdout.write(`\x1b[35m[testnet-stack]\x1b[0m ${m}\n`);
function run(name, args, extraEnv = {}, cwd = root) {
  const c = spawn(process.execPath, args, { cwd, env: { ...process.env, ...extraEnv }, stdio: ["ignore", "pipe", "pipe"] });
  children.push(c);
  const onLine = (buf) => {
    for (const line of buf.toString().split(/\r?\n/)) if (line.trim()) process.stdout.write(`\x1b[2m[${name}]\x1b[0m ${line}\n`);
  };
  c.stdout.on("data", onLine);
  c.stderr.on("data", onLine);
  // A service dying takes the stack down so the container restarts it (persistent state survives).
  c.on("exit", (code) => {
    say(`${name} exited with ${code}`);
    shutdown(1);
  });
  return c;
}
function shutdown(code = 0) {
  for (const c of children) c.kill();
  process.exit(code);
}
process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));

async function waitFor(url) {
  for (let i = 0; i < 240; i++) {
    try {
      const r = await fetch(url);
      if (r.status < 500) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`timeout waiting for ${url}`);
}

const chain = defineChain({ id: MONAD_TESTNET_CHAIN_ID, name: "monad-testnet", nativeCurrency: { name: "MON", symbol: "MON", decimals: 18 }, rpcUrls: { default: { http: [RPC] } } });
const pub = createPublicClient({ chain, transport: http(RPC, { timeout: 20_000, retryCount: 2 }) });
const chainId = await pub.getChainId();
if (chainId !== MONAD_TESTNET_CHAIN_ID) throw new Error(`testnet-stack: RPC chainId ${chainId} is not Monad testnet`);
if (INFO_FILE) rmSync(INFO_FILE, { force: true });
mkdirSync(DATA, { recursive: true });
say(`Monad testnet ${chainId}: TestDollar ${DOLLAR}, escrow ${ESCROW} (from block ${ESCROW_BLOCK})`);

// 1. web config (build-time) + production build before the services start (memory peak alone)
writeFileSync(
  join(root, "web/.env.local"),
  [
    "# written by scripts/testnet-stack.mjs — MONAD TESTNET (test money only)",
    `NEXT_PUBLIC_CHAIN_ID=${MONAD_TESTNET_CHAIN_ID}`,
    `NEXT_PUBLIC_MONAD_RPC=${RPC}`,
    `NEXT_PUBLIC_ESCROW_ADDRESS=${ESCROW}`,
    `NEXT_PUBLIC_DOLLAR_ADDRESS=${DOLLAR}`,
    `NEXT_PUBLIC_DOLLAR_EIP712_NAME=${TEST_DOLLAR_EIP712_NAME}`,
    `NEXT_PUBLIC_RELAYER_URL=${svc("relayer")}`,
    `NEXT_PUBLIC_CLAIMS_URL=${svc("claims")}`,
    `NEXT_PUBLIC_DIRECTORY_URL=${svc("directory")}`,
    `NEXT_PUBLIC_DEV_FAUCET_URL=${svc("faucet")}`,
    `NEXT_PUBLIC_INDEXER_URL=${svc("indexer")}/v1/graphql`,
    "NEXT_PUBLIC_NETWORK_LABEL=Monad testnet",
    "",
  ].join("\n"),
);
const nextBin = join(root, "node_modules/next/dist/bin/next");
say("building the web app (next build)…");
const b = spawnSync(process.execPath, [nextBin, "build", "--webpack"], { cwd: join(root, "web"), stdio: "inherit", env: { ...process.env, NEXT_TELEMETRY_DISABLED: "1" } });
if (b.status !== 0) throw new Error("next build failed");

// 2. services, with persistent keys and databases
const common = { MONAD_RPC: RPC, EXPECTED_CHAIN_ID: String(MONAD_TESTNET_CHAIN_ID), ESCROW_ADDRESS: ESCROW, ALLOWED_ORIGIN: ORIGIN, LOG_LEVEL: "info", HOST: BIND, TRUST_PROXY: "1" };
run("relayer", ["server/relayer/src/main.ts"], {
  ...common, RELAYER_PRIVATE_KEY: env("TESTNET_RELAYER_KEY"), RELAYER_DB_PATH: join(DATA, "relayer.sqlite"), PORT: String(P.relayer),
  AUSD_ADDRESS: DOLLAR, DOLLAR_EIP712_NAME: TEST_DOLLAR_EIP712_NAME, MIN_RELAYER_BALANCE_WEI: String(2n * 10n ** 17n), // 0.2 MON
});
const twilio = process.env.TWILIO_API_USER && process.env.TWILIO_API_SECRET && process.env.TWILIO_VERIFY_SERVICE_SID;
run("claims", ["server/claims/src/main.ts"], {
  ...common, APPROVER_PRIVATE_KEY: env("TESTNET_APPROVER_KEY"), PHONE_ENC_KEY: env("TESTNET_PHONE_ENC_KEY"),
  CLAIMS_DB_PATH: join(DATA, "claims.sqlite"), PORT: String(P.claims),
  // Not localhost, so the claims server refuses SIMULATED providers: only real SMS/email here.
  ...(twilio ? { SMS_PROVIDER: "twilio", TWILIO_API_USER: process.env.TWILIO_API_USER, TWILIO_API_SECRET: process.env.TWILIO_API_SECRET, TWILIO_VERIFY_SERVICE_SID: process.env.TWILIO_VERIFY_SERVICE_SID } : {}),
  ...(process.env.RESEND_API_KEY && process.env.EMAIL_FROM ? { EMAIL_PROVIDER: "resend", RESEND_API_KEY: process.env.RESEND_API_KEY, EMAIL_FROM: process.env.EMAIL_FROM } : {}),
});
run("directory", ["server/directory/src/main.ts"], {
  ...common, DIRECTORY_DB_PATH: join(DATA, "directory.sqlite"), PORT: String(P.directory),
  ...(process.env.REGISTRATIONS_PER_IP_PER_DAY ? { REGISTRATIONS_PER_IP_PER_DAY: process.env.REGISTRATIONS_PER_IP_PER_DAY } : {}),
});

// 3. faucet: mints TestDollar with the deployer (= TestDollar.minter). One mint at a time (nonce order);
//    per-address cooldown and per-IP daily cap, so the minter's MON lasts.
const minter = privateKeyToAccount(env("TESTNET_DEPLOYER_KEY"));
const wallet = createWalletClient({ chain, transport: http(RPC, { timeout: 20_000, retryCount: 2 }), account: minter });
const mintAbi = [{ type: "function", name: "mint", stateMutability: "nonpayable", inputs: [{ type: "address" }, { type: "uint256" }], outputs: [] }];
const lastByAddress = new Map();
const byIpDay = new Map();
let queue = Promise.resolve();
const ADDRESS_COOLDOWN_MS = 10 * 60_000;
const IP_PER_DAY = 20;
const mintTo = (address) =>
  (queue = queue.then(async () => {
    const hash = await wallet.writeContract({ address: DOLLAR, abi: mintAbi, functionName: "mint", args: [address, 100_000_000n], chain: null });
    const r = await pub.waitForTransactionReceipt({ hash, timeout: 60_000 });
    if (r.status !== "success") throw new Error("mint reverted");
    return hash;
  }));

async function faucetHandler(req, res) {
  res.setHeader("access-control-allow-origin", ORIGIN);
  res.setHeader("access-control-allow-headers", "content-type");
  if (req.method === "OPTIONS") return res.writeHead(204).end();
  if (req.method === "POST" && req.url === "/faucet") {
    let body = "";
    for await (const c of req) {
      body += c;
      if (body.length > 1024) return res.writeHead(413).end();
    }
    let address;
    try {
      address = JSON.parse(body).address;
    } catch {
      return res.writeHead(400).end();
    }
    if (typeof address !== "string" || !isAddress(address)) return json(res, 400, { error: "bad address" });
    address = getAddress(address);
    const now = Date.now();
    const ip = String(req.headers["x-forwarded-for"] ?? "").split(",")[0].trim() || req.socket.remoteAddress || "?";
    const day = new Date().toISOString().slice(0, 10);
    const ipKey = `${ip}:${day}`;
    if (now - (lastByAddress.get(address) ?? 0) < ADDRESS_COOLDOWN_MS) return json(res, 429, { error: "This account got test Dollars recently. Try again in a few minutes." });
    if ((byIpDay.get(ipKey) ?? 0) >= IP_PER_DAY) return json(res, 429, { error: "Daily test Dollar limit reached for this network." });
    lastByAddress.set(address, now);
    byIpDay.set(ipKey, (byIpDay.get(ipKey) ?? 0) + 1);
    try {
      const hash = await mintTo(address);
      return json(res, 200, { ok: true, hash });
    } catch (e) {
      lastByAddress.delete(address);
      say(`faucet mint failed: ${String(e?.shortMessage ?? e).slice(0, 120)}`);
      return json(res, 503, { error: "Test Dollars are unavailable right now." });
    }
  }
  if (req.method === "GET" && req.url === "/sms") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    return res.end("<!doctype html><title>Everpiece testnet</title><p>On Monad testnet, codes are sent by real SMS (Twilio) or email (Resend). Nothing is simulated.</p>");
  }
  res.writeHead(404).end();
}
const json = (res, status, body) => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
};
const faucetServer = createServer((req, res) => {
  faucetHandler(req, res).catch(() => {
    if (!res.headersSent && !res.destroyed) res.writeHead(500).end();
    else res.destroy();
  });
});
faucetServer.on("clientError", (_e, socket) => socket.destroy());
faucetServer.listen(P.faucet, BIND);

await waitFor(`http://127.0.0.1:${P.relayer}/healthz`);
await waitFor(`http://127.0.0.1:${P.claims}/healthz`);
await waitFor(`http://127.0.0.1:${P.directory}/healthz`);

// 4. web, then tell the indexer what to index (stable content: it only re-indexes when the escrow changes)
run("web", [nextBin, "start", "--port", String(P.web), "--hostname", BIND], {}, join(root, "web"));
await waitFor(`http://127.0.0.1:${P.web}`);
if (INFO_FILE) writeFileSync(INFO_FILE, JSON.stringify({ escrow: ESCROW, deployBlock: ESCROW_BLOCK, chainId: MONAD_TESTNET_CHAIN_ID, rpc: RPC }) + "\n");
say(`✅ Everpiece on Monad testnet is up → ${ORIGIN}`);
