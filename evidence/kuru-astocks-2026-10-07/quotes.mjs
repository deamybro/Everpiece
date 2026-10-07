import fs from "node:fs";
const tok = JSON.parse(fs.readFileSync("tok.json")).token;
const U = "0xc90551F8abEEf31eD7a7C1DAAaF20E5eC2EA8eAe";
const USDC = "0x754704Bc059F8C67012fEd69BC8A327a5aafb603", MON = "0x0000000000000000000000000000000000000000", AUSD = "0x00000000eFE302BEAA2b3e6e1b18d08D69a9012a";
const S = { aNVDA: "0x701193374879131f923532987c7ef363a91a80eb", aAAPL: "0x17683e492d0c8910f7c0157d04af31cb7a23ad71", aMSFT: "0x73e9eb2c7a4b4e8c68232b31ea0f1246963d0375" };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const out = [];
async function q(label, tokenIn, tokenOut, amount) {
  await wait(1300);
  const t0 = new Date().toISOString();
  const r = await fetch("https://ws.kuru.io/api/quote", { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${tok}` },
    body: JSON.stringify({ userAddress: U, tokenIn, tokenOut, amount, autoSlippage: true }) });
  const text = await r.text();
  let body; try { body = JSON.parse(text); } catch { body = text; }
  out.push({ label, at: t0, request: { tokenIn, tokenOut, amount }, http: r.status, body });
  const b = typeof body === "object" ? body : {};
  console.log(`${label.padEnd(26)} http=${r.status} status=${b.status ?? "-"} output=${b.output ?? "-"} msg=${(b.message ?? b.error ?? (typeof body === "string" ? body : "")).toString().slice(0, 90)}`);
}
// positive control: a route Kuru certainly has
await q("CONTROL USDC->MON $10", USDC, MON, "10000000");
for (const [n, a] of Object.entries(S)) for (const d of [5, 10, 25]) await q(`USDC->${n} $${d}`, USDC, a, String(d * 1e6));
for (const [n, a] of Object.entries(S)) await q(`AUSD->${n} $10`, AUSD, a, "10000000");
for (const [n, a] of Object.entries(S)) await q(`MON->${n} 500 MON`, MON, a, (500n * 10n ** 18n).toString());
for (const [n, a] of Object.entries(S)) await q(`${n}->USDC 0.01`, a, USDC, (10n ** 16n).toString());
for (const [n, a] of Object.entries(S)) await q(`${n}->MON 0.01`, a, MON, (10n ** 16n).toString());
fs.writeFileSync("quotes.json", JSON.stringify(out, null, 1));
