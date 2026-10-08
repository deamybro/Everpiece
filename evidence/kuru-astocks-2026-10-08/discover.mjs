// Read-only Kuru × Anchored aStock route discovery on Monad mainnet (docs/INVEST.md §Discovery). Nothing is signed or
// sent. Writes JSON evidence next to this file. Usage: node discover.mjs  (needs network; ~3 minutes at Kuru's 1 rps)
import fs from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const OUT = dirname(fileURLToPath(import.meta.url));
const RPC_LOGS = "https://rpc1.monad.xyz"; // accepts a full-range eth_getLogs (2026-10-07)
const RPC = "https://rpc2.monad.xyz";
const ROUTER = "0xd651346d7c789536ebf06dc72aE3C8502cd695CC";
const REGISTERED = "0x8fd547930d9019b964dccbf749798118018ee4fe341a4b2f970bf28797842eab"; // MarketRegistered(...)
const USDC = "0x754704Bc059F8C67012fEd69BC8A327a5aafb603", AUSD = "0x00000000eFE302BEAA2b3e6e1b18d08D69a9012a", MON = "0x0000000000000000000000000000000000000000";
const QUOTER = "0xc90551F8abEEf31eD7a7C1DAAaF20E5eC2EA8eAe"; // our deployer, used only to address the quote
// Official: https://docs.anchored.finance/getting-started/anchored-tokens (same address on Ethereum/Monad/Base/Arbitrum),
// each read back on Monad (name/symbol/decimals) on 2026-10-08.
const STOCKS = {
  aNVDA: "0x701193374879131f923532987c7Ef363a91a80eB", aAAPL: "0x17683e492d0C8910F7c0157D04af31Cb7A23Ad71",
  aMSFT: "0x73E9EB2C7a4B4E8c68232b31Ea0F1246963D0375", aTSLA: "0x10FAD4A60Adb421F8F5Ca6f9f2eAf2DbC110E146",
  aGOOGL: "0xBDe676CDF5564Ef64CCD8555Aa9B56867D8D1aD5", aAMZN: "0x06f272082339A90e81e1DCB8AB892fD1a8c5E4C0",
  aMETA: "0xa1847139cbd660ABC2f7b889d7CBCF18C56407fb", aAMD: "0xbdf82C0DAFCf73834d10639c0F0Bf14b84808C43",
  aPLTR: "0xB95956daacE89226185FB696C2Cc3F0d9BBFD4e3", aAVGO: "0x4dfbCd033662BC41de8996886E751613C2B8e8e5",
};
const SIZES = [1, 2, 5, 10, 25];
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
// transient network errors (connection resets) are retried; HTTP answers are returned as they are
const rawFetch = globalThis.fetch;
globalThis.fetch = async (...args) => {
  for (let i = 0; ; i++) {
    try {
      const [url, init = {}] = args;
      return await rawFetch(url, { ...init, signal: AbortSignal.timeout(60_000) });
    } catch (e) {
      if (i >= 4) throw e;
      await wait(2000 * (i + 1));
    }
  }
};
const rpc = async (url, method, params) => (await (await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) })).json());

