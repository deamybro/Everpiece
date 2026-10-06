// The Aurora adapter against a fake Aurora (same paths and shapes as the API reference): what we send, what we accept,
// and that the API key never leaves the server.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage } from "node:http";
import { USDC_MAINNET_ADDRESS } from "@everpiece/shared";
import { Funding, type FundingConfig } from "../src/funding.ts";
import { loadConfig } from "../src/config.ts";
import { setLogSink } from "../src/log.ts";

const KEY = "test-key-SECRET123";
const ME = "0x1111111111111111111111111111111111111111";
const WALLET = "0x2222222222222222222222222222222222222222";
const DEPOSIT = "0x3333333333333333333333333333333333333333";
const BASE_USDC = "nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near";
const MONAD_USDC = "nep245:v2_1.omni.hot.tg:143_2dmLwYWkCQKyTjeUPAsGJuiVLbFx";
const TOKENS = [
  { assetId: BASE_USDC, decimals: 6, blockchain: "base", symbol: "USDC", contractAddress: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913" },
  { assetId: MONAD_USDC, decimals: 6, blockchain: "monad", symbol: "USDC", contractAddress: USDC_MAINNET_ADDRESS.toLowerCase() },
];

type Seen = { method: string; url: string; body: unknown };
async function fakeAurora(handle: (req: Seen) => { status: number; body: unknown }) {
  const seen: Seen[] = [];
  const server = createServer(async (req: IncomingMessage, res) => {
    let raw = "";
    for await (const c of req) raw += c;
    const s: Seen = { method: req.method!, url: req.url!, body: raw ? JSON.parse(raw) : null };
    seen.push(s);
    const out = handle(s);
    res.writeHead(out.status, { "content-type": "application/json" }).end(JSON.stringify(out.body));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/api`;
  return { url, seen, close: () => server.close() };
}

function cfg(apiUrl: string): FundingConfig {
  return { apiUrl, apiKey: KEY, destinationToken: USDC_MAINNET_ADDRESS, slippageBps: 50, deadlineMinutes: 30, maxWholeTokens: 600, perIpPerMinute: 60 };
}

/** A well-behaved Aurora: echoes the request and quotes 1% more in than out. */
function honest(s: Seen, tweak: (q: Record<string, unknown>, r: Record<string, unknown>) => void = () => {}) {
  if (s.method === "GET" && s.url === `/api/tokens/${KEY}`) return { status: 200, body: TOKENS };
  if (s.method === "POST" && s.url === `/api/quote/${KEY}`) {
    const req = s.body as Record<string, string>;
    const out = BigInt(req.amount);
    const quote: Record<string, unknown> = {
      depositAddress: DEPOSIT, amountIn: (out + out / 100n).toString(), amountInFormatted: "", amountInUsd: "25.37", minAmountIn: out.toString(),
      amountOut: out.toString(), amountOutFormatted: "", amountOutUsd: "25.12", minAmountOut: out.toString(), deadline: req.deadline, timeEstimate: 45,
    };
    const quoteRequest = { ...req };
    tweak(quote, quoteRequest);
    return { status: 200, body: { timestamp: new Date().toISOString(), signature: "s", quoteRequest, quote } };
  }
  if (s.method === "GET" && s.url.startsWith(`/api/status/${KEY}?depositAddress=`)) return { status: 200, body: { status: "PROCESSING", swapDetails: {} } };
  if (s.method === "POST" && s.url === `/api/deposit/submit/${KEY}`) return { status: 200, body: { status: "KNOWN_DEPOSIT_TX" } };
  return { status: 404, body: { message: "not found" } };
}

const ask = { originAssetId: BASE_USDC, amountOut: "25125000", recipient: ME, refundTo: WALLET };

test("sources: USDC chains from Aurora's list; the Monad destination resolved by contract", async () => {
  const a = await fakeAurora((s) => honest(s));
  try {
    const r = await new Funding(cfg(a.url)).sources("1.1.1.1");
    assert.equal(r.httpStatus, 200);
    assert.deepEqual((r.body.sources as { chain: string }[]).map((s) => s.chain), ["base"]);
    assert.equal(r.body.destinationDecimals, 6);
  } finally {
    a.close();
  }
});

test("quote: EXACT_OUTPUT to my account, refunds to my wallet; accepted and returned", async () => {
  const a = await fakeAurora((s) => honest(s));
  const lines: string[] = [];
  setLogSink((l) => lines.push(l), "debug");
  try {
    const r = await new Funding(cfg(a.url)).quote(ask, "1.1.1.1");
    assert.equal(r.httpStatus, 200, JSON.stringify(r.body));
    const q = r.body.quote as Record<string, string>;
    assert.equal(q.amountOut, "25125000");
    assert.equal(q.amountIn, "25376250");
    assert.equal(q.depositAddress, DEPOSIT);
    const sent = a.seen.find((s) => s.url.startsWith("/api/quote/"))!.body as Record<string, unknown>;
    assert.equal(sent.swapType, "EXACT_OUTPUT");
    assert.equal(sent.recipient, ME);
    assert.equal(sent.refundTo, WALLET);
    assert.equal(sent.destinationAsset, MONAD_USDC);
    assert.equal(sent.amount, "25125000");
    // the key is only ever a path segment upstream: never in our response or our logs
    assert.ok(!JSON.stringify(r.body).includes(KEY));
    assert.ok(!lines.join("\n").includes(KEY));
  } finally {
    setLogSink((l) => process.stdout.write(l + "\n"));
    a.close();
  }
});

test("quote: anything other than what we asked for is BAD_QUOTE and never reaches the app", async () => {
  const cases: [string, (q: Record<string, unknown>, r: Record<string, unknown>) => void][] = [
    ["someone else receives", (_q, r) => (r.recipient = "0x9999999999999999999999999999999999999999")],
    ["refund elsewhere", (_q, r) => (r.refundTo = "0x9999999999999999999999999999999999999999")],
    ["one unit short", (q) => (q.amountOut = "25124999")],
    ["no deposit address", (q) => delete q.depositAddress],
    ["memo deposit", (q) => (q.depositMemo = "42")],
  ];
  for (const [why, tweak] of cases) {
    const a = await fakeAurora((s) => honest(s, tweak));
    try {
      const r = await new Funding(cfg(a.url)).quote(ask, "1.1.1.1");
      assert.equal(r.httpStatus, 502, why);
      assert.deepEqual(r.body, { error: "BAD_QUOTE" }, why);
    } finally {
      a.close();
    }
  }
});

test("quote: input checks, limits and upstream failures", async () => {
  const a = await fakeAurora((s) => (s.url.startsWith("/api/quote/") ? { status: 400, body: { message: "Amount is too low" } } : honest(s)));
  try {
    const f = new Funding(cfg(a.url));
    assert.equal((await f.quote({ ...ask, extra: 1 }, "ip")).httpStatus, 400);
    assert.equal((await f.quote({ ...ask, amountOut: "0" }, "ip")).httpStatus, 400);
    assert.equal((await f.quote({ ...ask, refundTo: "nope" }, "ip")).httpStatus, 400);
    assert.deepEqual((await f.quote({ ...ask, originAssetId: "nep141:sol-x" }, "ip")).body, { error: "UNSUPPORTED_TOKEN" });
    assert.deepEqual((await f.quote({ ...ask, amountOut: "600000001" }, "ip")).body, { error: "AMOUNT_TOO_LARGE" });
    assert.deepEqual((await f.quote(ask, "ip")).body, { error: "QUOTE_REFUSED", detail: "Amount is too low" });
  } finally {
    a.close();
  }
  const down = new Funding(cfg("http://127.0.0.1:1/api"));
  assert.deepEqual((await down.sources("ip")).body, { error: "PROVIDER_UNAVAILABLE" });
});

test("status and deposit: mapped to phases; bad input refused; rate limited", async () => {
  const a = await fakeAurora((s) => honest(s));
  try {
    const f = new Funding({ ...cfg(a.url), perIpPerMinute: 3 });
    const s = await f.status(DEPOSIT, "ip");
    assert.deepEqual(s.body, { status: "PROCESSING", deliveredTxHash: null, refundedAmount: null, phase: "MOVING" });
    assert.equal((await f.status("0xnope", "ip")).httpStatus, 400);
    const d = await f.deposit({ depositAddress: DEPOSIT, txHash: "0x" + "ab".repeat(32) }, "ip");
    assert.equal(d.httpStatus, 200);
    assert.equal((await f.deposit({ depositAddress: DEPOSIT, txHash: "0x12" }, "ip")).httpStatus, 400);
    await f.status(DEPOSIT, "ip");
    await f.status(DEPOSIT, "ip");
    assert.equal((await f.status(DEPOSIT, "ip")).httpStatus, 429);
  } finally {
    a.close();
  }
});

test("config: off without a key; USDC on mainnet; an explicit destination elsewhere", () => {
  const base = { RELAYER_PRIVATE_KEY: "0x" + "11".repeat(32), MONAD_RPC: "http://x", ESCROW_ADDRESS: "0x" + "22".repeat(20) };
  assert.equal(loadConfig(base).funding, undefined);
  assert.equal(loadConfig({ ...base, AURORA_API_KEY: "abcdefgh12" }).funding?.destinationToken, USDC_MAINNET_ADDRESS);
  assert.throws(() => loadConfig({ ...base, AURORA_API_KEY: "abcdefgh12", EXPECTED_CHAIN_ID: "10143" }), /AURORA_DESTINATION_TOKEN/);
  assert.throws(() => loadConfig({ ...base, AURORA_API_KEY: "bad key/../" }), /unexpected characters/);
});
