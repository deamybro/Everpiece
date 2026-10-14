#!/usr/bin/env node
// Mainnet canary for bounded automation (EverpieceAutomate -> Aave waMonUSDC), through the private relayer:
//   1. the canary wallet signs ONE grant (relayer as executor, this vault only, $1.00 per run/day/total, 1 day) + a USDC permit
//   2. the executor deposits $1.00 into the canary's own Aave position WITHOUT any new signature (internal route, key read on the VPS)
//   3. the owner revokes (gasless); a further run is refused
//   4. the canary redeems its shares back to USDC (its own transaction; needs a little MON)
// Without --send it builds and verifies signatures only. Keys are read locally / on the VPS and never printed.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { execFileSync } from "node:child_process";
import { createPublicClient, createWalletClient, getAddress, http, parseAbi, defineChain, hexToSignature, keccak256, toBytes, recoverAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { everpieceAutomateAbi, erc4626Abi, grantIdOf, grantProblem, revokeTyped } from "../packages/shared/src/index.ts";

const send = process.argv.includes("--send");
const AUTOMATE = "0xEC3F0a726Ad4604B20F71CeD79059e0aAA2f3732";
const VAULT = "0xC554aFfE2f581F5E0811e0D42D484ECaC5c6B8e2";
const USDC = { address: "0x754704Bc059F8C67012fEd69BC8A327a5aafb603", name: "USDC", version: "2" };
const EXECUTOR = "0x8AEDdD970373eB53Dc318f85a7854a444B13F2C6";
const RELAYER = process.env.RELAYER_URL ?? "http://127.0.0.1:47310";
const AMOUNT = 1_000_000n;

const key = readFileSync(`${homedir()}/everpiece-canary-mainnet.env`, "utf8").match(/CANARY_PRIVATE_KEY=(0x[0-9a-fA-F]{64})/)[1];
const me = privateKeyToAccount(key);
const chain = defineChain({ id: 143, name: "Monad", nativeCurrency: { name: "MON", symbol: "MON", decimals: 18 }, rpcUrls: { default: { http: ["https://rpc.monad.xyz"] } } });
const c = createPublicClient({ chain, transport: http() });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function retry(fn, n = 6) { for (let i = 0; ; i++) { try { return await fn(); } catch (e) { if (i >= n) throw e; await sleep(1500 * (i + 1)); } } }
const erc20 = parseAbi(["function balanceOf(address) view returns (uint256)", "function nonces(address) view returns (uint256)"]);
const bal = (t, a) => retry(() => c.readContract({ address: t, abi: erc20, functionName: "balanceOf", args: [a] }));
const fmt = (v) => (Number(v) / 1e6).toFixed(6);
const wire = (v) => JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x));

