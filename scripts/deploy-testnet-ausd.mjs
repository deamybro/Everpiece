#!/usr/bin/env node
// Monad TESTNET (10143) only: deploy the UNCHANGED EverpieceEscrow over REAL Agora testnet AUSD, plus EverpiecePay
// with the Agora CTK/AUSD Instant Settlement pair, then whitelist EverpiecePay through Agora's public testnet
// Whitelister. Every address comes from @everpiece/shared (docs/INTEGRATION_VERIFICATION.md) and is re-checked on chain.
// Run on the host that holds the keys (inside the stack image). Never prints keys. Idempotent: with
// TESTNET_AUSD_ESCROW_ADDRESS / TESTNET_PAY_ADDRESS set it only re-verifies. A step counts once its receipt is
// successful AND its block is finalized (VERIFIED §1.14).
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createPublicClient, createWalletClient, defineChain, getAddress, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { AGORA_TESTNET, AUSD_TESTNET_ADDRESS, CTK_TESTNET_ADDRESS, MONAD_TESTNET_CHAIN_ID, agoraPairAbi, agoraWhitelisterAbi, ausdAbi } from "@everpiece/shared";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const env = (n, d) => {
  const v = process.env[n] || d;
  if (!v) throw new Error(`${n} is required`);
  return v;
};
const RPC = env("TESTNET_RPC", "https://testnet-rpc.monad.xyz");
const deployer = privateKeyToAccount(env("TESTNET_DEPLOYER_KEY"));
const owner = getAddress(env("TESTNET_OWNER_ADDRESS"));
const approver = getAddress(env("TESTNET_APPROVER_ADDRESS"));
if (new Set([owner, approver, deployer.address]).size !== 3) throw new Error("owner, approver and deployer must be distinct keys");

const chain = defineChain({ id: MONAD_TESTNET_CHAIN_ID, name: "monad-testnet", nativeCurrency: { name: "MON", symbol: "MON", decimals: 18 }, rpcUrls: { default: { http: [RPC] } } });
const pub = createPublicClient({ chain, transport: http(RPC, { timeout: 30_000, retryCount: 3 }) });
const wallet = createWalletClient({ chain, transport: http(RPC, { timeout: 30_000, retryCount: 3 }), account: deployer });
const log = (m) => process.stderr.write(`[deploy-testnet-ausd] ${m}\n`);
const artifact = (p) => JSON.parse(readFileSync(join(root, "contracts/out", p), "utf8"));

if ((await pub.getChainId()) !== MONAD_TESTNET_CHAIN_ID) throw new Error("refusing: not Monad testnet");

// The external contracts must be what the docs say before we build on them.
const pre = {
  ausdCode: (await pub.getCode({ address: AUSD_TESTNET_ADDRESS }))?.length > 2,
  ausdDecimals: Number(await pub.readContract({ address: AUSD_TESTNET_ADDRESS, abi: [{ type: "function", name: "decimals", inputs: [], outputs: [{ type: "uint8" }], stateMutability: "view" }], functionName: "decimals" })) === 6,
  ausdNotUpgraded: (await pub.readContract({ address: AUSD_TESTNET_ADDRESS, abi: ausdAbi, functionName: "isReceiveWithAuthorizationUpgraded" })) === false,
  pairToken0IsCtk: getAddress(await pub.readContract({ address: AGORA_TESTNET.ctkAusdPair, abi: agoraPairAbi, functionName: "token0" })) === CTK_TESTNET_ADDRESS,
  pairToken1IsAusd: getAddress(await pub.readContract({ address: AGORA_TESTNET.ctkAusdPair, abi: agoraPairAbi, functionName: "token1" })) === AUSD_TESTNET_ADDRESS,
  whitelisterCode: (await pub.getCode({ address: AGORA_TESTNET.whitelister }))?.length > 2,
};
if (!Object.values(pre).every(Boolean)) throw new Error(`external contracts don't match the verified references: ${JSON.stringify(pre)}`);

