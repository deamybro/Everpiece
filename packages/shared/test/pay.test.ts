// Payment intents, instant payments and routing types (src/pay.ts): exact amounts, the lifecycle rules, request
// integrity (tamper → fails), and a payment-id vector that contracts/test/EverpiecePayVector.t.sol re-derives in Solidity.
import { test } from "node:test";
import assert from "node:assert/strict";
import { recoverTypedDataAddress, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  AUSD_TESTNET_ADDRESS,
  CTK_TESTNET_ADDRESS,
  MONAD_TESTNET_CHAIN_ID,
  RequestMode,
  ausdFor,
  canTransition,
  fromBaseUnits,
  instantAusdAuthorization,
  instantPaymentId,
  isTerminal,
  payableTokens,
  paymentRequestTyped,
  requestProblem,
  toBaseUnits,
  tokenFor,
  type InstantPayment,
  type PaymentRequest,
} from "../src/index.ts";

const PAY = "0x2222222222222222222222222222222222222222" as Address;
const ESCROW = "0x1111111111111111111111111111111111111111" as Address;
const pk = (n: number) => privateKeyToAccount(`0x${n.toString(16).padStart(64, "0")}` as Hex);

test("exact amounts: no floating point, no silent rounding", () => {
  assert.equal(toBaseUnits("25", 6), 25_000_000n);
  assert.equal(toBaseUnits("25.00", 6), 25_000_000n);
  assert.equal(toBaseUnits("$0.000001", 6), 1n);
  assert.equal(toBaseUnits("0.1", 18), 100_000_000_000_000_000n);
  assert.equal(toBaseUnits("0.0000001", 6), null); // more decimals than AUSD has
  for (const bad of ["", "-1", "1e3", "1.", ".5", "01", "1,000", "NaN", "Infinity"]) assert.equal(toBaseUnits(bad, 6), null, bad);
  assert.equal(fromBaseUnits(25_000_000n, 6), "25.00");
  assert.equal(fromBaseUnits(1n, 6), "0.000001");
  assert.equal(fromBaseUnits(25_123_400_000_000_000_000n, 18), "25.1234");
  // 0.1 + 0.2 style traps can't happen: the same string always maps to the same integer
  assert.equal(toBaseUnits("0.3", 6)! - toBaseUnits("0.1", 6)! - toBaseUnits("0.2", 6)!, 0n);
});

test("token registry: only routable tokens, by chain", () => {
  const t = payableTokens(MONAD_TESTNET_CHAIN_ID).map((x) => x.symbol);
  assert.deepEqual(t, ["AUSD", "CTK"]);
  assert.equal(ausdFor(MONAD_TESTNET_CHAIN_ID)!.address, AUSD_TESTNET_ADDRESS);
  assert.equal(tokenFor(MONAD_TESTNET_CHAIN_ID, CTK_TESTNET_ADDRESS.toLowerCase())!.route, "AGORA_INSTANT_SETTLEMENT");
  assert.equal(tokenFor(MONAD_TESTNET_CHAIN_ID, "0x0000000000000000000000000000000000000001"), undefined);
  assert.equal(payableTokens(1).length, 0); // unconfigured chain: nothing payable
});

test("lifecycle: one terminal path; no way back from claimed or refunded", () => {
  assert.ok(canTransition("CLAIMABLE", "CLAIMED"));
  assert.ok(canTransition("CLAIMABLE", "CANCELLED"));
  assert.ok(canTransition("CANCELLED", "REFUNDED"));
  assert.ok(canTransition("EXPIRED", "REFUNDED"));
  assert.ok(canTransition("SUBMITTED", "COMPLETED")); // instant send
  for (const [a, b] of [["CLAIMED", "CANCELLED"], ["CLAIMED", "REFUNDED"], ["REFUNDED", "CLAIMED"], ["CANCELLED", "CLAIMED"], ["COMPLETED", "REFUNDED"], ["EXPIRED", "CLAIMED"]] as const) {
    assert.equal(canTransition(a, b), false, `${a} -> ${b}`);
  }
  assert.ok(isTerminal("CLAIMED") && isTerminal("REFUNDED") && isTerminal("COMPLETED") && !isTerminal("CLAIMABLE"));
});

