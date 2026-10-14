// EverpieceAutomate grants (src/automateModule.ts): typed data parity with the contract (vector re-derived in
// contracts/test/EverpieceAutomate.t.sol), bounds, and rule matching.
import { test } from "node:test";
import assert from "node:assert/strict";
import { recoverAddress, type Address } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { grantIdOf, grantMatchesRule, grantProblem, type Grant } from "../src/index.ts";

const AUTOMATE = "0x4444444444444444444444444444444444444444" as Address;
const owner = privateKeyToAccount("0x00000000000000000000000000000000000000000000000000000000000a11ce");
export const VECTOR_GRANT: Grant = {
  ruleId: "0x1111111111111111111111111111111111111111111111111111111111111111",
  owner: owner.address,
  executor: "0x2B5AD5c4795c026514f8317c7a215E218DcCD6cF",
  vault: "0xC554aFfE2f581F5E0811e0D42D484ECaC5c6B8e2",
  maxPerExecution: 50_000_000n,
  maxPerDay: 80_000_000n,
  total: 200_000_000n,
  expiresAt: 1_792_592_000n,
};
export const VECTOR_GRANT_ID = "0xdb2e60df89002d05f612da796d61f312f16838928123daae74a8c18fa1405ae7";

test("grant id vector (Solidity re-derives it) and a raw signature over it recovers to the owner", async () => {
  const id = grantIdOf(AUTOMATE, 143, VECTOR_GRANT);
  assert.equal(id, VECTOR_GRANT_ID);
  const sig = await owner.sign({ hash: id });
  assert.equal(await recoverAddress({ hash: id, signature: sig }), owner.address);
  assert.notEqual(grantIdOf(AUTOMATE, 143, { ...VECTOR_GRANT, total: VECTOR_GRANT.total + 1n }), id);
});

test("bounds match the contract", () => {
  const now = 1_790_000_000n;
  assert.equal(grantProblem(VECTOR_GRANT, now), null);
  assert.equal(grantProblem({ ...VECTOR_GRANT, maxPerExecution: 0n }, now), "INVALID_GRANT_CAPS");
  assert.equal(grantProblem({ ...VECTOR_GRANT, maxPerExecution: 90_000_000n }, now), "INVALID_GRANT_CAPS");
  assert.equal(grantProblem({ ...VECTOR_GRANT, total: 70_000_000n }, now), "INVALID_GRANT_CAPS");
  assert.equal(grantProblem({ ...VECTOR_GRANT, expiresAt: now }, now), "INVALID_GRANT_EXPIRY");
  assert.equal(grantProblem({ ...VECTOR_GRANT, expiresAt: now + 367n * 86_400n }, now), "INVALID_GRANT_EXPIRY");
});

test("a grant must match its rule and be no looser than the rule's signed limits", () => {
  const rule = { id: VECTOR_GRANT.ruleId, owner: VECTOR_GRANT.owner, limits: { maxPerExecution: 50_000_000n, maxPerDay: 80_000_000n, expiresAt: 1_792_592_000n } };
  assert.equal(grantMatchesRule(VECTOR_GRANT, rule), true);
  assert.equal(grantMatchesRule({ ...VECTOR_GRANT, maxPerDay: 90_000_000n }, rule), false);
  assert.equal(grantMatchesRule({ ...VECTOR_GRANT, owner: AUTOMATE }, rule), false);
  assert.equal(grantMatchesRule({ ...VECTOR_GRANT, expiresAt: 1_792_592_001n }, rule), false);
});
