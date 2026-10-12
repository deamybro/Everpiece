import { test, mock } from "node:test";
import assert from "node:assert/strict";
import type { LocalAccount } from "viem";
import { getSessionSnapshot, lockSession, startSession, takeFromSession } from "../lib/session.ts";

const ADDR = "0x1111111111111111111111111111111111111111" as const;
const OTHER = "0x2222222222222222222222222222222222222222" as const;
const open = (cap = 20_000_000n, ttlMs = 300_000) => {
  let ended = 0;
  startSession({ address: ADDR, signer: {} as LocalAccount, end: () => void ended++, inboxKey: "0x01", messageSeed: "0x02", ttlMs, cap });
  return { ended: () => ended };
};

test("spending stays inside the cap and is refunded if the action fails", () => {
  const s = open();
  const a = takeFromSession(ADDR, 15_000_000n);
  assert.ok(a);
  assert.equal(getSessionSnapshot()?.capLeft, 5_000_000n);
  assert.equal(takeFromSession(ADDR, 5_000_001n), null); // over what is left: the caller must ask for a fingerprint
  a!.refund();
  assert.equal(getSessionSnapshot()?.capLeft, 20_000_000n);
  lockSession();
  assert.equal(s.ended(), 1);
});

test("only the account that unlocked can use it", () => {
  open();
  assert.equal(takeFromSession(OTHER, 1n), null);
  lockSession();
});

test("it closes by itself when the time is up, and the key is ended exactly once", () => {
  mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const s = open(20_000_000n, 1_000);
  assert.ok(takeFromSession(ADDR, 1n));
  mock.timers.tick(1_000);
  assert.equal(getSessionSnapshot(), null);
  assert.equal(takeFromSession(ADDR, 1n), null);
  assert.equal(s.ended(), 1);
  lockSession();
  assert.equal(s.ended(), 1);
  mock.timers.reset();
});

test("starting a new session ends the old one; a refund after locking does nothing", () => {
  const first = open();
  const a = takeFromSession(ADDR, 1n)!;
  const second = open();
  assert.equal(first.ended(), 1);
  a.refund();
  assert.equal(getSessionSnapshot()?.capLeft, 20_000_000n);
  lockSession();
  assert.equal(second.ended(), 1);
});
