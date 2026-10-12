#!/usr/bin/env node
// Mainnet canary for EverpiecePayV2 (docs/MAINNET_DEPLOYMENT.md). ONE payment per run, exactly as signed, through the
// private relayer (SSH tunnel to 127.0.0.1:47310). Without --send it only builds, verifies and prints; nothing is sent.
//   node scripts/canary-mainnet.mjs --asset USDC|AUSD --from USDC|AUSD --amount 1.00 --to 0x… [--fallback] [--send]
// The canary key is read from ~/everpiece-canary-mainnet.env and never printed.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { createPublicClient, getAddress, http, parseAbi, decodeEventLog, recoverTypedDataAddress, defineChain } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { everpiecePayV2Abi, paymentV2Authorization, paymentV2Id, paymentV2Problem, routeOf, settlementAsset, SETTLEMENT_ASSETS } from "../packages/shared/src/index.ts";

const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i < 0 ? d : process.argv[i + 1]; };
const has = (n) => process.argv.includes(`--${n}`);
const PAY = "0x29D15Bb918589B9dF84EdE5c3B5A7a3Ec89c8eb5";
const RELAYER = process.env.RELAYER_URL ?? "http://127.0.0.1:47310";
const bySym = (s) => SETTLEMENT_ASSETS.find((a) => a.symbol === s);
const asset = bySym(arg("asset")), from = bySym(arg("from", arg("asset")));
const to = getAddress(arg("to"));
const amount = BigInt(Math.round(Number(arg("amount")) * 1e6));
if (!asset || !from || amount <= 0n) throw new Error("bad --asset/--from/--amount");

const key = readFileSync(homedir() + "/everpiece-canary-mainnet.env", "utf8").match(/CANARY_PRIVATE_KEY=(0x[0-9a-fA-F]{64})/)?.[1];
const me = privateKeyToAccount(key);
const chain = defineChain({ id: 143, name: "Monad", nativeCurrency: { name: "MON", symbol: "MON", decimals: 18 }, rpcUrls: { default: { http: ["https://rpc.monad.xyz"] } } });
const c = createPublicClient({ chain, transport: http() });
const erc20 = parseAbi(["function balanceOf(address) view returns (uint256)"]);
const bal = (t, a) => c.readContract({ address: t, abi: erc20, functionName: "balanceOf", args: [a] });
const fmt = (v) => (Number(v) / 1e6).toFixed(6);

const route = routeOf(asset.address, from.address);
let maxSource = amount;
if (route === "CONVERTED") {
  const r = await fetch(`${RELAYER}/v1/quotes/v2`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sourceToken: from.address, asset: asset.address, amount: amount.toString() }) });
  const q = (await r.json()).quote;
  if (!q?.available) throw new Error("conversion unavailable: " + JSON.stringify(q?.providers));
  maxSource = BigInt(q.maxSourceAmount);
  console.log(`quote: ~${fmt(q.sourceAmount)} ${from.symbol} via ${q.provider}, signed max ${fmt(maxSource)}`);
}
const block = await c.getBlock();
const payment = {
  // --request <id>: pay that payment request (ref = request id, as the app does); otherwise a random canary ref
  ref: arg("request") ? arg("request") : "0x" + Buffer.from(`canary-${Date.now()}`).toString("hex").padEnd(64, "0").slice(0, 64),
  sender: me.address, recipient: to, asset: asset.address, amount, sourceToken: from.address, maxSourceAmount: maxSource,
  deadline: block.timestamp + 600n, fallbackToSource: has("fallback"),
};
const problem = paymentV2Problem(payment, 143, block.timestamp);
if (problem) throw new Error("payment problem: " + problem);
const paymentId = paymentV2Id(PAY, payment, 143);
const auth = paymentV2Authorization(PAY, payment, 143);
const signature = await me.signTypedData(auth);
const rec = await recoverTypedDataAddress({ ...auth, signature });
if (rec !== me.address) throw new Error("signature does not recover to the canary wallet");