const req = (over: Partial<PaymentRequest> = {}): PaymentRequest => ({
  version: 1,
  requestId: `0x${"ab".repeat(32)}`,
  recipient: pk(2).address,
  asset: AUSD_TESTNET_ADDRESS,
  amount: 25_000_000n,
  mode: RequestMode.INSTANT,
  expiresAt: 2_000_000_000n,
  memoHash: `0x${"00".repeat(32)}`,
  ...over,
});

test("payment request: signed by the recipient; any tampered field fails verification", async () => {
  const r = req();
  const sig = await pk(2).signTypedData(paymentRequestTyped(ESCROW, r, MONAD_TESTNET_CHAIN_ID));
  assert.equal(await recoverTypedDataAddress({ ...paymentRequestTyped(ESCROW, r, MONAD_TESTNET_CHAIN_ID), signature: sig }), r.recipient);
  for (const t of [req({ amount: 250_000_000n }), req({ recipient: pk(9).address }), req({ mode: RequestMode.PROTECTED }), req({ expiresAt: 2_100_000_000n })]) {
    assert.notEqual(await recoverTypedDataAddress({ ...paymentRequestTyped(ESCROW, t, MONAD_TESTNET_CHAIN_ID), signature: sig }), r.recipient);
  }
  // another chain is another domain
  assert.notEqual(await recoverTypedDataAddress({ ...paymentRequestTyped(ESCROW, r, 143), signature: sig }), r.recipient);
});

test("payment request: structural checks before display", () => {
  const now = 1_900_000_000n;
  assert.equal(requestProblem(req(), now, MONAD_TESTNET_CHAIN_ID), null);
  assert.equal(requestProblem(req({ version: 2 }), now, MONAD_TESTNET_CHAIN_ID), "UNKNOWN_VERSION");
  assert.equal(requestProblem(req({ amount: 0n }), now, MONAD_TESTNET_CHAIN_ID), "INVALID_AMOUNT");
  assert.equal(requestProblem(req({ mode: 7 as never }), now, MONAD_TESTNET_CHAIN_ID), "INVALID_MODE");
  assert.equal(requestProblem(req({ asset: CTK_TESTNET_ADDRESS }), now, MONAD_TESTNET_CHAIN_ID), "UNSUPPORTED_NETWORK");
  assert.equal(requestProblem(req(), now, 143), "UNSUPPORTED_NETWORK");
  assert.equal(requestProblem(req({ expiresAt: now }), now, MONAD_TESTNET_CHAIN_ID), "REQUEST_EXPIRED");
});

/** Re-derived in Solidity by contracts/test/EverpiecePayVector.t.sol (same fields, PAY at 0x2222…, chain 10143). */
export const VECTOR_PAYMENT: InstantPayment = {
  ref: `0x${"0e".repeat(32)}`,
  sender: pk(1).address,
  recipient: pk(2).address,
  amount: 25_000_000n,
  sourceToken: CTK_TESTNET_ADDRESS,
  maxSourceAmount: 25_000_000_000_000_000_000n,
  deadline: 1_790_700_600n,
};
export const VECTOR_PAYMENT_ID = "0x8b97fcbd53e09821270e0d522fb3bde7a8b51204a4a78375c3036f0cc11649d0";

test("instant payment id vector + AUSD authorization nonce = payment id", () => {
  const id = instantPaymentId(PAY, VECTOR_PAYMENT, MONAD_TESTNET_CHAIN_ID);
  assert.equal(id, VECTOR_PAYMENT_ID);
  const a = instantAusdAuthorization(PAY, { ...VECTOR_PAYMENT, sourceToken: AUSD_TESTNET_ADDRESS, maxSourceAmount: 25_000_000n }, MONAD_TESTNET_CHAIN_ID, AUSD_TESTNET_ADDRESS);
  assert.equal(a.message.to, PAY);
  assert.equal(a.message.validBefore, VECTOR_PAYMENT.deadline);
  assert.equal(a.message.nonce, instantPaymentId(PAY, { ...VECTOR_PAYMENT, sourceToken: AUSD_TESTNET_ADDRESS, maxSourceAmount: 25_000_000n }, MONAD_TESTNET_CHAIN_ID));
});
