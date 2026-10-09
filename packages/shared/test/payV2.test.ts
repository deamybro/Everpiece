// EverpiecePayV2 typed data (src/payV2.ts): USDC + AUSD settlement, the one ERC-3009 authorization in the SOURCE
// token's domain, and a payment-id vector that contracts/test/EverpiecePayV2.t.sol re-derives in Solidity.
import { test } from "node:test";
import assert from "node:assert/strict";
import { hashDomain, recoverTypedDataAddress, type Address } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  AUSD_ADDRESS,
  MONAD_MAINNET_CHAIN_ID,
  USDC_MAINNET_ADDRESS,
  defaultSettlementAsset,
  paymentV2Authorization,
  paymentV2Id,
  paymentV2Problem,
  routeOf,
  settlementAsset,
  type PaymentV2,
} from "../src/index.ts";

const PAY = "0x3333333333333333333333333333333333333333" as Address;
const payer = privateKeyToAccount("0x0000000000000000000000000000000000000000000000000000000000000001");

export const VECTOR_PAYMENT_V2: PaymentV2 = {
  ref: "0x0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e",
  sender: payer.address,
  recipient: "0x2B5AD5c4795c026514f8317c7a215E218DcCD6cF", // vm.addr(2)
  asset: AUSD_ADDRESS,
  amount: 25_000_000n,
  sourceToken: USDC_MAINNET_ADDRESS,
  maxSourceAmount: 25_025_000n,
  deadline: 1_790_700_600n,
  fallbackToSource: true,
};
export const VECTOR_PAYMENT_V2_ID = "0xbbf2d8045d85ca80d9da50e31578985049eca17f4754b1db49ab76f85b0334c7";

test("USDC is the default settlement asset; both are first-class", () => {
  assert.equal(defaultSettlementAsset(MONAD_MAINNET_CHAIN_ID)?.symbol, "USDC");
  assert.equal(settlementAsset(MONAD_MAINNET_CHAIN_ID, AUSD_ADDRESS)?.symbol, "AUSD");
  assert.equal(settlementAsset(10143, USDC_MAINNET_ADDRESS), undefined);
});

test("token EIP-712 domains equal the live mainnet DOMAIN_SEPARATOR()s (VERIFIED §2.4, §4.18)", () => {
  const usdc = settlementAsset(MONAD_MAINNET_CHAIN_ID, USDC_MAINNET_ADDRESS)!;
  const ausd = settlementAsset(MONAD_MAINNET_CHAIN_ID, AUSD_ADDRESS)!;
  const types = { EIP712Domain: [{ name: "name", type: "string" }, { name: "version", type: "string" }, { name: "chainId", type: "uint256" }, { name: "verifyingContract", type: "address" }] } as const;
  const sep = (a: typeof usdc) => hashDomain({ domain: { ...a.eip712, chainId: BigInt(MONAD_MAINNET_CHAIN_ID), verifyingContract: a.address }, types });
  assert.equal(sep(usdc), "0xfe22123edc0dd4aeb912eb7948c5f0e531592c2053b3067612f427db342c93c6");
  assert.equal(sep(ausd), "0x995063441ebf2219c94dce05014a545da4390d2362f99b3d7ad456046678cafe");
});

test("payment id vector (Solidity re-derives it)", () => {
  assert.equal(paymentV2Id(PAY, VECTOR_PAYMENT_V2, MONAD_MAINNET_CHAIN_ID), VECTOR_PAYMENT_V2_ID);
});

test("the authorization is in the SOURCE token's domain, binds the id, and recovers to the payer", async () => {
  const a = paymentV2Authorization(PAY, VECTOR_PAYMENT_V2, MONAD_MAINNET_CHAIN_ID);
  assert.equal(a.domain.name, "USDC");
  assert.equal(a.domain.version, "2");
  assert.equal(a.domain.verifyingContract, USDC_MAINNET_ADDRESS);
  assert.equal(a.message.value, VECTOR_PAYMENT_V2.maxSourceAmount);
  assert.equal(a.message.nonce, VECTOR_PAYMENT_V2_ID);
  const sig = await payer.signTypedData(a);
  assert.equal(await recoverTypedDataAddress({ ...a, signature: sig }), payer.address);
  // any changed term → a different id → a different nonce: the signature no longer covers it
  for (const change of [{ recipient: PAY }, { amount: 25_000_001n }, { asset: USDC_MAINNET_ADDRESS }, { deadline: 1n }, { fallbackToSource: false }] as Partial<PaymentV2>[]) {
    assert.notEqual(paymentV2Id(PAY, { ...VECTOR_PAYMENT_V2, ...change }, MONAD_MAINNET_CHAIN_ID), VECTOR_PAYMENT_V2_ID);
  }
});

test("structural problems: no silent substitution, direct = exact", () => {
  const now = 1_790_700_000n;
  assert.equal(paymentV2Problem(VECTOR_PAYMENT_V2, MONAD_MAINNET_CHAIN_ID, now), null);
  assert.equal(routeOf(AUSD_ADDRESS, USDC_MAINNET_ADDRESS), "CONVERTED");
  const direct = { ...VECTOR_PAYMENT_V2, asset: USDC_MAINNET_ADDRESS };
  assert.equal(paymentV2Problem(direct, MONAD_MAINNET_CHAIN_ID, now), "DIRECT_AMOUNT_MISMATCH");
  assert.equal(paymentV2Problem({ ...direct, maxSourceAmount: direct.amount }, MONAD_MAINNET_CHAIN_ID, now), null);
  assert.equal(paymentV2Problem({ ...VECTOR_PAYMENT_V2, asset: PAY }, MONAD_MAINNET_CHAIN_ID, now), "UNSUPPORTED_ASSET");
  assert.equal(paymentV2Problem({ ...VECTOR_PAYMENT_V2, sourceToken: PAY }, MONAD_MAINNET_CHAIN_ID, now), "UNSUPPORTED_ROUTE");
  assert.equal(paymentV2Problem({ ...VECTOR_PAYMENT_V2, amount: 0n }, MONAD_MAINNET_CHAIN_ID, now), "ZERO_AMOUNT");
  assert.equal(paymentV2Problem(VECTOR_PAYMENT_V2, MONAD_MAINNET_CHAIN_ID, VECTOR_PAYMENT_V2.deadline), "EXPIRED");
  assert.equal(paymentV2Problem({ ...VECTOR_PAYMENT_V2, maxSourceAmount: 24_000_000n }, MONAD_MAINNET_CHAIN_ID, now), "FALLBACK_EXCEEDS_MAX");
  assert.throws(() => paymentV2Authorization(PAY, { ...VECTOR_PAYMENT_V2, sourceToken: PAY }, MONAD_MAINNET_CHAIN_ID));
});
