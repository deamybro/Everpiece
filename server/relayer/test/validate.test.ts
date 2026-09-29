// Offline unit tests: request schemas, config, log redaction, revert decoding. No network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { ContractFunctionRevertedError, encodeErrorResult } from "viem";
import { everpieceEscrowAbi } from "@everpiece/shared";
import { ValidationError, parseCancel, parseClaimLink, parseCreate, parseRefund } from "../src/validate.ts";
import { loadConfig } from "../src/config.ts";
import { log, setLogSink } from "../src/log.ts";
import { revertName } from "../src/relayer.ts";

const H32 = "0x" + "ab".repeat(32);
const SIG = "0x" + "cd".repeat(65);
const ADDR = "0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf";

const intent = () => ({
  sender: ADDR, mode: 1, recipientCommitment: H32, metadataCommitment: H32, approver: "0x0000000000000000000000000000000000000000",
  amount: "200000000", expiresAt: "1793232000", validAfter: "0", validBefore: "1790726400", salt: H32,
});

test("parseCreate accepts a canonical request and yields bigints", () => {
  const p = parseCreate({ intent: intent(), ausdSignature: SIG });
  assert.equal(p.intent.amount, 200000000n);
  assert.equal(p.intent.sender, ADDR);
  assert.equal(p.ausdSignature, SIG);
});

test("parseCreate rejects floats, numbers, negatives, overflow, bad mode, unknown/missing fields, bad sig length", () => {
  const bad: unknown[] = [
    { intent: { ...intent(), amount: 1.5 }, ausdSignature: SIG },
    { intent: { ...intent(), amount: 200000000 }, ausdSignature: SIG },
    { intent: { ...intent(), amount: "-1" }, ausdSignature: SIG },
    { intent: { ...intent(), amount: "01" }, ausdSignature: SIG },
    { intent: { ...intent(), amount: (1n << 256n).toString() }, ausdSignature: SIG },
    { intent: { ...intent(), mode: 3 }, ausdSignature: SIG },
    { intent: { ...intent(), mode: "1" }, ausdSignature: SIG },
    { intent: { ...intent(), extra: 1 }, ausdSignature: SIG },
    { intent: (({ salt, ...rest }) => rest)(intent()), ausdSignature: SIG },
    { intent: intent(), ausdSignature: "0x" + "cd".repeat(64) },
    { intent: { ...intent(), sender: "0x1234" }, ausdSignature: SIG },
    { intent: { ...intent(), salt: "0x" + "ab".repeat(31) }, ausdSignature: SIG },
    { intent: intent(), ausdSignature: SIG, to: ADDR, data: "0x" },
    [],
    null,
  ];
  for (const b of bad) assert.throws(() => parseCreate(b), ValidationError, JSON.stringify(b));
});

test("other action schemas", () => {
  assert.deepEqual(parseRefund({ paymentId: H32 }), { paymentId: H32 });
  assert.throws(() => parseRefund({ paymentId: H32, to: ADDR }), ValidationError);
  assert.equal(parseCancel({ paymentId: H32, actionNonce: H32, deadline: "5", senderSig: SIG }).deadline, 5n);
  assert.throws(() => parseCancel({ paymentId: H32, actionNonce: H32, deadline: "5" }), ValidationError);
  const link = parseClaimLink({
    paymentId: H32, recipient: ADDR, claimKey: ADDR, recipientSalt: H32, actionNonce: H32, deadline: "9",
    claimKeySig: SIG, approvalNonce: H32, approvalDeadline: "9", approverSig: SIG,
  });
  assert.equal(link.approvalDeadline, 9n);
});

test("config requires key, RPC and escrow; defaults are mainnet-conservative", () => {
  assert.throws(() => loadConfig({}), /RELAYER_PRIVATE_KEY/);
  assert.throws(() => loadConfig({ RELAYER_PRIVATE_KEY: "0x1234" }), /32-byte/);
  const c = loadConfig({ RELAYER_PRIVATE_KEY: "0x" + "11".repeat(32), MONAD_RPC: "http://x", ESCROW_ADDRESS: ADDR });
  assert.equal(c.expectedChainId, 143);
  assert.equal(c.gasLimits.createPayment, 350_000n);
  assert.equal(c.minRelayerBalanceWei, 11n * 10n ** 18n);
  assert.equal(c.host, "127.0.0.1");
});

test("log redacts secret-looking fields", () => {
  const lines: string[] = [];
  setLogSink((l) => lines.push(l), "debug");
  log("info", "x", { privateKey: "0xdead", otp: "123456", prfOutput: "0xbeef", hash: "0xok" });
  const j = JSON.parse(lines[0]);
  assert.equal(j.privateKey, "[redacted]");
  assert.equal(j.otp, "[redacted]");
  assert.equal(j.prfOutput, "[redacted]");
  assert.equal(j.hash, "0xok");
});

test("revertName decodes escrow custom errors, null for non-revert errors", () => {
  const data = encodeErrorResult({ abi: everpieceEscrowAbi, errorName: "PaymentNotActive" });
  const err = new ContractFunctionRevertedError({ abi: everpieceEscrowAbi, data, functionName: "cancel" });
  assert.equal(revertName(err), "PaymentNotActive");
  assert.equal(revertName(new Error("socket hang up")), null);
});
