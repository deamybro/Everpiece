#!/usr/bin/env node
// Everpiece on MONAD TESTNET (10143): the public test site's stack (deploy/test-stack, STACK_SCRIPT=testnet-stack.mjs).
// Unlike dev-stack.mjs there is no fork and nothing is deployed here: it runs against the deployed TestDollar + escrow
// (scripts/deploy-testnet.mjs) with PERSISTENT keys (host .env) and databases (/data), so accounts, usernames and
// payments survive restarts. Test money only: TestDollar is worthless and minted by this faucet.
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { startAuroraSimulator } from "./aurora-sim.mjs";
import { startPaycrestSimulator } from "./paycrest-sim.mjs";
import { randomBytes } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createPublicClient, createWalletClient, defineChain, getAddress, http, isAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  AGORA_TESTNET, AUSD_EIP712_NAME, AUSD_TESTNET_ADDRESS, CTK_TESTNET_ADDRESS, MONAD_TESTNET_CHAIN_ID, TEST_DOLLAR_EIP712_NAME,
  agoraPairAbi, agoraWhitelisterAbi,
} from "@everpiece/shared";

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
// Real Agora AUSD on testnet (docs/INTEGRATION_VERIFICATION.md) unless an old TestDollar deployment is configured.
const REAL_AUSD = DOLLAR === AUSD_TESTNET_ADDRESS;
const DOLLAR_NAME = REAL_AUSD ? AUSD_EIP712_NAME : TEST_DOLLAR_EIP712_NAME;
const PAY = process.env.TESTNET_PAY_ADDRESS ? getAddress(process.env.TESTNET_PAY_ADDRESS) : "";
const PAY_BLOCK = Number(process.env.TESTNET_PAY_BLOCK || ESCROW_BLOCK);
// @usernames and message keys are signed in a domain whose verifyingContract was the first escrow: keep it pinned.
const DIRECTORY_DOMAIN = process.env.TESTNET_DIRECTORY_DOMAIN ? getAddress(process.env.TESTNET_DIRECTORY_DOMAIN) : ESCROW;
const DATA = env("STACK_DATA_DIR", "/data");
const BIND = env("STACK_BIND_HOST", "0.0.0.0");
const INFO_FILE = process.env.STACK_INFO_FILE;
const P = { relayer: 8787, claims: 8788, directory: 8789, faucet: 8790, voice: 8791, aurora: 8792, payout: 8793, paycrest: 8794, web: 3000 };
// Last mile (docs/PAYOUT.md): the payout server + a SIMULATED Paycrest (scripts/paycrest-sim.mjs; Paycrest is mainnet-only).
const PAYOUT = Boolean(PAY && process.env.TESTNET_PAYOUT_ENC_KEY);
const SIM_PAYCREST = { key: randomBytes(16).toString("hex"), secret: randomBytes(32).toString("hex") };
// "Add Dollars from another chain": Aurora is mainnet-only, so the test site runs a SIMULATED Aurora (scripts/aurora-sim.mjs)
// that delivers test CTK, the token this deployment converts to AUSD. Needs EverpiecePay for the conversion.
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
say(`Monad testnet ${chainId}: ${REAL_AUSD ? "Agora AUSD" : "TestDollar"} ${DOLLAR}, escrow ${ESCROW} (from block ${ESCROW_BLOCK}), pay ${PAY || "(none)"}`);

