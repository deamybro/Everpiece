import fs from "node:fs"; import { execSync } from "node:child_process";
const A = "http://127.0.0.1:8547", tok = JSON.parse(fs.readFileSync("tok.json")).token;
const U = "0xc90551F8abEEf31eD7a7C1DAAaF20E5eC2EA8eAe", USDC = "0x754704Bc059F8C67012fEd69BC8A327a5aafb603", MA = "0x2A68ba1833cDf93fa9Da1EEbd7F46242aD8E90c5";
const NVDA = "0x701193374879131f923532987c7ef363a91a80eb";
const sh = (c) => execSync(c, { encoding: "utf8" }).trim();
const bal = (t, w) => BigInt(sh(`cast call ${t} "balanceOf(address)(uint256)" ${w} --rpc-url ${A}`).split(" ")[0]);
sh(`cast rpc anvil_impersonateAccount ${MA} --rpc-url ${A}`); sh(`cast rpc anvil_setBalance ${MA} 0x56BC75E2D63100000 --rpc-url ${A}`);
sh(`cast rpc anvil_setBalance ${U} 0x56BC75E2D63100000 --rpc-url ${A}`); sh(`cast rpc anvil_impersonateAccount ${U} --rpc-url ${A}`);
sh(`cast send ${USDC} "transfer(address,uint256)" ${U} 100000000 --from ${MA} --unlocked --rpc-url ${A}`);
const res = [];
for (const d of [5, 10, 25]) {
  await new Promise((r) => setTimeout(r, 1300));
  let q; for (let k = 0; k < 5 && !q?.transaction; k++) { if (k) await new Promise((r) => setTimeout(r, 3000)); const rr = await fetch("https://ws.kuru.io/api/quote", { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${tok}` }, body: JSON.stringify({ userAddress: U, tokenIn: USDC, tokenOut: NVDA, amount: String(d * 1e6), autoSlippage: true }) }); const t = await rr.text(); try { q = JSON.parse(t); } catch { console.log("http", rr.status, "retry"); } }
  await fetch(A, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "anvil_reset", params: [{ forking: { jsonRpcUrl: "https://rpc3.monad.xyz" } }] }) }).then((r) => r.json()).then((j) => { if (j.error) throw new Error(JSON.stringify(j.error)); });
  sh(`cast rpc anvil_impersonateAccount ${MA} --rpc-url ${A}`); sh(`cast rpc anvil_setBalance ${MA} 0x56BC75E2D63100000 --rpc-url ${A}`);
  sh(`cast rpc anvil_setBalance ${U} 0x56BC75E2D63100000 --rpc-url ${A}`); sh(`cast rpc anvil_impersonateAccount ${U} --rpc-url ${A}`);
  sh(`cast send ${USDC} "transfer(address,uint256)" ${U} 100000000 --from ${MA} --unlocked --rpc-url ${A}`);
  const to = q.transaction.to;
  sh(`cast send ${USDC} "approve(address,uint256)" ${to} ${d * 1e6} --from ${U} --unlocked --rpc-url ${A}`);
  const before = bal(NVDA, U), ub = bal(USDC, U);
  let est; try { est = sh(`cast estimate ${to} 0x${q.transaction.calldata} --from ${U} --rpc-url ${A}`); } catch (e) { console.log(JSON.stringify({ usd: d, quotedOut: q.output, estimateRevert: String(e.stderr).trim().slice(-120), forkBlock: sh(`cast block-number --rpc-url ${A}`) })); continue; }
  const rc = JSON.parse(sh(`cast send ${to} 0x${q.transaction.calldata} --from ${U} --unlocked --gas-limit ${Math.ceil(Number(est) * 1.3)} --rpc-url ${A} --json`));
  const got = bal(NVDA, U) - before, spent = ub - bal(USDC, U);
  const r = { usd: d, quotedOut: q.output, minOut: q.minOut, simStatus: rc.status, gasUsed: parseInt(rc.gasUsed), estimate: Number(est), received: got.toString(), usdcSpent: spent.toString(), effPrice: (Number(spent) / 1e6) / (Number(got) / 1e18), tx: rc.transactionHash, logs: rc.logs.map((l) => ({ address: l.address, topic0: l.topics[0] })) };
  res.push(r); console.log(JSON.stringify({ ...r, logs: undefined }));
}
fs.writeFileSync("sim.json", JSON.stringify(res, null, 1));
const addrs = [...new Set(res.flatMap((r) => r.logs.map((l) => l.address.toLowerCase())))]; console.log("contracts emitting logs:", addrs.join(" "));
