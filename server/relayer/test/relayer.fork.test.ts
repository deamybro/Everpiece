// Relayer against a local anvil fork of Monad mainnet with the REAL AUSD. Enable with RUN_FORK_TESTS=true.
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { createHttpServer, Relayer } from "../src/index.ts";
import {
  RUN, ausdBalance, baseConfig, cancelBody, claimLinkBody, claimUsernameBody, fundingSig, getReq, keys,
  linkIntent, now, post, relayerNonce, settle, startEnv, usernameIntent, type Env,
} from "./harness.ts";

describe("relayer on a Monad mainnet fork (real AUSD)", { skip: !RUN }, () => {
  let env: Env;
  before(async () => {
    env = await startEnv();
  });
  after(async () => {
    await env?.stop();
  });

  // ------------------------------------------------------------------ happy paths

  test("create: PROCESSING while not final, CONFIRMED only after finality; idempotent retry", async () => {
    const { intent, paymentId } = await usernameIntent(env);
    const body = { intent, ausdSignature: await fundingSig(env, intent) };
    const nonceBefore = await relayerNonce(env);

    const r = await post(env, "/v1/payments/create", body);
    assert.equal(r.status, 202, JSON.stringify(r.body));
    assert.equal(r.body.status, "PROCESSING");
    assert.equal(r.body.paymentId, paymentId);
    assert.match(r.body.txHash, /^0x[0-9a-f]{64}$/);

    // Included (anvil automines) but NOT final: must still be PROCESSING — inclusion is not success (D9).
    await new Promise((res) => setTimeout(res, 400));
    assert.equal((await getReq(env, r.body.requestId)).status, "PROCESSING");

    const again = await post(env, "/v1/payments/create", body);
    assert.equal(again.status, 200);
    assert.equal(again.body.idempotent, true);
    assert.equal(again.body.requestId, r.body.requestId);

    const done = await settle(env, r.body.requestId);
    assert.equal(done.status, "CONFIRMED", JSON.stringify(done));
    assert.equal(done.chainStatus, 1);
    assert.ok(BigInt(done.gasUsed) <= 350_000n);
    assert.equal(await relayerNonce(env), nonceBefore + 1); // exactly one transaction despite the retry
    assert.equal(await ausdBalance(env, env.escrow) >= intent.amount, true);
  });

  test("username claim → CONFIRMED; recipient receives exact amount", async () => {
    const { intent, paymentId, recipientSalt } = await usernameIntent(env, 12_000_000n);
    const c = await post(env, "/v1/payments/create", { intent, ausdSignature: await fundingSig(env, intent) });
    await settle(env, c.body.requestId);
    const before = await ausdBalance(env, keys.recipient.address);
    const r = await post(env, "/v1/payments/claim-username", await claimUsernameBody(env, paymentId, recipientSalt));
    assert.equal(r.status, 202, JSON.stringify(r.body));
    const done = await settle(env, r.body.requestId);
    assert.equal(done.status, "CONFIRMED", JSON.stringify(done));
    assert.equal(done.chainStatus, 2);
    assert.equal((await ausdBalance(env, keys.recipient.address)) - before, 12_000_000n);
  });

  test("link claim (both factors) → CONFIRMED", async () => {
    const { intent, paymentId, recipientSalt } = await linkIntent(env, 7_000_000n);
    const c = await post(env, "/v1/payments/create", { intent, ausdSignature: await fundingSig(env, intent) });
    assert.equal((await settle(env, c.body.requestId)).status, "CONFIRMED");
    const r = await post(env, "/v1/payments/claim-link", await claimLinkBody(env, paymentId, recipientSalt));
    assert.equal(r.status, 202, JSON.stringify(r.body));
    const done = await settle(env, r.body.requestId);
    assert.equal(done.status, "CONFIRMED", JSON.stringify(done));
  });

  test("cancel → CONFIRMED; money returned to sender", async () => {
    const { intent, paymentId } = await usernameIntent(env, 9_000_000n);
    const c = await post(env, "/v1/payments/create", { intent, ausdSignature: await fundingSig(env, intent) });
    await settle(env, c.body.requestId);
    const before = await ausdBalance(env, keys.sender.address);
    const r = await post(env, "/v1/payments/cancel", await cancelBody(env, paymentId));
    assert.equal(r.status, 202, JSON.stringify(r.body));
    const done = await settle(env, r.body.requestId);
    assert.equal(done.status, "CONFIRMED");
    assert.equal(done.chainStatus, 3);
    assert.equal((await ausdBalance(env, keys.sender.address)) - before, 9_000_000n);
  });

  test("refundExpired after expiry → CONFIRMED (permissionless)", async () => {
    const { intent, paymentId } = await usernameIntent(env, 3_000_000n);
    const c = await post(env, "/v1/payments/create", { intent, ausdSignature: await fundingSig(env, intent) });
    await settle(env, c.body.requestId);
    const early = await post(env, "/v1/payments/refund", { paymentId });
    assert.equal(early.status, 422);
    assert.equal(early.body.error, "PaymentNotExpired");
    await env.test.increaseTime({ seconds: 3 * 86_400 });
    await env.test.mine({ blocks: 1 });
    const r = await post(env, "/v1/payments/refund", { paymentId });
    assert.equal(r.status, 202, JSON.stringify(r.body));
    assert.equal((await settle(env, r.body.requestId)).status, "CONFIRMED");
  });

  // ------------------------------------------------------------------ rejected before broadcast (no gas spent)

  test("tampered intent is rejected off-chain; no transaction sent", async () => {
    const { intent } = await usernameIntent(env);
    const ausdSignature = await fundingSig(env, intent);
    const nonce = await relayerNonce(env);
    const r = await post(env, "/v1/payments/create", { intent: { ...intent, amount: intent.amount + 1n }, ausdSignature });
    assert.equal(r.status, 401);
    assert.equal(r.body.error, "InvalidFundingSignature");
    assert.equal(await relayerNonce(env), nonce);
  });

  test("valid signature but on-chain rule violated → 422 with decoded escrow error; no transaction", async () => {
    const { intent, paymentId, recipientSalt } = await usernameIntent(env);
    const c = await post(env, "/v1/payments/create", { intent, ausdSignature: await fundingSig(env, intent) });
    await settle(env, c.body.requestId);
    // the SENDER signs a claim to themselves: signature is valid, the escrow refuses (master §10.4)
    const nonce = await relayerNonce(env);
    const r = await post(env, "/v1/payments/claim-username", await claimUsernameBody(env, paymentId, recipientSalt, keys.sender));
    assert.equal(r.status, 422);
    assert.equal(r.body.error, "RecipientMismatch");
    assert.equal(r.body.status, "REJECTED");
    assert.equal(await relayerNonce(env), nonce);
  });

  test("below application minimum → 422; wrong-signer cancel → 401", async () => {
    const small = await usernameIntent(env, 999_999n);
    const r1 = await post(env, "/v1/payments/create", { intent: small.intent, ausdSignature: await fundingSig(env, small.intent) });
    assert.equal(r1.status, 422);
    assert.equal(r1.body.error, "BelowMinimumPayment");

    const { intent, paymentId } = await usernameIntent(env);
    const c = await post(env, "/v1/payments/create", { intent, ausdSignature: await fundingSig(env, intent) });
    await settle(env, c.body.requestId);
    const r2 = await post(env, "/v1/payments/cancel", await cancelBody(env, paymentId, keys.stranger));
    assert.equal(r2.status, 401);
    assert.equal(r2.body.error, "InvalidSenderSignature");
  });

  test("link claim with a forged approval → 401 before any RPC simulation", async () => {
    const { intent, paymentId, recipientSalt } = await linkIntent(env);
    const c = await post(env, "/v1/payments/create", { intent, ausdSignature: await fundingSig(env, intent) });
    await settle(env, c.body.requestId);
    const body = await claimLinkBody(env, paymentId, recipientSalt);
    const forged = await keys.stranger.signTypedData({
      domain: { name: "Everpiece Escrow", version: "1", chainId: 143, verifyingContract: env.escrow },
      types: { ClaimApproval: [{ name: "paymentId", type: "bytes32" }, { name: "recipient", type: "address" }, { name: "approvalNonce", type: "bytes32" }, { name: "deadline", type: "uint256" }] },
      primaryType: "ClaimApproval",
      message: { paymentId, recipient: body.recipient, approvalNonce: body.approvalNonce, deadline: body.approvalDeadline },
    });
    const r = await post(env, "/v1/payments/claim-link", { ...body, approverSig: forged });
    assert.equal(r.status, 401);
    assert.equal(r.body.error, "InvalidApproverSignature");
  });

  // ------------------------------------------------------------------ HTTP hygiene / allow-list

  test("no arbitrary relay endpoint; strict media type, size, JSON and schema", async () => {
    assert.equal((await post(env, "/v1/relay", { to: env.escrow, data: "0x" })).status, 404);
    assert.equal((await fetch(env.base + "/v1/payments/create")).status, 405);
    assert.equal((await post(env, "/v1/payments/refund", '{"paymentId":"0x00"}', { "content-type": "text/plain" })).status, 415);
    assert.equal((await post(env, "/v1/payments/refund", "{not json")).status, 400);
    assert.equal((await post(env, "/v1/payments/refund", { paymentId: "0x" + "11".repeat(32), extra: 1 })).status, 400);
    assert.equal((await post(env, "/v1/payments/refund", { paymentId: "0x" + "11".repeat(32), pad: "x".repeat(9_000) })).status, 413);
    const bad = await post(env, "/v1/payments/create", { intent: { amount: 1.5 }, ausdSignature: "0x" });
    assert.equal(bad.status, 400);
    assert.equal((await fetch(env.base + "/v1/requests/00000000-0000-0000-0000-000000000000")).status, 404);
  });

  // ------------------------------------------------------------------ inclusion != success (D9)

  test("claim/cancel race: both pass simulation, both included — the loser is FAILED (RevertedOnChain), chain state wins", async () => {
    const { intent, paymentId, recipientSalt } = await usernameIntent(env, 5_000_000n);
    const c = await post(env, "/v1/payments/create", { intent, ausdSignature: await fundingSig(env, intent) });
    await settle(env, c.body.requestId);

    await env.test.setAutomine(false);
    try {
      const claim = await post(env, "/v1/payments/claim-username", await claimUsernameBody(env, paymentId, recipientSalt));
      const cancel = await post(env, "/v1/payments/cancel", await cancelBody(env, paymentId));
      assert.equal(claim.status, 202, JSON.stringify(claim.body));
      assert.equal(cancel.status, 202, JSON.stringify(cancel.body)); // simulated against pre-race state
      await env.test.mine({ blocks: 1 }); // both land in one block; claim first (lower nonce)
      await env.test.setAutomine(true);
      const [a, b] = [await settle(env, claim.body.requestId), await settle(env, cancel.body.requestId)];
      assert.equal(a.status, "CONFIRMED");
      assert.equal(b.status, "FAILED");
      assert.equal(b.error, "RevertedOnChain");
      assert.equal(b.chainStatus, 2); // reconciled to canonical state: CLAIMED
    } finally {
      await env.test.setAutomine(true);
    }
  });

  // ------------------------------------------------------------------ abuse guards (separate relayer instances)

  async function withRelayer(over: Parameters<typeof baseConfig>[2], fn: (base: string) => Promise<void>) {
    const r = new Relayer(baseConfig(env.rpc, env.escrow, over));
    await r.start();
    const s = createHttpServer(r);
    await new Promise<void>((res) => s.listen(0, "127.0.0.1", res));
    try {
      await fn(`http://127.0.0.1:${(s.address() as { port: number }).port}`);
    } finally {
      s.close();
      await r.stop();
    }
  }

  test("per-IP rate limit → 429", async () => {
    await withRelayer({ perIpPerMinute: 2 }, async (base) => {
      const body = JSON.stringify({ paymentId: "0x" + "22".repeat(32) });
      const hit = () => fetch(base + "/v1/payments/refund", { method: "POST", headers: { "content-type": "application/json" }, body }).then((r) => r.status);
      assert.equal(await hit(), 422);
      assert.equal(await hit(), 422);
      assert.equal(await hit(), 429);
    });
  });

  test("low relayer balance → 503, request REJECTED, nothing broadcast", async () => {
    await withRelayer({ minRelayerBalanceWei: 10n ** 30n }, async (base) => {
      const { intent } = await usernameIntent(env);
      const nonce = await relayerNonce(env);
      const r = await fetch(base + "/v1/payments/create", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ intent, ausdSignature: await fundingSig(env, intent) }, (_k, v) => (typeof v === "bigint" ? v.toString() : v)),
      });
      const j = (await r.json()) as Record<string, any>;
      assert.equal(r.status, 503);
      assert.equal(j.error, "RelayerUnavailable");
      assert.equal(await relayerNonce(env), nonce);
    });
  });

  test("daily gas budget → 503 DailyBudgetExhausted", async () => {
    await withRelayer({ dailyGasBudget: 100_000n }, async (base) => {
      const { intent } = await usernameIntent(env);
      const r = await fetch(base + "/v1/payments/create", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ intent, ausdSignature: await fundingSig(env, intent) }, (_k, v) => (typeof v === "bigint" ? v.toString() : v)),
      });
      assert.equal(r.status, 503);
      assert.equal(((await r.json()) as Record<string, any>).error, "DailyBudgetExhausted");
    });
  });

  test("startup refuses wrong chain id and wrong escrow", async () => {
    await assert.rejects(new Relayer(baseConfig(env.rpc, env.escrow, { expectedChainId: 1 })).start(), /chainId/);
    await assert.rejects(new Relayer(baseConfig(env.rpc, keys.stranger.address)).start(), /no code at ESCROW_ADDRESS/);
  });

  test("logs never contain the relayer key", () => {
    const key = "e1".padStart(64, "0");
    assert.ok(env.logs.length > 0);
    assert.ok(!env.logs.some((l) => l.includes(key)));
  });

  test("gas observations: every confirmed tx used less than its explicit limit", (t) => {
    const rows = env.relayer.store.byStatus("CONFIRMED");
    assert.ok(rows.length >= 6);
    const byMethod = new Map<string, bigint[]>();
    for (const r of rows) {
      assert.ok(BigInt(r.gas_used!) < BigInt(r.gas_limit), `${r.method} used ${r.gas_used} of ${r.gas_limit}`);
      byMethod.set(r.method, [...(byMethod.get(r.method) ?? []), BigInt(r.gas_used!)]);
    }
    for (const [m, g] of byMethod) t.diagnostic(`gasUsed ${m}: ${g.join(", ")} (limit ${env.relayer.cfg.gasLimits[m as keyof typeof env.relayer.cfg.gasLimits]})`);
  });

  test("health reports chain and relayer", async () => {
    const h = (await (await fetch(env.base + "/healthz")).json()) as Record<string, any>;
    assert.equal(h.chainId, 143);
    assert.equal(h.relayer, keys.relayer.address);
    assert.equal(h.ok, true);
    assert.ok(typeof now === "function");
  });
});
