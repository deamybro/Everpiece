// The relayer's default gas limits must be exactly the ones contracts/test/fork/RelayerGas.t.sol proves sufficient
// (measured worst case on real AUSD + headroom). Changing one without the other fails here.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { loadConfig } from "../src/config.ts";

const sol = readFileSync(new URL("../../../contracts/test/fork/RelayerGas.t.sol", import.meta.url), "utf8");
const solLimit = (name: string): bigint => {
  const m = new RegExp(`uint256 constant ${name} = ([0-9_]+);`).exec(sol);
  assert.ok(m, `${name} not found in RelayerGas.t.sol`);
  return BigInt(m[1].replaceAll("_", ""));
};

test("relayer gas limits == the fork-tested limits in RelayerGas.t.sol", () => {
  const c = loadConfig({ RELAYER_PRIVATE_KEY: "0x" + "11".repeat(32), MONAD_RPC: "http://x", ESCROW_ADDRESS: "0x" + "22".repeat(20) });
  const pairs: [keyof typeof c.gasLimits, string][] = [
    ["createPayment", "LIMIT_CREATE_PAYMENT"],
    ["claimUsernamePayment", "LIMIT_CLAIM_USERNAME"],
    ["claimLinkPayment", "LIMIT_CLAIM_LINK"],
    ["cancel", "LIMIT_CANCEL"],
    ["refundExpired", "LIMIT_REFUND"],
    ["payWithAusd", "LIMIT_PAY_AUSD"],
    ["payWithToken", "LIMIT_PAY_TOKEN"],
  ];
  assert.deepEqual(Object.keys(c.gasLimits).sort(), pairs.map(([k]) => k).sort(), "every relayer method is fork-tested");
  for (const [method, constant] of pairs) assert.equal(c.gasLimits[method], solLimit(constant), method);
});
