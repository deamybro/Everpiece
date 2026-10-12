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
  // ROUTING.md §3.2: Aurora never delivers AUSD directly, and only Agora-routed intermediates are accepted
  assert.throws(() => loadConfig({ ...base, AURORA_API_KEY: "abcdefgh12", AURORA_DESTINATION_TOKEN: "0x00000000eFE302BEAA2b3e6e1b18d08D69a9012a" }), /must not deliver AUSD/);
  assert.throws(() => loadConfig({ ...base, AURORA_API_KEY: "abcdefgh12", AURORA_DESTINATION_TOKEN: "0x" + "33".repeat(20) }), /Agora route/);
  assert.equal(
    loadConfig({ ...base, EXPECTED_CHAIN_ID: "10143", AUSD_ADDRESS: "0xa9012a055bd4e0eDfF8Ce09f960291C09D5322dC", AURORA_API_KEY: "abcdefgh12", AURORA_DESTINATION_TOKEN: "0x7BEb5D9DB0d85cBEa543C04f0dE8c23c2176cd9D" }).funding?.destinationToken,
    "0x7BEb5D9DB0d85cBEa543C04f0dE8c23c2176cd9D",
  );
});

test("the test site's SIMULATED Aurora (scripts/aurora-sim.mjs) drives the real adapter end to end", async () => {
  // @ts-expect-error plain .mjs script without types
  const { startAuroraSimulator } = await import("../../../scripts/aurora-sim.mjs");
  const CTK = "0x7BEb5D9DB0d85cBEa543C04f0dE8c23c2176cd9D";
  const delivered: [string, bigint][] = [];
  const server = startAuroraSimulator({
    port: 0, destinationToken: CTK, destinationDecimals: 18,
    deliver: async (to: string, amount: bigint) => (delivered.push([to, amount]), "0x" + "cd".repeat(32)),
  });
  await new Promise((r) => server.once("listening", r));
  const url = `http://127.0.0.1:${server.address().port}/api`;
  try {
    const f = new Funding({ ...cfg(url), destinationToken: CTK });
    const src = await f.sources("ip");
    assert.deepEqual((src.body.sources as { chainLabel: string }[]).map((s) => s.chainLabel), ["Base (simulated)"]);
    const amountOut = 25n * 10n ** 18n;
    const q = await f.quote({ originAssetId: "sim:base-usdc", amountOut: amountOut.toString(), recipient: ME, refundTo: WALLET }, "ip");
    assert.equal(q.httpStatus, 200, JSON.stringify(q.body));
    const dep = (q.body.quote as { depositAddress: string }).depositAddress;
    assert.equal((await f.status(dep, "ip")).body.phase, "WAITING_FOR_DEPOSIT");
    assert.equal((await f.deposit({ depositAddress: dep, txHash: "0x" + "ab".repeat(32) }, "ip")).body.phase, "MOVING");
    let phase = "";
    for (let i = 0; i < 20 && phase !== "ARRIVED"; i++) {
      await new Promise((r) => setTimeout(r, 250));
      phase = (await f.status(dep, "ip")).body.phase as string;
    }
    assert.equal(phase, "ARRIVED");
    assert.deepEqual(delivered, [[ME, amountOut]]);
  } finally {
    server.close();
  }
});

test("confidential routing: refused unless the operator enabled it; when on, exactly one extra field reaches Aurora", async () => {
  setLogSink(() => {}, "alert");
  const aurora = await fakeAurora((s) => honest(s));
  try {
    const ask = { originAssetId: BASE_USDC, amountOut: "5000000", recipient: ME, refundTo: WALLET, confidential: true };
    const off = new Funding({ ...cfg(aurora.url) });
    assert.equal((await off.quote(ask, "ip")).body.error, "CONFIDENTIAL_UNAVAILABLE");
    assert.equal(aurora.seen.filter((s) => s.url.startsWith("/api/quote/")).length, 0); // nothing was sent upstream

    const on = new Funding({ ...cfg(aurora.url), confidential: true });
    const r = await on.quote(ask, "ip");
    assert.equal(r.httpStatus, 200);
    const sent = aurora.seen.filter((s) => s.url.startsWith("/api/quote/")).at(-1)!.body as Record<string, unknown>;
    assert.equal(sent.confidentiality, "advanced");
    assert.equal(sent.amount, "5000000");
    assert.equal(sent.recipient, ME);
    // a malformed flag is a bad request, never silently ignored
    assert.equal((await on.quote({ ...ask, confidential: "yes" }, "ip")).httpStatus, 400);
  } finally {
    aurora.close();
  }
});
