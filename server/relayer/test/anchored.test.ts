// Anchored HMAC (src/anchored.ts) cross-checked against an independent implementation (Python hmac, the docs'
// reference algorithm) and the documented canonical query order; requests carry the documented headers.
import { test } from "node:test";
import assert from "node:assert/strict";
import { AnchoredClient, canonicalUri, signAnchored } from "../src/anchored.ts";

const body = JSON.stringify({ stockAddress: "0x0000000000000000000000000000000000000001", side: "Buy", type: "Market", notional: "10", deadline: 1893456000 });

test("signature equals the reference implementation (POST with body, GET with sorted query)", () => {
  assert.equal(signAnchored({ method: "post", uri: "/api/v1/orders/calldata", timestamp: 1893456000000, nonce: "6f1c0b2e-0000-4000-8000-000000000001", rawBody: body, apiSecret: "test-secret" }), "d3c41bdecf351a216bc959f65f57438ccdbe5e40b8ed7587696042724aa8c1ee");
  assert.equal(canonicalUri("/api/v1/orders", { page: 1, limit: 10 }), "/api/v1/orders?limit=10&page=1");
  assert.equal(signAnchored({ method: "GET", uri: canonicalUri("/api/v1/orders", { page: 1, limit: 10 }), timestamp: 1893456000000, nonce: "n-1", rawBody: "", apiSecret: "test-secret" }), "6e8622f515dbc83c222e53511b199359fe8fcab22b43d9f36c96a7bd3fa1444c");
});

test("client sends the documented headers, signs exactly the bytes it sends, and fails closed on errors", async () => {
  let seen: { url: string; init: RequestInit } | null = null;
  const fake = (async (url: string, init: RequestInit) => {
    seen = { url, init };
    return new Response(JSON.stringify({ code: 200, errMsg: "", data: { toAddress: "0x4f09", callData: "0x", value: "0" } }), { status: 200 });
  }) as unknown as typeof fetch;
  const c = new AnchoredClient({ apiKey: "k", apiSecret: "test-secret" }, { fetch: fake, now: () => 1893456000000 });
  await c.marketBuyCalldata("0x0000000000000000000000000000000000000001", "10", 1893456000);
  const h = seen!.init.headers as Record<string, string>;
  assert.equal(seen!.url, "https://rwa-api.anchored.finance/rwa/trading/api/v1/orders/calldata");
  assert.equal(h["x-api-chain-id"], "143");
  assert.equal(h["x-api-p"], "Anchored");
  assert.equal(h["x-api-sign"], signAnchored({ method: "POST", uri: "/api/v1/orders/calldata", timestamp: 1893456000000, nonce: h["x-api-nonce"], rawBody: seen!.init.body as string, apiSecret: "test-secret" }));
  const bad = new AnchoredClient({ apiKey: "k", apiSecret: "s" }, { fetch: (async () => new Response(JSON.stringify({ code: 401, errMsg: "Unauthorized", data: null }), { status: 401 })) as unknown as typeof fetch });
  await assert.rejects(() => bad.symbols(), /HTTP 401 Unauthorized/);
});
