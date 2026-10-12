import { test } from "node:test";
import assert from "node:assert/strict";
import { privateKeyToAccount } from "viem/accounts";
import { recoverTypedDataAddress } from "viem";
import { mergeAddressBook, parseAddressBook, vaultBackupTyped, vaultHashOf, type VaultSent } from "../src/index.ts";

const A = "0x1111111111111111111111111111111111111111" as const;
const B = "0x2222222222222222222222222222222222222222" as const;
const ID = (n: number) => `0x${n.toString(16).padStart(64, "0")}` as const;
const sent = (n: number, at: number): VaultSent => ({ paymentId: ID(n), amount: "1000000", to: "@maris", createdAt: at, expiresAt: "1900000000" });

test("parse accepts the fixed shape and drops anything else", () => {
  const ok = parseAddressBook(JSON.stringify({ v: 1, savedAt: 5, contacts: [{ username: "maris", account: A }, { username: "Bad Name!", account: A }, { username: "x", account: "0xnope" }], sent: [sent(1, 10), { paymentId: "nope" }] }));
  assert.deepEqual(ok?.contacts, [{ username: "maris", account: A }]);
  assert.equal(ok?.sent.length, 1);
  assert.equal(parseAddressBook("not json"), null);
  assert.equal(parseAddressBook(JSON.stringify({ v: 2, contacts: [], sent: [] })), null);
  assert.equal(parseAddressBook(JSON.stringify({ v: 1, contacts: new Array(501).fill({ username: "a", account: A }), sent: [] })), null);
});

test("a restore never replaces a contact this device already pinned", () => {
  const m = mergeAddressBook({ pins: { maris: A }, sent: [sent(1, 10)] }, { v: 1, savedAt: 0, contacts: [{ username: "maris", account: B }, { username: "ada", account: B }], sent: [sent(1, 10), sent(2, 20)] });
  assert.equal(m.pins.maris, A); // the existing pin wins: it is what warns if an account changes
  assert.equal(m.pins.ada, B);
  assert.equal(m.addedContacts, 1);
  assert.equal(m.addedSent, 1);
  assert.deepEqual(m.sent.map((s) => s.paymentId), [ID(2), ID(1)]); // newest first, no duplicates
});

test("the backup signature binds the account, the exact vault, the sequence number and a deadline", async () => {
  const acct = privateKeyToAccount(`0x${"07".repeat(32)}`);
  const vault = JSON.stringify({ version: 1, ciphertext: "abc" });
  const typed = vaultBackupTyped(A, { account: acct.address, vaultHash: vaultHashOf(vault), seq: 3n, deadline: 2_000_000_000n }, 143);
  const sig = await acct.signTypedData(typed);
  assert.equal(await recoverTypedDataAddress({ ...typed, signature: sig }), acct.address);
  const other = vaultBackupTyped(A, { account: acct.address, vaultHash: vaultHashOf(vault + " "), seq: 3n, deadline: 2_000_000_000n }, 143);
  assert.notEqual(await recoverTypedDataAddress({ ...other, signature: sig }), acct.address); // a different vault does not verify
});
