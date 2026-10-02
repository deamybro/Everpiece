// Offline: which broadcast errors are transport trouble (retry, keep the signed tx) vs a node's real rejection.
// Regression for 2026-10-02: Monad's public testnet RPC answered eth_sendRawTransaction with HTTP 429 and the
// relayer marked a valid cancel FAILED instead of retrying.
import { test } from "node:test";
import assert from "node:assert/strict";
import { HttpRequestError, InternalRpcError, RpcRequestError, TimeoutError, TransactionExecutionError } from "viem";
import { isTransientRpcError } from "../src/index.ts";

const http = (status?: number) => new HttpRequestError({ url: "https://testnet-rpc.monad.xyz/", status, body: { method: "eth_sendRawTransaction" } });

test("transient: 429, 408, 5xx, no response, timeout, dropped sockets (also when wrapped)", () => {
  for (const s of [429, 408, 500, 502, 503, undefined]) assert.equal(isTransientRpcError(http(s)), true, `status ${s}`);
  assert.equal(isTransientRpcError(new TimeoutError({ body: {}, url: "https://x" })), true);
  assert.equal(isTransientRpcError(new TransactionExecutionError(http(429), {} as never)), true);
  assert.equal(isTransientRpcError(new Error("fetch failed: ECONNRESET")), true);
});

test("not transient: the node's own JSON-RPC answer, 4xx client errors, anything else", () => {
  const rpc = new RpcRequestError({ body: {}, url: "https://x", error: { code: -32000, message: "insufficient funds for gas * price + value" } });
  assert.equal(isTransientRpcError(rpc), false);
  assert.equal(isTransientRpcError(new InternalRpcError(rpc)), false);
  assert.equal(isTransientRpcError(http(400)), false);
  assert.equal(isTransientRpcError(http(403)), false);
  assert.equal(isTransientRpcError(new Error("invalid transaction")), false);
});