async function finalized(hash) {
  const r = await pub.waitForTransactionReceipt({ hash, timeout: 120_000 });
  if (r.status !== "success") throw new Error(`tx ${hash} reverted`);
  for (let i = 0; i < 240; i++) {
    const f = await pub.getBlock({ blockTag: "finalized" });
    if (f.number >= r.blockNumber) return r;
    await new Promise((res) => setTimeout(res, 500));
  }
  throw new Error(`tx ${hash} not finalized in time`);
}

async function deploy(path, args) {
  const a = artifact(path);
  const hash = await wallet.deployContract({ abi: a.abi, bytecode: a.bytecode.object, args });
  log(`${path.split("/")[0]} tx ${hash}`);
  const r = await finalized(hash);
  return { address: getAddress(r.contractAddress), block: Number(r.blockNumber), tx: hash };
}

const escrowAbi = artifact("EverpieceEscrow.sol/EverpieceEscrow.json").abi;
const payAbi = artifact("EverpiecePay.sol/EverpiecePay.json").abi;
log(`deployer ${deployer.address} balance ${(await pub.getBalance({ address: deployer.address })) / 10n ** 15n} mMON`);

const escrow = process.env.TESTNET_AUSD_ESCROW_ADDRESS
  ? { address: getAddress(process.env.TESTNET_AUSD_ESCROW_ADDRESS), block: Number(process.env.TESTNET_AUSD_ESCROW_BLOCK ?? 0) }
  : await deploy("EverpieceEscrow.sol/EverpieceEscrow.json", [AUSD_TESTNET_ADDRESS, owner, approver]);
const pay = process.env.TESTNET_PAY_ADDRESS
  ? { address: getAddress(process.env.TESTNET_PAY_ADDRESS), block: Number(process.env.TESTNET_PAY_BLOCK ?? 0) }
  : await deploy("EverpiecePay.sol/EverpiecePay.json", [AUSD_TESTNET_ADDRESS, [AGORA_TESTNET.ctkAusdPair]]);

// Agora testnet self-whitelisting for the settlement contract (docs: "Executing a Swap → Self-whitelisting").
const hasRole = () => pub.readContract({ address: AGORA_TESTNET.ctkAusdPair, abi: agoraPairAbi, functionName: "hasRole", args: ["APPROVED_SWAPPER", pay.address], blockTag: "finalized" });
let whitelistTx = null;
if (!(await hasRole())) {
  whitelistTx = await wallet.writeContract({ address: AGORA_TESTNET.whitelister, abi: agoraWhitelisterAbi, functionName: "setApprovedSwapper", args: [pay.address] });
  log(`whitelist tx ${whitelistTx}`);
  await finalized(whitelistTx);
}

const read = (address, abi, functionName, args = []) => pub.readContract({ address, abi, functionName, args, blockTag: "finalized" });
const checks = {
  ...pre,
  escrowToken: getAddress(await read(escrow.address, escrowAbi, "AUSD")) === AUSD_TESTNET_ADDRESS,
  escrowOwner: getAddress(await read(escrow.address, escrowAbi, "owner")) === owner,
  escrowApprover: getAddress(await read(escrow.address, escrowAbi, "claimApprover")) === approver,
  payToken: getAddress(await read(pay.address, payAbi, "AUSD")) === AUSD_TESTNET_ADDRESS,
  payPairForCtk: getAddress(await read(pay.address, payAbi, "pairFor", [CTK_TESTNET_ADDRESS])) === AGORA_TESTNET.ctkAusdPair,
  payWhitelistedOnPair: (await hasRole()) === true,
};
const ok = Object.values(checks).every(Boolean);
process.stdout.write(JSON.stringify({ ok, chainId: MONAD_TESTNET_CHAIN_ID, ausd: AUSD_TESTNET_ADDRESS, escrow, pay, whitelistTx, deployer: deployer.address, owner, approver, checks }, null, 2) + "\n");
if (!ok) process.exit(1);
