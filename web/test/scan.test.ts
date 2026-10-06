// What a scanned QR may lead to: only this site's own /pay/<32-byte id> links. (node --test, no browser needed)
import { test } from "node:test";
import assert from "node:assert/strict";
import { requestIdFromScan } from "../lib/scan.ts";

const O = "https://test.everpiece.xyz";
const ID = `0x${"ab".repeat(32)}`;

test("accepts exactly our origin's /pay/<id>", () => {
  assert.equal(requestIdFromScan(`${O}/pay/${ID}`, O), ID);
  assert.equal(requestIdFromScan(`  ${O}/pay/${ID.toUpperCase().replace("0X", "0x")}\n`, O), ID);
});

test("refuses other sites, schemes, extra data, malformed ids and oversized payloads", () => {
  for (const bad of [
    `https://evil.example/pay/${ID}`, `http://test.everpiece.xyz/pay/${ID}`, `everpiece://pay/${ID}`, `javascript:alert(1)`,
    `${O}/pay/${ID}?amount=250`, `${O}/pay/${ID}#x`, `${O}/pay/0x1234`, `${O}/c/${ID}`, `${O}/pay/${ID}/extra`, "not a url",
    `${O}/pay/${ID}${"a".repeat(600)}`,
  ]) assert.equal(requestIdFromScan(bad, O), null, bad);
});

test("bank-payout links open /payout/<id>; Dollar links /pay/<id>; nothing else", async () => {
  const { requestPathFromScan } = await import("../lib/scan.ts");
  assert.equal(requestPathFromScan(`${O}/payout/${ID}`, O), `/payout/${ID}`);
  assert.equal(requestPathFromScan(`${O}/pay/${ID}`, O), `/pay/${ID}`);
  for (const bad of [`https://evil.example/payout/${ID}`, `${O}/payout/${ID}?bank=1`, `${O}/payout/0x12`, `${O}/payouts/${ID}`]) assert.equal(requestPathFromScan(bad, O), null, bad);
});
