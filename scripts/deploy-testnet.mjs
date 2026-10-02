#!/usr/bin/env node
// Deploy TestDollar + the UNCHANGED EverpieceEscrow to MONAD TESTNET (10143) only. Run on the host that holds the keys
// (deploy/test-stack: inside the stack image, keys from the host .env). Prints addresses and blocks; never prints keys.
// Refuses any other chain. Idempotent: with TESTNET_DOLLAR_ADDRESS and TESTNET_ESCROW_ADDRESS already set it only
// re-verifies them. Each deployment counts only once its receipt is successful AND its block is finalized
// (VERIFIED §1.14: inclusion is not success).
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createPublicClient, createWalletClient, defineChain, getAddress, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const TESTNET = 10143; // VERIFIED §4.9
const env = (n, d) => {
  const v = process.env[n] ?? d;
  if (!v) throw new Error(`${n} is required`);
  return v;
};
const RPC = env("TESTNET_RPC", "https://testnet-rpc.monad.xyz");
const deployer = privateKeyToAccount(env("TESTNET_DEPLOYER_KEY"));
const owner = getAddress(env("TESTNET_OWNER_ADDRESS"));
const approver = getAddress(env("TESTNET_APPROVER_ADDRESS"));
if (new Set([owner, approver, deployer.address]).size !== 3) throw new Error("owner, approver and deployer must be distinct keys (spec §2)");

const chain = defineChain({ id: TESTNET, name: "monad-testnet", nativeCurrency: { name: "MON", symbol: "MON", decimals: 18 }, rpcUrls: { default: { http: [RPC] } } });
const pub = createPublicClient({ chain, transport: http(RPC, { timeout: 30_000, retryCount: 3 }) });
const wallet = createWalletClient({ chain, transport: http(RPC, { timeout: 30_000, retryCount: 3 }), account: deployer });
const log = (m) => process.stderr.write(`[deploy-testnet] ${m}\n`);
const artifact = (p) => JSON.parse(readFileSync(join(root, "contracts/out", p), "utf8"));

const chainId = await pub.getChainId();
if (chainId !== TESTNET) throw new Error(`refusing: RPC chainId ${chainId} is not Monad testnet ${TESTNET}`);

async function finalized(hash) {
  const r = await pub.waitForTransactionReceipt({ hash, timeout: 120_000 });
  if (r.status !== "success") throw new Error(`tx ${hash} reverted`);
  for (let i = 0; i < 120; i++) {
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
const dollarAbi = artifact("TestDollar.sol/TestDollar.json").abi;
let dollar, escrow;
if (process.env.TESTNET_DOLLAR_ADDRESS && process.env.TESTNET_ESCROW_ADDRESS) {
  dollar = { address: getAddress(process.env.TESTNET_DOLLAR_ADDRESS), block: Number(process.env.TESTNET_DOLLAR_BLOCK ?? 0) };
  escrow = { address: getAddress(process.env.TESTNET_ESCROW_ADDRESS), block: Number(process.env.TESTNET_ESCROW_BLOCK ?? 0) };
  log("already deployed; verifying only");
} else {
  log(`deployer ${deployer.address} balance ${(await pub.getBalance({ address: deployer.address })) / 10n ** 15n} mMON`);
  dollar = await deploy("TestDollar.sol/TestDollar.json", [deployer.address]);
  escrow = await deploy("EverpieceEscrow.sol/EverpieceEscrow.json", [dollar.address, owner, approver]);
}

// Read back at finalized: the escrow points at this token, owner/approver are the intended keys, the token is sane.
const read = (address, abi, functionName) => pub.readContract({ address, abi, functionName, blockTag: "finalized" });
const checks = {
  escrowToken: getAddress(await read(escrow.address, escrowAbi, "AUSD")) === dollar.address,
  escrowOwner: getAddress(await read(escrow.address, escrowAbi, "owner")) === owner,
  escrowApprover: getAddress(await read(escrow.address, escrowAbi, "claimApprover")) === approver,
  dollarMinter: getAddress(await read(dollar.address, dollarAbi, "minter")) === deployer.address,
  dollarDecimals: Number(await read(dollar.address, dollarAbi, "decimals")) === 6,
  dollarNotUpgraded: (await read(dollar.address, dollarAbi, "isReceiveWithAuthorizationUpgraded")) === false,
};
const ok = Object.values(checks).every(Boolean);
process.stdout.write(JSON.stringify({ ok, chainId, dollar, escrow, deployer: deployer.address, owner, approver, checks }, null, 2) + "\n");
if (!ok) process.exit(1);
