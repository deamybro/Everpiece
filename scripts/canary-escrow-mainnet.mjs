#!/usr/bin/env node
// Mainnet canary for the USDC protected escrow (EverpieceEscrowUsdc), end to end through the private relayer:
//   1. the canary wallet protects $1.00 USDC for a fresh recipient wallet (one signature, gasless)
//   2. the recipient claims it with ITS OWN signature (gasless)
//   3. the recipient forwards it to the owner's wallet with a direct USDC payment (gasless)
// Without --send it builds and verifies signatures only. Keys come from ~/everpiece-*-mainnet.env and are never printed.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { createPublicClient, getAddress, http, parseAbi, defineChain, recoverTypedDataAddress } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import {
  PaymentMode, claimIntent, everpieceEscrowAbi, fundingAuthorization, paymentIdOf, paymentV2Authorization, paymentV2Id, recipientCommitment, MAX_EXPIRY_SECONDS,
} from "../packages/shared/src/index.ts";

const send = process.argv.includes("--send");
const ESCROW = "0x70ab17cFEe72fFd49F8C766692067D16965F5AA8";
const PAY = "0x29D15Bb918589B9dF84EdE5c3B5A7a3Ec89c8eb5";
const USDC = { address: "0x754704Bc059F8C67012fEd69BC8A327a5aafb603", eip712Name: "USDC", eip712Version: "2" };
const OWNER = getAddress(process.argv.find((a) => /^0x[0-9a-fA-F]{40}$/.test(a)) ?? "");
const RELAYER = process.env.RELAYER_URL ?? "http://127.0.0.1:47310";
const AMOUNT = 1_000_000n;

const home = homedir();
const readKey = (file, name) => readFileSync(`${home}/${file}`, "utf8").match(new RegExp(`${name}=(0x[0-9a-fA-F]{64})`))[1];
const sender = privateKeyToAccount(readKey("everpiece-canary-mainnet.env", "CANARY_PRIVATE_KEY"));
const rf = `${home}/everpiece-canary-recipient-mainnet.env`;
if (!existsSync(rf)) writeFileSync(rf, `RECIPIENT_PRIVATE_KEY=${generatePrivateKey()}\n`, { mode: 0o600, flag: "wx" });
const recipient = privateKeyToAccount(readKey("everpiece-canary-recipient-mainnet.env", "RECIPIENT_PRIVATE_KEY"));

const chain = defineChain({ id: 143, name: "Monad", nativeCurrency: { name: "MON", symbol: "MON", decimals: 18 }, rpcUrls: { default: { http: ["https://rpc.monad.xyz"] } } });
const c = createPublicClient({ chain, transport: http() });
const erc20 = parseAbi(["function balanceOf(address) view returns (uint256)"]);
// public RPC reads can fail transiently: retry reads (never the relayer calls)
async function retry(fn, n = 6) { for (let i = 0; ; i++) { try { return await fn(); } catch (e) { if (i >= n) throw e; await new Promise((r) => setTimeout(r, 1500 * (i + 1))); } } }
const usdc = (a) => retry(() => c.readContract({ address: USDC.address, abi: erc20, functionName: "balanceOf", args: [a] }));
const fmt = (v) => (Number(v) / 1e6).toFixed(6);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const wire = (v) => JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x));

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
const salt = `0x${Buffer.from(`canary-escrow-${Date.now()}`).toString("hex").padEnd(64, "0").slice(0, 64)}`;
const recipientSalt = `0x${Buffer.from(`rs-${Date.now()}`).toString("hex").padEnd(64, "0").slice(0, 64)}`;
const intent = {
  sender: sender.address, mode: PaymentMode.USERNAME, recipientCommitment: recipientCommitment(PaymentMode.USERNAME, recipient.address, recipientSalt),
  metadataCommitment: `0x${"00".repeat(32)}`, approver: "0x0000000000000000000000000000000000000000", amount: AMOUNT,
  expiresAt: t + MAX_EXPIRY_SECONDS, validAfter: 0n, validBefore: t + 3600n, salt,
};
const paymentId = paymentIdOf(ESCROW, intent, 143);
const fundAuth = fundingAuthorization(ESCROW, intent, 143, USDC);
const fundSig = await sender.signTypedData(fundAuth);
if ((await recoverTypedDataAddress({ ...fundAuth, signature: fundSig })) !== sender.address) throw new Error("funding signature does not recover");
console.log(`canary ${sender.address} -> escrow (USDC domain "${fundAuth.domain.name}" v${fundAuth.domain.version}); recipient ${recipient.address}; final owner ${OWNER}`);
console.log(`payment id ${paymentId}`);
const before = { canary: await usdc(sender.address), owner: await usdc(OWNER), escrow: await usdc(ESCROW) };
console.log(`before: canary ${fmt(before.canary)}, owner ${fmt(before.owner)}, escrow ${fmt(before.escrow)} USDC`);
if (!send) { console.log("DRY RUN: nothing sent (add --send)."); process.exit(0); }
if (before.canary < AMOUNT) throw new Error("canary wallet has less than 1 USDC");