const before = { fromBal: await bal(from.address, me.address), toAsset: await bal(asset.address, to), toFrom: await bal(from.address, to) };
console.log(`canary: ${fmt(amount)} ${asset.symbol} to ${to} paid from ${from.symbol} (${route}); signed max ${fmt(maxSource)}; fallback ${payment.fallbackToSource}`);
console.log(`payment id ${paymentId}`);
console.log(`before: canary ${from.symbol} ${fmt(before.fromBal)}, recipient ${asset.symbol} ${fmt(before.toAsset)}`);
if (!has("send")) { console.log("DRY RUN: nothing sent (add --send)."); process.exit(0); }

const body = JSON.stringify({ payment, signature }, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
const r = await fetch(`${RELAYER}/v1/pay/v2/${route === "DIRECT" ? "direct" : "convert"}`, { method: "POST", headers: { "content-type": "application/json" }, body });
const resp = await r.json();
console.log("relayer:", r.status, JSON.stringify(resp).slice(0, 300));
if (r.status !== 202 && r.status !== 200) process.exit(1);
let done;
for (let i = 0; i < 120; i++) {
  // a dropped tunnel connection must not abort the run: the payment is already submitted, keep polling
  try { done = await (await fetch(`${RELAYER}/v1/requests/${resp.requestId}`)).json(); } catch { await new Promise((s) => setTimeout(s, 2000)); continue; }
  if (["CONFIRMED", "FAILED", "REJECTED"].includes(done.status)) break;
  await new Promise((s) => setTimeout(s, 2000));
}
console.log("final:", done?.status, done?.error ?? "", done?.txHash ?? "");
if (done?.status !== "CONFIRMED") process.exit(1);
// the truth, from the finalized chain: the Paid event and the balances
const receipt = await c.getTransactionReceipt({ hash: done.txHash });
let paid;
for (const l of receipt.logs) {
  if (l.address.toLowerCase() !== PAY.toLowerCase()) continue;
  try { const e = decodeEventLog({ abi: everpiecePayV2Abi, data: l.data, topics: l.topics }); if (e.eventName === "Paid") paid = e.args; } catch {}
}
if (!paid || paid.paymentId !== paymentId) throw new Error("no matching Paid event");
const after = { fromBal: await bal(from.address, me.address), toAsset: await bal(asset.address, to), toFrom: await bal(from.address, to) };
console.log(`Paid event: delivered ${fmt(paid.amount)} of ${getAddress(paid.deliveredAsset) === asset.address ? asset.symbol : "ANOTHER ASSET " + paid.deliveredAsset}, source spent ${fmt(paid.sourceAmount)}, provider ${paid.provider}`);
console.log(`after:  canary ${from.symbol} ${fmt(after.fromBal)} (spent ${fmt(before.fromBal - after.fromBal)}), recipient ${asset.symbol} ${fmt(after.toAsset)} (+${fmt(after.toAsset - before.toAsset)}), tx ${done.txHash}`);
if (getAddress(paid.deliveredAsset) !== asset.address) console.log("NOTE: fallback delivered the SOURCE asset, as the payer signed.");

// paying a request: tell the directory, with the self-authenticating proof it checks on-chain (like the app's reportPaid)
if (arg("request")) {
  const wirePay = JSON.parse(JSON.stringify(payment, (_k, v) => (typeof v === "bigint" ? v.toString() : v)));
  const DIR = process.env.DIRECTORY_URL ?? "https://app.everpiece.xyz/svc/directory";
  for (let i = 0; i < 6; i++) {
    const r = await fetch(`${DIR}/v1/requests/paid`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ requestId: arg("request"), kind: "instantV2", payment: wirePay, txHash: done.txHash }) });
    const j = await r.json().catch(() => ({}));
    console.log("directory:", r.status, JSON.stringify(j.paid ?? j.error ?? j).slice(0, 160));
    if (r.status === 200) break;
    await new Promise((res) => setTimeout(res, 3000));
  }
}
