import { test } from "node:test";
import assert from "node:assert/strict";
import { hashTypedData, type Address } from "viem";
import { aaveRates, earnDepositTyped, earnPosition, earnWithdrawalTyped, harvestProblem, EARN_OPPORTUNITIES, HARVEST_ROUNDING_MARGIN, type LedgerEntry } from "../src/index.ts";

const $ = (d: number) => BigInt(Math.round(d * 100)) * 10_000n;
const M = "ERC4626_MONOTONIC" as const;

test("deposit and yield: harvestable = redeemable − net principal (minus the rounding margin)", () => {
  const e: LedgerEntry[] = [{ kind: "DEPOSIT", id: "d1", assets: $(500) }];
  const p = earnPosition(M, e, $(512.4));
  assert.equal(p.netPrincipal, $(500));
  assert.equal(p.harvestableYield, $(12.4) - HARVEST_ROUNDING_MARGIN);
  // threshold logic lives in the engine; here: below the margin → nothing harvestable
  assert.equal(earnPosition(M, e, $(500) + 1n).harvestableYield, 0n);
});

test("harvest can never consume principal: after a loss there is no yield, and a harvest above the yield is refused", () => {
  const e: LedgerEntry[] = [{ kind: "DEPOSIT", id: "d1", assets: $(500) }];
  const loss = earnPosition(M, e, $(499));
  assert.equal(loss.harvestableYield, 0n);
  assert.equal(harvestProblem(loss, 1n), "EXCEEDS_YIELD");
  const p = earnPosition(M, e, $(510));
  assert.equal(harvestProblem(p, $(10)), "EXCEEDS_YIELD"); // the margin keeps the last units with principal
  assert.equal(harvestProblem(p, $(10) - HARVEST_ROUNDING_MARGIN), null);
  assert.equal(harvestProblem(p, 0n), "ZERO");
});

test("after a harvest the remaining yield is what's left; principal tracking is unchanged", () => {
  const e: LedgerEntry[] = [{ kind: "DEPOSIT", id: "d1", assets: $(500) }, { kind: "HARVEST", id: "h1", assets: $(10) }];
  const p = earnPosition(M, e, $(502.4)); // 512.40 − 10 harvested
  assert.equal(p.netPrincipal, $(500));
  assert.equal(p.yieldAlreadyHarvested, $(10));
  assert.equal(p.harvestableYield, $(2.4) - HARVEST_ROUNDING_MARGIN);
});

test("owner withdrawals take principal first; the earnings stay identifiable; duplicates count once", () => {
  const e: LedgerEntry[] = [
    { kind: "DEPOSIT", id: "d1", assets: $(500) },
    { kind: "WITHDRAW", id: "w1", assets: $(200) },
    { kind: "WITHDRAW", id: "w1", assets: $(200) }, // the same event seen twice
  ];
  const p = earnPosition(M, e, $(312.4));
  assert.equal(p.principalWithdrawn, $(200));
  assert.equal(p.netPrincipal, $(300));
  assert.equal(p.harvestableYield, $(12.4) - HARVEST_ROUNDING_MARGIN);
  // withdrawing everything: the part above principal is earnings, net principal is zero, nothing left to harvest
  const all = earnPosition(M, [...e, { kind: "WITHDRAW", id: "w2", assets: $(312.4) }], 0n);
  assert.equal(all.netPrincipal, 0n);
  assert.equal(all.yieldWithdrawn, $(12.4));
  assert.equal(all.harvestableYield, 0n);
});

test("unknown accounting models are refused", () => {
  assert.throws(() => earnPosition("REBASING" as never, [], 0n), /UNSUPPORTED_ACCOUNTING_MODEL/);
});

test("Aave rate conversion: 3.0891e25 ray ≈ 3.09% APR, APY slightly higher; display only", () => {
  const r = aaveRates(30_891_895_368_338_275_244_281_642n);
  assert.equal(r.aprBps, 309);
  assert.ok(r.apyBps >= 313 && r.apyBps <= 314);
});

test("registry: the only mainnet opportunity is the verified Aave AUSD wrapper; no APY constant anywhere", () => {
  assert.equal(EARN_OPPORTUNITIES.length, 1);
  const a = EARN_OPPORTUNITIES[0];
  assert.equal(a.vault, "0x9e1AcC5BFbf34e2E579763cE14042d957719fE76");
  assert.equal(a.asset, "0x00000000eFE302BEAA2b3e6e1b18d08D69a9012a");
  assert.equal(a.rateSource.kind, "AAVE_V3_LIQUIDITY_RATE");
  assert.ok(!JSON.stringify(a).match(/apy|apr/i));
});

// Same struct as contracts/test/EverpieceEarn.t.sol `test_ids_matchSharedVectors` (EIP-712 parity with the contract).
export const EARN_VECTOR = {
  earn: "0x00000000000000000000000000000000000e4a1a" as Address,
  chainId: 10143,
  deposit: { ref: `0x${"11".repeat(32)}`, owner: "0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf", vault: "0x00000000000000000000000000000000000000aa", assets: 100_000_000n, minShares: 99_000_000n, deadline: 1_800_000_000n },
  withdrawal: { ref: `0x${"22".repeat(32)}`, owner: "0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf", vault: "0x00000000000000000000000000000000000000aa", assets: 40_000_000n, maxShares: 41_000_000n, deadline: 1_800_000_000n },
} as const;

test("EIP-712 ids match the contract (same vectors in EverpieceEarn.t.sol)", () => {
  const d = hashTypedData(earnDepositTyped(EARN_VECTOR.earn, EARN_VECTOR.chainId, { ...EARN_VECTOR.deposit, ref: EARN_VECTOR.deposit.ref as `0x${string}` }));
  const w = hashTypedData(earnWithdrawalTyped(EARN_VECTOR.earn, EARN_VECTOR.chainId, { ...EARN_VECTOR.withdrawal, ref: EARN_VECTOR.withdrawal.ref as `0x${string}` }));
  assert.equal(d, "0xa9de6608378cf05f4f29c99b1d00e964704f4bfeba4d16ff6bca8ac78b0049dc");
  assert.equal(w, "0x80165b29c0495aceb1b088834e04360996a667ce4c3b30bd392f112e45a6ef72");
});
