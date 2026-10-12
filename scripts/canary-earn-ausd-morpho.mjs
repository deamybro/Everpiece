#!/usr/bin/env node
// Mainnet canary for AUSD Earn (EverpieceEarn -> Morpho Grove x Steakhouse AUSD vault), through the private relayer:
//   1. deposit $1.00 AUSD (one signature, gasless) -> shares go to the owner's own wallet
//   2. withdraw it back (one owner signature + a share permit, gasless) -> AUSD returns to the owner
// Without --send it builds and verifies signatures only. The canary key is read locally and never printed.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { createPublicClient, getAddress, http, parseAbi, defineChain, recoverTypedDataAddress, hexToSignature } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { earnAuthorization, earnWithdrawalTyped, everpieceEarnAbi, erc4626Abi, sharePermitTyped } from "../packages/shared/src/index.ts";

const send = process.argv.includes("--send");
const EARN = "0x4bb7d4ce29f7c8410576cdf084637c790fd44e5a";
const VAULT = "0x32841A8511D5c2c5b253f45668780B99139e476D";
const USDC = { address: "0x00000000eFE302BEAA2b3e6e1b18d08D69a9012a", eip712Name: "Agora Dollar", eip712Version: "1" }; // AUSD (kept the name AUSD below for the shared script body)
const RELAYER = process.env.RELAYER_URL ?? "http://127.0.0.1:47310";
const ASSETS = 1_000_000n;

const key = readFileSync(`${homedir()}/everpiece-canary-mainnet.env`, "utf8").match(/CANARY_PRIVATE_KEY=(0x[0-9a-fA-F]{64})/)[1];
const me = privateKeyToAccount(key);
const chain = defineChain({ id: 143, name: "Monad", nativeCurrency: { name: "MON", symbol: "MON", decimals: 18 }, rpcUrls: { default: { http: ["https://rpc.monad.xyz"] } } });
const c = createPublicClient({ chain, transport: http() });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function retry(fn, n = 6) { for (let i = 0; ; i++) { try { return await fn(); } catch (e) { if (i >= n) throw e; await sleep(1500 * (i + 1)); } } }
const erc20 = parseAbi(["function balanceOf(address) view returns (uint256)", "function nonces(address) view returns (uint256)", "function eip712Domain() view returns (bytes1, string, string, uint256, address, bytes32, uint256[])"]);
const usdc = (a) => retry(() => c.readContract({ address: USDC.address, abi: erc20, functionName: "balanceOf", args: [a] }));
const shares = (a) => retry(() => c.readContract({ address: VAULT, abi: erc20, functionName: "balanceOf", args: [a] }));
const fmt = (v) => (Number(v) / 1e6).toFixed(6);
const wire = (v) => JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x));
const ref = (s) => `0x${Buffer.from(`${s}-${Date.now()}`).toString("hex").padEnd(64, "0").slice(0, 64)}`;

async function relay(path, body) {
  const r = await fetch(`${RELAYER}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: wire(body) });
  const j = await r.json();
  if (r.status !== 202 && r.status !== 200) throw new Error(`relayer ${path}: ${r.status} ${JSON.stringify(j).slice(0, 200)}`);
  for (let i = 0; i < 150; i++) {
    try {
      const s = await (await fetch(`${RELAYER}/v1/requests/${j.requestId}`)).json();
      if (["CONFIRMED", "FAILED", "REJECTED"].includes(s.status)) {
        if (s.status !== "CONFIRMED") throw new Error(`${path}: ${s.status} ${s.error ?? ""}`);
        return s;
      }
    } catch (e) { if (String(e.message).startsWith(path)) throw e; }
    await sleep(2000);
  }
  throw new Error(`${path}: still pending after 5 minutes (check the relayer; do NOT resend blindly)`);
}

const t = (await retry(() => c.getBlock())).timestamp;
const previewShares = await retry(() => c.readContract({ address: VAULT, abi: erc4626Abi, functionName: "previewDeposit", args: [ASSETS] }));
const minShares = (previewShares * 9_950n) / 10_000n; // 0.5%: a live vault credits interest as it takes a deposit
const dep = { ref: ref("canary-earn-in"), owner: me.address, vault: VAULT, assets: ASSETS, minShares, deadline: t + 600n };
const depAuth = earnAuthorization(EARN, 143, dep, USDC);
const depSig = await me.signTypedData(depAuth);
if ((await recoverTypedDataAddress({ ...depAuth, signature: depSig })) !== me.address) throw new Error("deposit signature does not recover");
const before = { usdc: await usdc(me.address), shares: await shares(me.address) };
console.log(`canary ${me.address}: deposit ${fmt(ASSETS)} AUSD into the Morpho AUSD vault via ${EARN}; min shares ${minShares}`);
console.log(`before: AUSD ${fmt(before.usdc)}, shares ${before.shares}`);
if (!send) { console.log("DRY RUN: nothing sent (add --send)."); process.exit(0); }
if (before.usdc < ASSETS) throw new Error("canary wallet has less than 1 AUSD");

const s1 = await relay("/v1/earn/deposit", { deposit: dep, ausdSignature: depSig });
const mid = { usdc: await usdc(me.address), shares: await shares(me.address) };
const principal = await retry(() => c.readContract({ address: EARN, abi: everpieceEarnAbi, functionName: "principalOf", args: [me.address, VAULT], blockTag: "finalized" }));
console.log(`1. deposited: tx ${s1.txHash}; AUSD ${fmt(mid.usdc)}, shares ${mid.shares}, principal on-chain ${fmt(principal)}; Earn contract holds ${fmt(await usdc(EARN))} AUSD`);

// withdraw what the vault will actually give back (rounding can leave a unit less than exactly $1)
const maxWd = await retry(() => c.readContract({ address: VAULT, abi: erc4626Abi, functionName: "maxWithdraw", args: [me.address] }));
const assets = maxWd < ASSETS ? maxWd : ASSETS;
const maxShares = await retry(() => c.readContract({ address: VAULT, abi: erc4626Abi, functionName: "previewWithdraw", args: [assets] }));
const nonce = await retry(() => c.readContract({ address: VAULT, abi: erc20, functionName: "nonces", args: [me.address] }));
const dom = await retry(() => c.readContract({ address: VAULT, abi: erc20, functionName: "eip712Domain" }));
const t2 = (await retry(() => c.getBlock())).timestamp;
const w = { ref: ref("canary-earn-out"), owner: me.address, vault: VAULT, assets, maxShares, deadline: t2 + 600n };
const ownerSignature = await me.signTypedData(earnWithdrawalTyped(EARN, 143, w));
const permitSig = await me.signTypedData(sharePermitTyped({ address: VAULT, eip712Name: dom[1] }, 143, me.address, EARN, maxShares, nonce, w.deadline));
const { r, s, v } = hexToSignature(permitSig);
const s2 = await relay("/v1/earn/withdraw", { withdrawal: w, ownerSignature, permit: { v: Number(v), r, s } });
const after = { usdc: await usdc(me.address), shares: await shares(me.address), earn: await usdc(EARN) };
console.log(`2. withdrawn ${fmt(assets)} AUSD: tx ${s2.txHash}`);
console.log(`after:  AUSD ${fmt(after.usdc)} (net ${fmt(after.usdc - before.usdc)}), shares ${after.shares}, Earn contract holds ${fmt(after.earn)} AUSD`);