// 1. web config (build-time) + production build before the services start (memory peak alone)
writeFileSync(
  join(root, "web/.env.local"),
  [
    "# written by scripts/testnet-stack.mjs — MONAD TESTNET (test money only)",
    `NEXT_PUBLIC_CHAIN_ID=${MONAD_TESTNET_CHAIN_ID}`,
    `NEXT_PUBLIC_MONAD_RPC=${RPC}`,
    `NEXT_PUBLIC_ESCROW_ADDRESS=${ESCROW}`,
    `NEXT_PUBLIC_DOLLAR_ADDRESS=${DOLLAR}`,
    `NEXT_PUBLIC_DOLLAR_EIP712_NAME=${DOLLAR_NAME}`,
    `NEXT_PUBLIC_PAY_ADDRESS=${PAY}`,
    `NEXT_PUBLIC_DIRECTORY_DOMAIN=${DIRECTORY_DOMAIN}`,
    `NEXT_PUBLIC_RELAYER_URL=${svc("relayer")}`,
    `NEXT_PUBLIC_CLAIMS_URL=${svc("claims")}`,
    `NEXT_PUBLIC_DIRECTORY_URL=${svc("directory")}`,
    `NEXT_PUBLIC_DEV_FAUCET_URL=${svc("faucet")}`,
    `NEXT_PUBLIC_INDEXER_URL=${svc("indexer")}/v1/graphql`,
    `NEXT_PUBLIC_VOICE_URL=${svc("voice")}`,
    `NEXT_PUBLIC_FUNDING=${PAY ? "simulated" : "off"}`,
    `NEXT_PUBLIC_PAYOUT_URL=${PAYOUT ? `${ORIGIN}/payout-api` : ""}`,
    `NEXT_PUBLIC_PAYOUT_SIMULATED=${PAYOUT ? "1" : ""}`,
    "NEXT_PUBLIC_NETWORK_LABEL=Monad testnet",
    "NEXT_PUBLIC_EXPLORER_URL=https://testnet.monadscan.com", // VERIFIED §4.9
    "",
  ].join("\n"),
);
const nextBin = join(root, "node_modules/next/dist/bin/next");
say("building the web app (next build)…");
const b = spawnSync(process.execPath, [nextBin, "build", "--webpack"], { cwd: join(root, "web"), stdio: "inherit", env: { ...process.env, NEXT_TELEMETRY_DISABLED: "1", ...(PAYOUT ? { PAYOUT_INTERNAL_URL: `http://127.0.0.1:${P.payout}` } : {}) } });
if (b.status !== 0) throw new Error("next build failed");

// 2. services, with persistent keys and databases
const common = { MONAD_RPC: RPC, EXPECTED_CHAIN_ID: String(MONAD_TESTNET_CHAIN_ID), ESCROW_ADDRESS: ESCROW, ALLOWED_ORIGIN: ORIGIN, LOG_LEVEL: "info", HOST: BIND, TRUST_PROXY: "1" };
run("relayer", ["server/relayer/src/main.ts"], {
  ...common, RELAYER_PRIVATE_KEY: env("TESTNET_RELAYER_KEY"), RELAYER_DB_PATH: join(DATA, "relayer.sqlite"), PORT: String(P.relayer),
  AUSD_ADDRESS: DOLLAR, DOLLAR_EIP712_NAME: DOLLAR_NAME, ...(PAY ? { PAY_ADDRESS: PAY } : {}), MIN_RELAYER_BALANCE_WEI: String(2n * 10n ** 17n), // 0.2 MON
  ...(PAY ? { AURORA_API_KEY: "simulated-testnet", AURORA_API_URL: `http://127.0.0.1:${P.aurora}/api`, AURORA_DESTINATION_TOKEN: CTK_TESTNET_ADDRESS } : {}),
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
  ...common, DIRECTORY_DB_PATH: join(DATA, "directory.sqlite"), PORT: String(P.directory), DIRECTORY_DOMAIN_ADDRESS: DIRECTORY_DOMAIN, ...(PAY ? { PAY_ADDRESS: PAY } : {}),
  ...(process.env.REGISTRATIONS_PER_IP_PER_DAY ? { REGISTRATIONS_PER_IP_PER_DAY: process.env.REGISTRATIONS_PER_IP_PER_DAY } : {}),
});

