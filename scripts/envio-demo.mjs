#!/usr/bin/env node
// Live look at Everpiece's Envio indexer (for the demo video). Read-only; prints what the app's history, Earn ledger and
// "Everpiece in numbers" page read from the same GraphQL endpoint.
//   node scripts/envio-demo.mjs [https://app.everpiece.xyz/svc/indexer/v1/graphql]
const URL = process.argv[2] ?? "https://app.everpiece.xyz/svc/indexer/v1/graphql";
const q = async (query) => {
  const r = await fetch(URL, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ query }) });
  const j = await r.json();
  if (j.errors) throw new Error(JSON.stringify(j.errors).slice(0, 200));
  return j.data;
};
const short = (h) => (h ? `${h.slice(0, 10)}…${h.slice(-6)}` : "");
const usd = (v) => (Number(v) / 1e6).toFixed(2);

const meta = (await q(`{ chain_metadata { chain_id latest_processed_block block_height } }`)).chain_metadata[0];
console.log(`\nEnvio indexer on Monad (chain ${meta.chain_id})`);
console.log(`  processed block ${meta.latest_processed_block}   chain head ${meta.block_height}   behind by ${meta.block_height - meta.latest_processed_block}`);

const pay = (await q(`{ InstantPayment(limit: 5, order_by: { timestamp: desc }) { timestamp amount asset requestedAsset sender recipient txHash } }`)).InstantPayment;
console.log(`\nLatest instant payments (EverpiecePayV2 events)`);
for (const p of pay) console.log(`  ${new Date(Number(p.timestamp) * 1000).toISOString().slice(0, 19)}Z  $${usd(p.amount)}  ${short(p.sender)} -> ${short(p.recipient)}  tx ${short(p.txHash)}`);

const earn = (await q(`{ EarnEvent(limit: 3, order_by: { timestamp: desc }) { kind assets owner vault txHash } }`)).EarnEvent;
console.log(`\nLatest Earn events (deposits and withdrawals into Aave / Morpho)`);
for (const e of earn) console.log(`  ${e.kind}  $${usd(e.assets)}  vault ${short(e.vault)}  tx ${short(e.txHash)}`);

const s = (await q(`{ Stats(limit: 1) { instantCount instantVolume users created claimed } }`)).Stats[0];
console.log(`\nEverpiece in numbers: ${s?.instantCount ?? 0} instant payments, $${usd(s?.instantVolume ?? 0)} moved, ${s?.users ?? 0} users\n`);