const startedAt = new Date().toISOString();
// 1. on-chain Kuru market registry (every MarketRegistered ever) — the source of truth for "is there a Kuru market"
const say = (m) => process.stderr.write(`[discover] ${m}
`);
const head = parseInt((await rpc(RPC, "eth_blockNumber", [])).result, 16);
say(`head ${head}; reading every Kuru MarketRegistered`);
const logs = await rpc(RPC_LOGS, "eth_getLogs", [{ address: ROUTER, topics: [REGISTERED], fromBlock: "0x0", toBlock: "0x" + head.toString(16) }]);
if (logs.error) throw new Error(JSON.stringify(logs.error));
const w = (d, i) => "0x" + d.slice(2 + 64 * i + 24, 2 + 64 * (i + 1));
const markets = logs.result.map((l) => ({ base: w(l.data, 0), quote: w(l.data, 1), market: w(l.data, 2), block: parseInt(l.blockNumber, 16) }));
const lower = Object.fromEntries(Object.entries(STOCKS).map(([k, v]) => [v.toLowerCase(), k]));
const stockMarkets = markets.filter((m) => lower[m.base] || lower[m.quote]);
// 2. Kuru's market-discovery API
say(`${logs.result.length} registered markets`);
const exchangeInfo = await (await fetch("https://exchange.kuru.io/api/v3/exchangeInfo")).json();
const apiHits = exchangeInfo.symbols.filter((s) => lower[String(s.baseAssetAddress).toLowerCase()] || lower[String(s.quoteAssetAddress).toLowerCase()]);
// 3. Kuru Flow quotes
const tok = (await (await fetch("https://ws.kuru.io/api/generate-token", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ user_address: QUOTER }) })).json()).token;
async function quote(label, tokenIn, tokenOut, amount) {
  for (let k = 0; k < 4; k++) {
    await wait(1300);
    let r;
    try {
      r = await fetch("https://ws.kuru.io/api/quote", { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${tok}` }, body: JSON.stringify({ userAddress: QUOTER, tokenIn, tokenOut, amount, autoSlippage: true }) });
    } catch (e) {
      // one request timing out is recorded, never allowed to abort the scan
      if (k === 3) return { label, at: new Date().toISOString(), request: { tokenIn, tokenOut, amount }, http: null, status: null, message: `network: ${String(e?.name ?? e)}` };
      continue;
    }
    const text = await Promise.race([r.text(), wait(30_000).then(() => "")]).catch(() => "");
    say(`${label} http ${r.status} ${text.slice(0, 60).replace(/\s+/g, " ")}`);
    let body;
    try { body = JSON.parse(text); } catch { if (r.status >= 500) continue; body = text.slice(0, 120); }
    const b = typeof body === "object" ? body : {};
    // the JWT is never written; calldata is kept (it's the route evidence)
    return { label, at: new Date().toISOString(), request: { tokenIn, tokenOut, amount }, http: r.status, status: b.status ?? null, output: b.output ?? null, minOut: b.minOut ?? null, message: b.message ?? b.error ?? (typeof body === "string" ? body : null), to: b.transaction?.to ?? null, value: b.transaction?.value ?? null, calldata: b.transaction?.calldata ?? null };
  }
  return { label, at: new Date().toISOString(), request: { tokenIn, tokenOut, amount }, http: 502, status: null, message: "gateway errors on 4 tries" };
}
const control = await quote("CONTROL USDC->MON $10", USDC, MON, "10000000");
const monPerUsd = control.output ? Number(BigInt(control.output) / 10n ** 12n) / 1e7 : null; // MON (18dp) per $1
const quotes = [control];
for (const [name, addr] of Object.entries(STOCKS)) {
  say(`quoting ${name}`);
  for (const d of SIZES) quotes.push(await quote(`USDC->${name} $${d}`, USDC, addr, String(d * 1e6)));
  quotes.push(await quote(`AUSD->${name} $5`, AUSD, addr, "5000000"));
  if (monPerUsd) quotes.push(await quote(`MON->${name} ~$5`, MON, addr, (BigInt(Math.round(monPerUsd * 5 * 1e6)) * 10n ** 12n).toString()));
}
const routes = quotes.filter((q) => q.status === "success" && q.label !== control.label);
const summary = Object.fromEntries(Object.keys(STOCKS).map((n) => [n, { routes: routes.filter((q) => q.label.endsWith(n) || q.label.includes(`->${n} `)).map((q) => q.label), kuruMarkets: stockMarkets.filter((m) => lower[m.base] === n || lower[m.quote] === n).length }]));
fs.writeFileSync(join(OUT, "discovery.json"), JSON.stringify({ startedAt, finishedAt: new Date().toISOString(), head, registeredMarkets: markets.length, stockMarkets, exchangeInfoSymbols: exchangeInfo.symbols.map((s) => s.symbol), apiHits, monPerUsd, summary, quotes }, null, 1));
console.log(JSON.stringify({ head, registeredMarkets: markets.length, stockMarkets: stockMarkets.length, apiHits: apiHits.length, monPerUsd, summary }, null, 1));