// 1. protect
const s1 = await relay("/v1/payments/create", { intent, ausdSignature: fundSig });
const p1 = await retry(() => c.readContract({ address: ESCROW, abi: everpieceEscrowAbi, functionName: "getPayment", args: [paymentId], blockTag: "finalized" }));
console.log(`1. protected: tx ${s1.txHash}; escrow state ACTIVE=${Number(p1.status) === 1}; escrow holds ${fmt(await usdc(ESCROW))} USDC; canary ${fmt(await usdc(sender.address))}`);

// 2. claim by the recipient's own signature
const actionNonce = `0x${Buffer.from(`claim-${Date.now()}`).toString("hex").padEnd(64, "0").slice(0, 64)}`;
const deadline = (await retry(() => c.getBlock())).timestamp + 600n;
const cl = claimIntent(ESCROW, { paymentId, recipient: recipient.address, actionNonce, deadline }, 143);
const recipientSig = await recipient.signTypedData(cl);
const s2 = await relay("/v1/payments/claim-username", { paymentId, recipient: recipient.address, recipientSalt, actionNonce, deadline, recipientSig });
const p2 = await retry(() => c.readContract({ address: ESCROW, abi: everpieceEscrowAbi, functionName: "getPayment", args: [paymentId], blockTag: "finalized" }));
console.log(`2. claimed: tx ${s2.txHash}; escrow state CLAIMED=${Number(p2.status) === 2}; recipient now ${fmt(await usdc(recipient.address))} USDC`);

// 3. forward to the owner (gasless direct USDC payment signed by the recipient)
const bt = (await retry(() => c.getBlock())).timestamp;
const pay = { ref: `0x${Buffer.from(`fwd-${Date.now()}`).toString("hex").padEnd(64, "0").slice(0, 64)}`, sender: recipient.address, recipient: OWNER, asset: USDC.address, amount: AMOUNT, sourceToken: USDC.address, maxSourceAmount: AMOUNT, deadline: bt + 600n, fallbackToSource: false };
const payAuth = paymentV2Authorization(PAY, pay, 143);
const paySig = await recipient.signTypedData(payAuth);
const s3 = await relay("/v1/pay/v2/direct", { payment: pay, signature: paySig });
console.log(`3. forwarded: tx ${s3.txHash}; payment id ${paymentV2Id(PAY, pay, 143)}`);
const after = { canary: await usdc(sender.address), owner: await usdc(OWNER), recipient: await usdc(recipient.address), escrow: await usdc(ESCROW) };
console.log(`after:  canary ${fmt(after.canary)} (spent ${fmt(before.canary - after.canary)}), owner ${fmt(after.owner)} (+${fmt(after.owner - before.owner)}), recipient ${fmt(after.recipient)}, escrow ${fmt(after.escrow)} USDC`);
