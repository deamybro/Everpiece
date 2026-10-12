import { test } from "node:test";
import assert from "node:assert/strict";
import {
  AURORA_STATUSES,
  FundingError,
  USDC_MAINNET_ADDRESS,
  auroraQuoteRequest,
  destinationAssetId,
  fundingPhase,
  fundingSources,
  parseAuroraQuote,
  parseAuroraStatus,
  payableTokens,
  type FundingQuoteArgs,
} from "../src/index.ts";

// Entries shaped like Aurora's / 1Click's GET /tokens (assetIds as listed there on 2026-10-06).
const TOKENS = [
  { assetId: "nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near", decimals: 6, blockchain: "base", symbol: "USDC", contractAddress: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913" },
  { assetId: "nep141:eth-0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48.omft.near", decimals: 6, blockchain: "eth", symbol: "USDC", contractAddress: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48" },
  { assetId: "nep245:v2_1.omni.hot.tg:56_2w93GqMcEmQFDru84j3HZZWt557r", decimals: 18, blockchain: "bsc", symbol: "USDC", contractAddress: "0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d" },
  { assetId: "nep141:sol-5ce3bf3a31af18be40ba30f721101b4341690186.omft.near", decimals: 6, blockchain: "sol", symbol: "USDC", contractAddress: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v" },
  { assetId: "nep245:v2_1.omni.hot.tg:143_2dmLwYWkCQKyTjeUPAsGJuiVLbFx", decimals: 6, blockchain: "monad", symbol: "USDC", contractAddress: "0x754704bc059f8c67012fed69bc8a327a5aafb603" },
  { assetId: "evil:monad-lookalike", decimals: 6, blockchain: "monad", symbol: "USDC", contractAddress: "0x0000000000000000000000000000000000000bad" },
  { assetId: "x", decimals: 6, blockchain: "base", symbol: "USDT", contractAddress: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913" },
  null,
  { assetId: 7 },
];
const ME = "0x1111111111111111111111111111111111111111";
const MY_BASE_WALLET = "0x2222222222222222222222222222222222222222";
const DEPOSIT = "0x3333333333333333333333333333333333333333";
const NOW = Date.parse("2026-10-06T12:00:00Z");

function args(): FundingQuoteArgs {
  const origin = fundingSources(TOKENS).find((s) => s.chain === "base")!;
  return {
    origin, destinationAssetId: destinationAssetId(TOKENS, USDC_MAINNET_ADDRESS)!, amountOut: 25_125_000n, recipient: ME, refundTo: MY_BASE_WALLET,
    deadline: "2026-10-06T12:30:00Z", slippageBps: 50,
  };
}
function reply(over: { quote?: Record<string, unknown>; quoteRequest?: Record<string, unknown> } = {}) {
  const a = args();
  return {
    timestamp: "2026-10-06T12:00:01Z", signature: "sig",
    quoteRequest: { ...auroraQuoteRequest(a), ...over.quoteRequest },
    quote: {
      depositAddress: DEPOSIT, amountIn: "25277000", amountInFormatted: "25.277", amountInUsd: "25.27", minAmountIn: "25150000",
      amountOut: "25125000", amountOutFormatted: "25.125", amountOutUsd: "25.12", minAmountOut: "25125000", deadline: "2026-10-06T12:30:00Z",
      timeEstimate: 40, ...over.quote,
    },
  };
}

test("sources: USDC on supported EVM chains only, decimals from the list, ordered", () => {
  const s = fundingSources(TOKENS);
  assert.deepEqual(s.map((x) => [x.chain, x.chainLabel, x.decimals]), [["base", "Base", 6], ["eth", "Ethereum", 6], ["bsc", "BNB Chain", 18]]);
  assert.ok(s.every((x) => !x.simulated));
  const sim = fundingSources([{ ...TOKENS[0], blockchain: "sim-base", assetId: "sim:base-usdc" }]);
  assert.equal(sim[0].chainLabel, "Base (simulated)");
  assert.equal(sim[0].simulated, true);
  assert.deepEqual(fundingSources("nope"), []);
});

test("destination: matched by exact contract on Monad, never by symbol", () => {
  assert.equal(destinationAssetId(TOKENS, USDC_MAINNET_ADDRESS), "nep245:v2_1.omni.hot.tg:143_2dmLwYWkCQKyTjeUPAsGJuiVLbFx");
  assert.equal(destinationAssetId(TOKENS, "0x0000000000000000000000000000000000000001"), null);
});

test("quote request: EXACT_OUTPUT to my own Monad account, refunds to my origin wallet", () => {
  const b = auroraQuoteRequest(args());
  assert.equal(b.swapType, "EXACT_OUTPUT");
  assert.equal(b.amount, "25125000");
  assert.equal(b.recipient, ME);
  assert.equal(b.recipientType, "DESTINATION_CHAIN");
  assert.equal(b.refundTo, MY_BASE_WALLET);
  assert.equal(b.refundType, "ORIGIN_CHAIN");
  assert.equal(b.depositType, "ORIGIN_CHAIN");
  assert.equal(b.dry, false);
});

test("quote: accepted only if it is exactly what we asked for", () => {
  const q = parseAuroraQuote(reply(), args(), NOW);
  assert.equal(q.amountIn, 25_277_000n);
  assert.equal(q.amountOut, 25_125_000n);
  assert.equal(q.depositAddress, DEPOSIT);
  const bad = (r: unknown, why: RegExp) => assert.throws(() => parseAuroraQuote(r, args(), NOW), (e: unknown) => e instanceof FundingError && e.code === "BAD_QUOTE" && why.test(e.message));
  bad(reply({ quoteRequest: { recipient: "0x9999999999999999999999999999999999999999" } }), /addresses/); // someone else's account
  bad(reply({ quoteRequest: { refundTo: "0x9999999999999999999999999999999999999999" } }), /addresses/);
  bad(reply({ quoteRequest: { destinationAsset: "evil:monad-lookalike" } }), /assets/);
  bad(reply({ quoteRequest: { swapType: "EXACT_INPUT" } }), /swapType/);
  bad(reply({ quote: { amountOut: "25124999" } }), /amountOut/); // short by one unit
  bad(reply({ quote: { amountIn: "-1" } }), /amountIn/);
  bad(reply({ quote: { minAmountIn: "99999999" } }), /amountIn/);
  bad(reply({ quote: { depositAddress: "not-an-address" } }), /depositAddress/);
  bad(reply({ quote: { depositMemo: "123" } }), /memo/);
  bad(reply({ quote: { deadline: "2026-10-06T11:59:00Z" } }), /deadline/);
  bad({ nope: true }, /shape/);
});

test("status: every Aurora status maps; unknown is an error, never 'arrived'", () => {
  assert.deepEqual(AURORA_STATUSES.map(fundingPhase), ["MOVING", "WAITING_FOR_DEPOSIT", "DEPOSIT_TOO_SMALL", "MOVING", "ARRIVED", "REFUNDED", "FAILED"]);
  const s = parseAuroraStatus({ status: "SUCCESS", swapDetails: { destinationChainTxHashes: [{ hash: "0xabc", explorerUrl: "" }], refundedAmount: "0" } });
  assert.deepEqual(s, { status: "SUCCESS", deliveredTxHash: "0xabc", refundedAmount: "0" });
  assert.throws(() => parseAuroraStatus({ status: "DONE" }), FundingError);
  assert.throws(() => parseAuroraStatus(null), FundingError);
});

test("mainnet registry: USDC routes through the verified Agora AUSD/USDC pair", () => {
  const usdc = payableTokens(143).find((t) => t.symbol === "USDC")!;
  assert.equal(usdc.address, USDC_MAINNET_ADDRESS);
  assert.equal(usdc.pair, "0xf33286E3222D1c829dACeac48c0Ec651F6452470");
  assert.deepEqual(usdc.eip712, { name: "USDC", version: "2" });
  assert.equal(usdc.route, "AGORA_INSTANT_SETTLEMENT");
});

test("Aurora confidential routing is one extra field on the same quote call, and only when asked for", async () => {
  const { auroraQuoteRequest } = await import("../src/index.ts");
  const base = { origin: { assetId: "nep141:base-usdc", chain: "base", chainLabel: "Base", symbol: "USDC", decimals: 6, token: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", simulated: false },
    destinationAssetId: "nep245:monad-usdc", amountOut: 1_000_000n, recipient: "0x0000000000000000000000000000000000000001", refundTo: "0x0000000000000000000000000000000000000002",
    deadline: "2026-10-12T12:00:00.000Z", slippageBps: 50 } as const;
  assert.equal("confidentiality" in auroraQuoteRequest(base), false);
  assert.equal((auroraQuoteRequest({ ...base, confidential: true }) as Record<string, unknown>).confidentiality, "advanced");
  assert.equal((auroraQuoteRequest({ ...base, confidential: false }) as Record<string, unknown>).confidentiality, undefined);
});
