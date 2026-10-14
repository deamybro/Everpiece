// EverpiecePayV2 relaying (src/actions.ts payV2Direct / payV2Convert): only correctly signed, in-policy payments are
// prepared; target and calldata come from config + the signed payment, never the client.
import { test } from "node:test";
import assert from "node:assert/strict";
import { decodeFunctionData, getAddress, type Address } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { AUSD_ADDRESS, USDC_MAINNET_ADDRESS, everpiecePayV2Abi, paymentV2Authorization, type PaymentV2 } from "@everpiece/shared";
import { prepare, PrecheckError } from "../src/actions.ts";
import type { Chain } from "../src/chain.ts";
import { baseConfig } from "./harness.ts";

const PAY_V2 = "0x3333333333333333333333333333333333333333" as Address;
const payer = privateKeyToAccount("0x00000000000000000000000000000000000000000000000000000000000a11ce");
const cfg = baseConfig("http://127.0.0.1:1", "0x1111111111111111111111111111111111111111", { payV2: PAY_V2 });
const chain = { chainId: 143 } as unknown as Chain;

function payment(over: Partial<PaymentV2> = {}): PaymentV2 {
  return {
    ref: "0x0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e",
    sender: payer.address,
    recipient: "0x2B5AD5c4795c026514f8317c7a215E218DcCD6cF",
    asset: USDC_MAINNET_ADDRESS,
    amount: 5_000_000n,
    sourceToken: USDC_MAINNET_ADDRESS,
    maxSourceAmount: 5_000_000n,
    deadline: BigInt(Math.floor(Date.now() / 1000) + 600),
    fallbackToSource: false,
    ...over,
  };
}

const json = (p: PaymentV2, signature: string) =>
  JSON.parse(JSON.stringify({ payment: p, signature }, (_k, v) => (typeof v === "bigint" ? v.toString() : v)));

async function signed(p: PaymentV2) {
  return json(p, await payer.signTypedData(paymentV2Authorization(PAY_V2, p, 143)));
}

async function code(f: () => Promise<unknown>): Promise<string> {
  try {
    await f();
    return "OK";
  } catch (e) {
    return e instanceof PrecheckError ? e.code : String(e);
  }
}

test("direct USDC payment: prepared against the configured PayV2, calldata = pay(payment, signature)", async () => {
  const p = payment();
  const body = await signed(p);
  const prep = await prepare("payV2Direct", body, cfg, chain);
  assert.equal(prep.target, PAY_V2);
  assert.equal(prep.fn, "pay");
  assert.equal(prep.money?.route, "DIRECT");
  const d = decodeFunctionData({ abi: everpiecePayV2Abi, data: prep.data });
  assert.equal(d.functionName, "pay");
  assert.equal(getAddress((d.args[0] as PaymentV2).recipient), getAddress(p.recipient));
});

test("converted payment within slippage is prepared on the convert endpoint only", async () => {
  const p = payment({ asset: AUSD_ADDRESS, maxSourceAmount: 5_020_000n, fallbackToSource: true }); // 40 bps
  const body = await signed(p);
  assert.equal(await code(() => prepare("payV2Convert", body, cfg, chain)), "OK");
  assert.equal(await code(() => prepare("payV2Direct", body, cfg, chain)), "WRONG_ROUTE_ENDPOINT");
});

test("slippage above the relayer limit is refused even though the payer signed it", async () => {
  const p = payment({ asset: AUSD_ADDRESS, maxSourceAmount: 5_030_000n }); // 60 bps > 50
  assert.equal(await code(async () => prepare("payV2Convert", await signed(p), cfg, chain)), "SLIPPAGE_ABOVE_LIMIT");
});

test("a signature by anyone but the sender, or over other terms, is refused", async () => {
  const p = payment();
  const body = await signed(p);
  body.payment.recipient = "0x000000000000000000000000000000000000bEEF";
  assert.equal(await code(() => prepare("payV2Direct", body, cfg, chain)), "InvalidFundingSignature");
});

test("structural problems: fallback larger than the authorization, unknown asset, expired", async () => {
  assert.equal(
    await code(async () => prepare("payV2Convert", await signed(payment({ asset: AUSD_ADDRESS, maxSourceAmount: 4_990_000n, fallbackToSource: true })), cfg, chain)),
    "FALLBACK_EXCEEDS_MAX",
  );
  assert.equal(await code(async () => prepare("payV2Direct", await signed(payment({ asset: PAY_V2 })), cfg, chain)), "UNSUPPORTED_ASSET");
  assert.equal(await code(async () => prepare("payV2Direct", await signed(payment({ deadline: 1n })), cfg, chain)), "EXPIRED");
});

test("without PAY_V2_ADDRESS the V2 methods are unavailable", async () => {
  const off = baseConfig("http://127.0.0.1:1", "0x1111111111111111111111111111111111111111");
  assert.equal(await code(async () => prepare("payV2Direct", await signed(payment()), off, chain)), "InstantPaymentsUnavailable");
});

test("feature flags: a disabled asset is refused; with conversions off only the truthful fallback passes", async () => {
  const { readFlags } = await import("@everpiece/shared");
  const noAusd = { ...cfg, flags: readFlags({ USDC_PAYMENTS_ENABLED: "true" }) };
  assert.equal(await code(async () => prepare("payV2Convert", await signed(payment({ asset: AUSD_ADDRESS, maxSourceAmount: 5_010_000n })), noAusd, chain)), "AUSD_PAYMENTS_DISABLED");
  const noConvert = { ...cfg, flags: readFlags({ USDC_PAYMENTS_ENABLED: "true", AUSD_PAYMENTS_ENABLED: "true" }) };
  assert.equal(await code(async () => prepare("payV2Convert", await signed(payment({ asset: AUSD_ADDRESS, maxSourceAmount: 5_010_000n })), noConvert, chain)), "CONVERSION_DISABLED");
  assert.equal(await code(async () => prepare("payV2Convert", await signed(payment({ asset: AUSD_ADDRESS, maxSourceAmount: 5_010_000n, fallbackToSource: true })), noConvert, chain)), "OK");
});
