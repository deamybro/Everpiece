import { test } from "node:test";
import assert from "node:assert/strict";
import { hashTypedData, type Address } from "viem";
import { aaveRates, earnDepositTyped, earnPosition, earnWithdrawalTyped, harvestProblem, harvestRef, isHarvestRef, ledgerFromEvents, withOnchainPrincipal, EARN_OPPORTUNITIES, HARVEST_ROUNDING_MARGIN, type LedgerEntry } from "../src/index.ts";

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

test("indexed events → ledger: harvests are recognised by their signed ref; other vaults are ignored", () => {
  const V = "0x00000000000000000000000000000000000000aa" as Address;
  const h = harvestRef(`0x${"cd".repeat(28)}`);
  assert.ok(isHarvestRef(h) && !isHarvestRef(`0x${"cd".repeat(32)}`));
  assert.throws(() => harvestRef("0x1234"));
  const entries = ledgerFromEvents([
    { id: "a", kind: "DEPOSIT", ref: `0x${"00".repeat(32)}`, vault: V, assets: $(500) },
    { id: "b", kind: "WITHDRAW", ref: h, vault: V, assets: $(10) },
    { id: "c", kind: "WITHDRAW", ref: `0x${"11".repeat(32)}`, vault: V, assets: $(50) },
    { id: "d", kind: "DEPOSIT", ref: `0x${"00".repeat(32)}`, vault: "0x00000000000000000000000000000000000000bb", assets: $(999) },
  ], V);
  assert.deepEqual(entries.map((e) => e.kind), ["DEPOSIT", "HARVEST", "WITHDRAW"]);
  const p = earnPosition(M, entries, $(452.4));
  assert.equal(p.netPrincipal, $(450));
  assert.equal(p.yieldAlreadyHarvested, $(10));
});

test("on-chain principal wins over a lagging ledger: a deposit the indexer hasn't seen is never harvestable", () => {
  const lagging = earnPosition(M, [], $(500)); // indexer hasn't seen the $500 deposit yet
  assert.equal(lagging.harvestableYield, $(500) - HARVEST_ROUNDING_MARGIN); // the ledger alone would be wrong
  const safe = withOnchainPrincipal(lagging, $(500));
  assert.equal(safe.netPrincipal, $(500));
  assert.equal(safe.harvestableYield, 0n);
  assert.equal(withOnchainPrincipal(earnPosition(M, [], $(512.4)), $(500)).harvestableYield, $(12.4) - HARVEST_ROUNDING_MARGIN);
});

test("unknown accounting models are refused", () => {
  assert.throws(() => earnPosition("REBASING" as never, [], 0n), /UNSUPPORTED_ACCOUNTING_MODEL/);
});

test("Aave rate conversion: 3.0891e25 ray ≈ 3.09% APR, APY slightly higher; display only", () => {
  const r = aaveRates(30_891_895_368_338_275_244_281_642n);
  assert.equal(r.aprBps, 309);
  assert.ok(r.apyBps >= 313 && r.apyBps <= 314);
});

test("registry: the mainnet opportunities are exactly the verified Aave AUSD and USDC wrappers; no APY constant anywhere", () => {
  assert.deepEqual(
    EARN_OPPORTUNITIES.map((o) => [o.id, o.vault, o.asset]),
    [
      ["aave-v3-ausd", "0x9e1AcC5BFbf34e2E579763cE14042d957719fE76", "0x00000000eFE302BEAA2b3e6e1b18d08D69a9012a"],
      ["aave-v3-usdc", "0xC554aFfE2f581F5E0811e0D42D484ECaC5c6B8e2", "0x754704Bc059F8C67012fEd69BC8A327a5aafb603"],
    ],
  );
  for (const o of EARN_OPPORTUNITIES) {
    assert.equal(o.rateSource.kind, "AAVE_V3_LIQUIDITY_RATE");
    assert.ok(o.rateSource.kind === "AAVE_V3_LIQUIDITY_RATE" && o.rateSource.reserve === o.asset);
    assert.ok(!JSON.stringify(o).match(/apy|apr/i));
  }
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