async function poll(path, id) {
  for (let i = 0; i < 150; i++) {
    try {
      const s = await (await fetch(`${RELAYER}/v1/requests/${id}`)).json();
      if (["CONFIRMED", "FAILED", "REJECTED"].includes(s.status)) {
        if (s.status !== "CONFIRMED") throw new Error(`${path}: ${s.status} ${s.error ?? ""}`);
        return s;
      }
    } catch (e) { if (String(e.message).startsWith(path)) throw e; }
    await sleep(2000);
  }
  throw new Error(`${path}: still pending after 5 minutes (check the relayer; do NOT resend blindly)`);
}
async function relay(path, body) {
  const r = await fetch(`${RELAYER}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: wire(body) });
  const j = await r.json();
  if (r.status !== 202 && r.status !== 200) throw new Error(`relayer ${path}: ${r.status} ${JSON.stringify(j).slice(0, 200)}`);
  return poll(path, j.requestId);
}
/** The internal execute route needs the key, which lives only in the VPS env file: curl runs ON the VPS, the key is never printed. */
function internalExecute(body) {
  const script = `set -a; . /opt/everpiece-mainnet/relayer.env; set +a; curl -s -w '\\n%{http_code}' -X POST http://127.0.0.1:47310/v1/internal/automate/execute -H 'content-type: application/json' -H "x-internal-key: $RELAYER_INTERNAL_KEY" --data-binary @-`;
  const out = execFileSync("ssh", ["-o", "BatchMode=yes", "optiongenome", script], { input: wire(body), encoding: "utf8" }).trim().split("\n");
  return { status: Number(out.pop()), body: JSON.parse(out.join("\n") || "{}") };
}

const t = (await retry(() => c.getBlock())).timestamp;
const ruleId = keccak256(toBytes(`canary-automate-${Date.now()}`));
const grant = { ruleId, owner: me.address, executor: EXECUTOR, vault: VAULT, maxPerExecution: AMOUNT, maxPerDay: AMOUNT, total: AMOUNT, expiresAt: t + 86_400n };
const problem = grantProblem(grant, t);
if (problem) throw new Error(problem);
const grantId = grantIdOf(AUTOMATE, 143, grant);
const ownerSignature = await me.sign({ hash: grantId });
if ((await recoverAddress({ hash: grantId, signature: ownerSignature })) !== me.address) throw new Error("grant signature does not recover");
const nonce = await bal(USDC.address, me.address).then(() => retry(() => c.readContract({ address: USDC.address, abi: erc20, functionName: "nonces", args: [me.address] })));
const pdl = t + 3600n;
const permitSig = await me.signTypedData({
  domain: { name: USDC.name, version: USDC.version, chainId: 143, verifyingContract: USDC.address },
  types: { Permit: [{ name: "owner", type: "address" }, { name: "spender", type: "address" }, { name: "value", type: "uint256" }, { name: "nonce", type: "uint256" }, { name: "deadline", type: "uint256" }] },
  primaryType: "Permit", message: { owner: me.address, spender: AUTOMATE, value: grant.total, nonce, deadline: pdl },
});
const { r, s, v } = hexToSignature(permitSig);
const before = { usdc: await bal(USDC.address, me.address), shares: await bal(VAULT, me.address) };
console.log(`canary ${me.address}: grant to executor ${EXECUTOR}; vault waMonUSDC; $1.00 per run / day / total; expires ${new Date(Number(grant.expiresAt) * 1000).toISOString()}`);
console.log(`grant id ${grantId}`);
console.log(`before: USDC ${fmt(before.usdc)}, shares ${before.shares}`);
if (!send) { console.log("DRY RUN: nothing sent (add --send)."); process.exit(0); }
if (before.usdc < AMOUNT) throw new Error("canary wallet has less than 1 USDC");

// 1. activate (gasless)
const s1 = await relay("/v1/automate/grants/activate", { grant, ownerSignature, permit: { deadline: pdl, v: Number(v), r, s } });
const st = await retry(() => c.readContract({ address: AUTOMATE, abi: everpieceAutomateAbi, functionName: "grants", args: [grantId], blockTag: "finalized" }));
console.log(`1. grant active: tx ${s1.txHash}; on-chain owner ${st[0] === me.address}, revoked ${st[8]}`);

// 2. unattended execution: no new signature from the owner
const minShares = ((await retry(() => c.readContract({ address: VAULT, abi: erc4626Abi, functionName: "previewDeposit", args: [AMOUNT] }))) * 999n) / 1000n;
const executionId = keccak256(toBytes(`canary-exec-${Date.now()}`));
const ex = internalExecute({ grantId, executionId, assets: AMOUNT, minShares });
if (ex.status !== 202 && ex.status !== 200) throw new Error(`execute refused: ${ex.status} ${JSON.stringify(ex.body)}`);
const s2 = await poll("execute", ex.body.requestId);
const mid = { usdc: await bal(USDC.address, me.address), shares: await bal(VAULT, me.address), automate: await bal(USDC.address, AUTOMATE) };
const principal = await retry(() => c.readContract({ address: AUTOMATE, abi: everpieceAutomateAbi, functionName: "principalOf", args: [me.address, VAULT], blockTag: "finalized" }));
console.log(`2. executed with no owner signature: tx ${s2.txHash}; USDC ${fmt(mid.usdc)}, shares ${mid.shares} (to the owner), principal recorded ${fmt(principal)}, Automate contract holds ${fmt(mid.automate)} USDC`);

// 3. revoke (gasless), then a further run must be refused
const rs = await me.signTypedData(revokeTyped(AUTOMATE, 143, grantId));
const s3 = await relay("/v1/automate/grants/revoke", { grantId, ownerSignature: rs });
const again = internalExecute({ grantId, executionId: keccak256(toBytes(`canary-exec2-${Date.now()}`)), assets: 1n, minShares: 0n });
console.log(`3. revoked: tx ${s3.txHash}; a further run is refused: HTTP ${again.status} ${JSON.stringify(again.body).slice(0, 80)}`);
if (again.status === 200 || again.status === 202) throw new Error("REVOKED GRANT STILL EXECUTES");

// 4. the owner takes the position back to USDC with its own transaction
const wallet = createWalletClient({ account: me, chain, transport: http() });
const hash = await wallet.writeContract({ address: VAULT, abi: erc4626Abi, functionName: "redeem", args: [mid.shares, me.address, me.address] });
await retry(() => c.waitForTransactionReceipt({ hash }));
const after = { usdc: await bal(USDC.address, me.address), shares: await bal(VAULT, me.address) };
console.log(`4. redeemed by the owner: tx ${hash}; USDC ${fmt(after.usdc)} (net ${fmt(after.usdc - before.usdc)}), shares ${after.shares}`);
