import assert from "node:assert/strict";
import { test } from "node:test";
import { activityLabel, activityTitle, matchesActivity } from "../lib/activity-view.ts";
import type { HistoryItem } from "../lib/history.ts";

const item: HistoryItem = { paymentId: `0x${"1".repeat(64)}`, direction: "sent", amount: 1234567n, mode: 2, state: "protected", counterparty: "@recipient", at: 100, expiresAt: 200n };
test("protected and expired payments never appear completed", () => {
  assert.equal(activityLabel(item), "Awaiting claim");
  assert.equal(matchesActivity(item, "Awaiting claim"), true);
  assert.equal(matchesActivity({ ...item, state: "expired" }, "Awaiting claim"), false);
  assert.equal(activityLabel({ ...item, state: "expired" }), "Expired · return available");
  assert.equal(matchesActivity(item, "Claimed"), false);
});
test("returns remain distinct from receipts and completed sends", () => {
  for (const state of ["cancelled", "refunded"] as const) {
    const returned = { ...item, state };
    assert.equal(matchesActivity(returned, "Returned"), true);
    assert.equal(matchesActivity(returned, "Received"), false);
    assert.match(activityTitle(returned), /^Returned payment/);
  }
  assert.equal(activityLabel({ ...item, state: "paid" }), "Sent");
  assert.equal(activityLabel({ ...item, direction: "received", state: "paid" }), "Received");
  assert.equal(activityLabel({ ...item, direction: "received", state: "claimed" }), "Received");
});
test("an account's own conversion is a movement, never income", () => {
  const conversion = { ...item, state: "paid" as const, counterparty: "yourself (converted to Dollars)" };
  assert.equal(activityTitle(conversion), "Converted to Dollars");
  assert.equal(matchesActivity(conversion, "Received"), false);
  assert.equal(matchesActivity(conversion, "Sent"), true);
});
