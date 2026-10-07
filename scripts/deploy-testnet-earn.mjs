#!/usr/bin/env node
// Monad TESTNET (10143) only: deploy TestYieldVault (SIMULATED yield, ERC-4626 over the real Agora testnet AUSD) and
// EverpieceEarn with that vault as its only vault (docs/EARN.md). Aave has no Monad testnet deployment, so this is
// the test site's stand-in for the mainnet Aave V3 waMonAUSD vault. Run on the host that holds the keys (inside the
// stack image). Never prints keys. Refuses any other chain. Idempotent: with TESTNET_EARN_ADDRESS and
// TESTNET_EARN_VAULT_ADDRESS set it only re-verifies. A deployment counts once its receipt is successful AND its
// block is finalized (VERIFIED §1.14).
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
const AUSD = getAddress(env("TESTNET_DOLLAR_ADDRESS"));
const deployer = privateKeyToAccount(env("TESTNET_DEPLOYER_KEY"));
const chain = defineChain({ id: TESTNET, name: "monad-testnet", nativeCurrency: { name: "MON", symbol: "MON", decimals: 18 }, rpcUrls: { default: { http: [RPC] } } });
const pub = createPublicClient({ chain, transport: http(RPC, { timeout: 30_000, retryCount: 3 }) });
const wallet = createWalletClient({ chain, transport: http(RPC, { timeout: 30_000, retryCount: 3 }), account: deployer });
const log = (m) => process.stderr.write(`[deploy-testnet-earn] ${m}\n`);
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
  return { address: getAddress(r.contractAddress), block: Number(r.blockNumber) };
}

const vaultAbi = artifact("TestYieldVault.sol/TestYieldVault.json").abi;
const earnAbi = artifact("EverpieceEarn.sol/EverpieceEarn.json").abi;
let vault, earn;
if (process.env.TESTNET_EARN_ADDRESS && process.env.TESTNET_EARN_VAULT_ADDRESS) {
  vault = { address: getAddress(process.env.TESTNET_EARN_VAULT_ADDRESS), block: Number(process.env.TESTNET_EARN_VAULT_BLOCK ?? 0) };
  earn = { address: getAddress(process.env.TESTNET_EARN_ADDRESS), block: Number(process.env.TESTNET_EARN_BLOCK ?? 0) };
  log("already deployed; verifying only");
} else {
  vault = await deploy("TestYieldVault.sol/TestYieldVault.json", [AUSD]);
  earn = await deploy("EverpieceEarn.sol/EverpieceEarn.json", [AUSD, [vault.address]]);
}

// re-verify at finality: the vault's asset is the testnet AUSD, it is labelled SIMULATED, EverpieceEarn lists it
const read = (address, abi, functionName, args = []) => pub.readContract({ address, abi, functionName, args, blockTag: "finalized" });
const asset = getAddress(await read(vault.address, vaultAbi, "asset"));
const name = await read(vault.address, vaultAbi, "name");
const listed = await read(earn.address, earnAbi, "isVault", [vault.address]);
const earnAusd = getAddress(await read(earn.address, earnAbi, "AUSD"));
if (asset !== AUSD || earnAusd !== AUSD || !listed || !/SIMULATED/.test(name)) throw new Error("post-deploy verification failed");
log(`verified: vault asset = AUSD, "${name}", listed in EverpieceEarn`);
process.stdout.write(
  `TESTNET_EARN_VAULT_ADDRESS=${vault.address}\nTESTNET_EARN_VAULT_BLOCK=${vault.block}\nTESTNET_EARN_ADDRESS=${earn.address}\nTESTNET_EARN_BLOCK=${earn.block}\n`,
);