run("voice", ["server/voice/src/main.ts"], { ...common, VOICE_DB_PATH: join(DATA, "voice.sqlite"), PORT: String(P.voice) });
if (PAYOUT) {
  run("payout", ["server/payout/src/main.ts"], {
    EXPECTED_CHAIN_ID: String(MONAD_TESTNET_CHAIN_ID), DIRECTORY_DOMAIN_ADDRESS: DIRECTORY_DOMAIN, PORT: String(P.payout), HOST: "127.0.0.1",
    PAYOUT_DB_PATH: join(DATA, "payout.sqlite"), PAYOUT_BANK_ENC_KEY: process.env.TESTNET_PAYOUT_ENC_KEY, TRUST_PROXY: "1", LOG_LEVEL: "info",
    PAYCREST_API_URL: `http://127.0.0.1:${P.paycrest}`, PAYCREST_API_KEY: SIM_PAYCREST.key, PAYCREST_API_SECRET: SIM_PAYCREST.secret,
    // the simulated provider takes test AUSD on Monad testnet (mainnet: USDC on Base via CCTP, docs/PAYOUT.md §5)
    PAYOUT_SOURCE_NETWORK: "sim-monad-testnet", PAYOUT_SOURCE_CURRENCY: "AUSD", PAYOUT_SIMULATED: "1",
    // the per-IP cap protects REAL bank-name lookups; the simulated provider returns test names, so E2E runs get room
    VERIFICATIONS_PER_IP_PER_DAY: "500",
  });
}

