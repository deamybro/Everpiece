// The relayer's default gas limits must be exactly the ones the fork tests prove sufficient (measured worst case on
// real AUSD + headroom): contracts/test/fork/RelayerGas.t.sol (escrow, pay), RelayerGasV2.t.sol (PayV2) and EverpieceEarnFork.t.sol (Earn, real
// Aave). Changing one without the other fails here.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { loadConfig } from "../src/config.ts";

const read = (f: string) => readFileSync(new URL(`../../../contracts/test/fork/${f}`, import.meta.url), "utf8");
const sources = { "RelayerGas.t.sol": read("RelayerGas.t.sol"), "EverpieceEarnFork.t.sol": read("EverpieceEarnFork.t.sol"), "RelayerGasV2.t.sol": read("RelayerGasV2.t.sol") };
const solLimit = (file: keyof typeof sources, name: string): bigint => {
  const m = new RegExp(`uint256 constant ${name} = ([0-9_]+);`).exec(sources[file]);
  assert.ok(m, `${name} not found in ${file}`);
  return BigInt(m[1].replaceAll("_", ""));
};

test("relayer gas limits == the fork-tested limits", () => {
  const c = loadConfig({ RELAYER_PRIVATE_KEY: "0x" + "11".repeat(32), MONAD_RPC: "http://x", ESCROW_ADDRESS: "0x" + "22".repeat(20) });
  const pairs: [keyof typeof c.gasLimits, keyof typeof sources, string][] = [
    ["createPayment", "RelayerGas.t.sol", "LIMIT_CREATE_PAYMENT"],
    ["claimUsernamePayment", "RelayerGas.t.sol", "LIMIT_CLAIM_USERNAME"],
    ["claimLinkPayment", "RelayerGas.t.sol", "LIMIT_CLAIM_LINK"],
    ["cancel", "RelayerGas.t.sol", "LIMIT_CANCEL"],
    ["refundExpired", "RelayerGas.t.sol", "LIMIT_REFUND"],
    ["payWithAusd", "RelayerGas.t.sol", "LIMIT_PAY_AUSD"],
    ["payWithToken", "RelayerGas.t.sol", "LIMIT_PAY_TOKEN"],
    ["earnDeposit", "EverpieceEarnFork.t.sol", "LIMIT_EARN_DEPOSIT"],
    ["earnWithdraw", "EverpieceEarnFork.t.sol", "LIMIT_EARN_WITHDRAW"],
    ["payV2Direct", "RelayerGasV2.t.sol", "LIMIT_PAY_V2_DIRECT"],
    ["payV2Convert", "RelayerGasV2.t.sol", "LIMIT_PAY_V2_CONVERT"],
  ];
  assert.deepEqual(Object.keys(c.gasLimits).sort(), pairs.map(([k]) => k).sort(), "every relayer method is fork-tested");
  for (const [method, file, constant] of pairs) assert.equal(c.gasLimits[method], solLimit(file, constant), method);
});