// 3. faucet: mints TestDollar with the deployer (= TestDollar.minter). One mint at a time (nonce order);
//    per-address cooldown and per-IP daily cap, so the minter's MON lasts.
const minter = privateKeyToAccount(env("TESTNET_DEPLOYER_KEY"));
// Sends retry longer (1, 2, 4, 8, 16 s): the public RPC answers 429 under load, and a rejected send is safe to resend.
const wallet = createWalletClient({ chain, transport: http(RPC, { timeout: 20_000, retryCount: 5, retryDelay: 1_000 }), account: minter });
const mintAbi = [{ type: "function", name: "mint", stateMutability: "nonpayable", inputs: [{ type: "address" }, { type: "uint256" }], outputs: [] }];
const erc20Abi = [
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "transfer", stateMutability: "nonpayable", inputs: [{ type: "address" }, { type: "uint256" }], outputs: [{ type: "bool" }] },
  { type: "function", name: "approve", stateMutability: "nonpayable", inputs: [{ type: "address" }, { type: "uint256" }], outputs: [{ type: "bool" }] },
];
const agoraFaucetAbi = [{ type: "function", name: "requestFunds", stateMutability: "nonpayable", inputs: [{ type: "address" }], outputs: [] }];
const AUSD_DRIP = 100_000_000n; // $100, like "Get 100 test Dollars"
const CTK_DRIP = 100n * 10n ** 18n;
async function sent(hash) {
  const r = await pub.waitForTransactionReceipt({ hash, timeout: 60_000 });
  if (r.status !== "success") throw new Error(`tx ${hash} reverted`);
  return hash;
}
const bal = (token) => pub.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [minter.address] });
/** AUSD float: Agora's testnet faucet gives 10,000 per request (docs: "Getting Testnet Tokens"). */
async function ensureAusd(min) {
  if ((await bal(DOLLAR)) >= min) return;
  await sent(await wallet.writeContract({ address: AGORA_TESTNET.ausdFaucet, abi: agoraFaucetAbi, functionName: "requestFunds", args: [minter.address], chain: null }));
  say("faucet: refilled the AUSD float from Agora's testnet faucet");
}
/** CTK float: bought on the real Agora CTK/AUSD pair (the documented CTK faucet doesn't exist on Monad testnet). */
async function ensureCtk(min) {
  if ((await bal(CTK_TESTNET_ADDRESS)) >= min) return;
  const pair = AGORA_TESTNET.ctkAusdPair;
  const ok = await pub.readContract({ address: pair, abi: agoraPairAbi, functionName: "hasRole", args: ["APPROVED_SWAPPER", minter.address] });
  if (!ok) await sent(await wallet.writeContract({ address: AGORA_TESTNET.whitelister, abi: agoraWhitelisterAbi, functionName: "setApprovedSwapper", args: [minter.address], chain: null }));
  const out = 5_000n * 10n ** 18n;
  const [inMax] = await pub.readContract({ address: pair, abi: agoraPairAbi, functionName: "getAmountsIn", args: [out, [DOLLAR, CTK_TESTNET_ADDRESS]] });
  await ensureAusd(inMax + AUSD_DRIP);
  await sent(await wallet.writeContract({ address: DOLLAR, abi: erc20Abi, functionName: "approve", args: [pair, inMax], chain: null }));
  await sent(await wallet.writeContract({ address: pair, abi: agoraPairAbi, functionName: "swapTokensForExactTokens", args: [out, inMax, [DOLLAR, CTK_TESTNET_ADDRESS], minter.address, BigInt(Math.floor(Date.now() / 1000) + 300)], chain: null }));
  say("faucet: bought 5,000 test CTK on the Agora CTK/AUSD pair for the float");
}
const lastByAddress = new Map();
const byIpDay = new Map();
let queue = Promise.resolve();
const ADDRESS_COOLDOWN_MS = 10 * 60_000;
const IP_PER_DAY = 20;
const mintTo = (address, token = "AUSD") =>
  (queue = queue.then(async () => {
    if (!REAL_AUSD) return sent(await wallet.writeContract({ address: DOLLAR, abi: mintAbi, functionName: "mint", args: [address, AUSD_DRIP], chain: null }));
    if (token === "CTK") {
      await ensureCtk(CTK_DRIP);
      return sent(await wallet.writeContract({ address: CTK_TESTNET_ADDRESS, abi: erc20Abi, functionName: "transfer", args: [address, CTK_DRIP], chain: null }));
    }
    await ensureAusd(AUSD_DRIP);
    return sent(await wallet.writeContract({ address: DOLLAR, abi: erc20Abi, functionName: "transfer", args: [address, AUSD_DRIP], chain: null }));
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
    let address, token;
    try {
      ({ address, token = "AUSD" } = JSON.parse(body));
    } catch {
      return res.writeHead(400).end();
    }
    if (token !== "AUSD" && token !== "CTK") return json(res, 400, { error: "bad token" });
    if (typeof address !== "string" || !isAddress(address)) return json(res, 400, { error: "bad address" });
    address = getAddress(address);
    const now = Date.now();
    const ip = String(req.headers["x-forwarded-for"] ?? "").split(",")[0].trim() || req.socket.remoteAddress || "?";
    const day = new Date().toISOString().slice(0, 10);
    const ipKey = `${ip}:${day}`;
    const coolKey = `${address}:${token}`;
    if (now - (lastByAddress.get(coolKey) ?? 0) < ADDRESS_COOLDOWN_MS) return json(res, 429, { error: "This account got test Dollars recently. Try again in a few minutes." });
    if ((byIpDay.get(ipKey) ?? 0) >= IP_PER_DAY) return json(res, 429, { error: "Daily test Dollar limit reached for this network." });
    lastByAddress.set(coolKey, now);
    byIpDay.set(ipKey, (byIpDay.get(ipKey) ?? 0) + 1);
    try {
      const hash = await mintTo(address, token);
      return json(res, 200, { ok: true, hash });
    } catch (e) {
      lastByAddress.delete(coolKey);
      say(`faucet mint failed: ${String(e?.shortMessage ?? e).slice(0, 120)}${e?.details ? ` (${String(e.details).slice(0, 80)})` : ""}`);
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

// Relayer gas on the TEST site (owner GO 2026-10-06; test MON only): every 5 min, if the relayer is below 1 MON, the
// deployer sends it 1 MON (at most 5 a day); alerts in the log when either runs low. Monad charges the full gas limit,
// so heavy E2E days drain it (it hit its 0.2 MON floor once and refused sends).
{
  const relayerAddress = privateKeyToAccount(env("TESTNET_RELAYER_KEY")).address;
  const ONE = 10n ** 18n;
  const topUps = new Map();
  const checkGas = () =>
    (queue = queue.then(async () => {
      const [rel, dep] = await Promise.all([pub.getBalance({ address: relayerAddress }), pub.getBalance({ address: minter.address })]);
      if (rel >= ONE) return;
      const day = new Date().toISOString().slice(0, 10);
      if ((topUps.get(day) ?? 0) >= 5) return say(`ALERT relayer gas low (${Number(rel) / 1e18} MON) and today's 5 top-ups are used`);
      if (dep < 3n * ONE) return say(`ALERT relayer gas low (${Number(rel) / 1e18} MON) but the deployer has only ${Number(dep) / 1e18} MON: refill it from the Monad testnet faucet`);
      const hash = await wallet.sendTransaction({ to: relayerAddress, value: ONE, chain: null });
      await sent(hash);
      topUps.set(day, (topUps.get(day) ?? 0) + 1);
      say(`relayer gas topped up with 1 test MON (${hash}); was ${Number(rel) / 1e18} MON`);
    })).catch((e) => say(`relayer gas check failed: ${String(e?.shortMessage ?? e).slice(0, 100)}`));
  setTimeout(checkGas, 60_000);
  setInterval(checkGas, 5 * 60_000);
}

if (PAY) {
  const deliver = (to, amount) =>
    (queue = queue.then(async () => {
      await ensureCtk(amount);
      return sent(await wallet.writeContract({ address: CTK_TESTNET_ADDRESS, abi: erc20Abi, functionName: "transfer", args: [to, amount], chain: null }));
    }));
  startAuroraSimulator({ port: P.aurora, destinationToken: CTK_TESTNET_ADDRESS, destinationDecimals: 18, deliver, say });
  say(`aurora: SIMULATED on 127.0.0.1:${P.aurora} (delivers test CTK)`);
}
if (PAYOUT) {
  startPaycrestSimulator({
    port: P.paycrest, apiKey: SIM_PAYCREST.key, apiSecret: SIM_PAYCREST.secret, webhookUrl: `http://127.0.0.1:${P.payout}/v1/payout/webhooks/paycrest`,
    decimals: 6, say,
    // a deposit = test AUSD arriving at the order's deposit address on Monad testnet
    balanceOf: (a) => pub.readContract({ address: DOLLAR, abi: erc20Abi, functionName: "balanceOf", args: [a] }),
    // a failed simulated payout is "refunded" from the stack's test float to the sender's own address
    refund: (to, amount) =>
      (queue = queue.then(async () => {
        await ensureAusd(amount);
        return sent(await wallet.writeContract({ address: DOLLAR, abi: erc20Abi, functionName: "transfer", args: [to, amount], chain: null }));
      })),
  });
  say(`payout: SIMULATED Paycrest on 127.0.0.1:${P.paycrest}; payout server on 127.0.0.1:${P.payout}`);
}

await waitFor(`http://127.0.0.1:${P.relayer}/healthz`);
await waitFor(`http://127.0.0.1:${P.claims}/healthz`);
await waitFor(`http://127.0.0.1:${P.directory}/healthz`);
await waitFor(`http://127.0.0.1:${P.voice}/healthz`);
if (PAYOUT) await waitFor(`http://127.0.0.1:${P.payout}/healthz`);

// 4. web, then tell the indexer what to index (stable content: it only re-indexes when the escrow changes)
run("web", [nextBin, "start", "--port", String(P.web), "--hostname", BIND], {}, join(root, "web"));
await waitFor(`http://127.0.0.1:${P.web}`);
if (INFO_FILE) writeFileSync(INFO_FILE, JSON.stringify({ escrow: ESCROW, deployBlock: ESCROW_BLOCK, pay: PAY || null, payBlock: PAY ? PAY_BLOCK : null, chainId: MONAD_TESTNET_CHAIN_ID, rpc: RPC }) + "\n");
say(`✅ Everpiece on Monad testnet is up → ${ORIGIN}`);
