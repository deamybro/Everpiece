// Simulated events through the real handlers (envio createTestIndexer: no database, no Docker, no network).
import { describe, expect, it } from "vitest";
import { createTestIndexer } from "envio";

type Hex = `0x${string}`;
const SENDER: Hex = "0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf"; // address of private key 1
const RECIPIENT: Hex = "0x2B5AD5c4795c026514f8317c7a215E218DcCD6cF"; // key 2
const ANYONE: Hex = "0x6813Eb9362372EEF6200f3b1dbC3f819671cBA69"; // key 3
const id = (n: number): Hex => `0x${n.toString(16).padStart(64, "0")}`;
const tx = (n: number): Hex => `0x${(0xabc000 + n).toString(16).padStart(64, "0")}`;

const created = (n: number, amount: bigint, block: number, mode = 2) => ({
  contract: "EverpieceEscrow" as const,
  event: "PaymentCreated" as const,
  block: { number: block, timestamp: 1_790_000_000 + block },
  transaction: { hash: tx(block) },
  params: {
    paymentId: id(n),
    sender: SENDER,
    recipientCommitment: id(1000 + n),
    mode: BigInt(mode),
    metadataCommitment: id(0),
    approver: ANYONE,
    amount,
    expiresAt: 1_792_592_000n,
  },
});
const claimed = (n: number, amount: bigint, block: number) => ({
  contract: "EverpieceEscrow" as const,
  event: "PaymentClaimed" as const,
  block: { number: block, timestamp: 1_790_000_000 + block },
  transaction: { hash: tx(block) },
  params: { paymentId: id(n), recipient: RECIPIENT, amount },
});
const cancelled = (n: number, amount: bigint, block: number) => ({
  contract: "EverpieceEscrow" as const,
  event: "PaymentCancelled" as const,
  block: { number: block, timestamp: 1_790_000_000 + block },
  transaction: { hash: tx(block) },
  params: { paymentId: id(n), sender: SENDER, amount },
});
const refunded = (n: number, amount: bigint, block: number) => ({
  contract: "EverpieceEscrow" as const,
  event: "PaymentRefunded" as const,
  block: { number: block, timestamp: 1_790_000_000 + block },
  transaction: { hash: tx(block) },
  params: { paymentId: id(n), sender: SENDER, amount, caller: ANYONE },
});

describe("EverpieceEscrow history", () => {
  it("created → claimed: status, recipient, timeline, metrics", async () => {
    const indexer = createTestIndexer();
    await indexer.process({ chains: { 143: { simulate: [created(1, 25_000_000n, 10), claimed(1, 25_000_000n, 12)] } } });

    const p = await indexer.Payment.getOrThrow(id(1));
    expect(p).toMatchObject({ status: "CLAIMED", sender: SENDER, recipient: RECIPIENT, amount: 25_000_000n, mode: 2 });
    expect(p).toMatchObject({ createdBlock: 10, createdTx: tx(10), settledBlock: 12, settledTx: tx(12), settledAt: 1_790_000_012 });

    const timeline = (await indexer.PaymentEvent.getWhere({ payment_id: { _eq: id(1) } })).sort((a, b) => a.blockNumber - b.blockNumber);
    expect(timeline.map((e) => [e.kind, e.actor, e.blockNumber])).toEqual([["CREATED", SENDER, 10], ["CLAIMED", RECIPIENT, 12]]);

    expect(await indexer.Stats.getOrThrow("143")).toMatchObject({
      created: 1, createdVolume: 25_000_000n, claimed: 1, claimedVolume: 25_000_000n, activeCount: 0, activeLiability: 0n,
    });
  });

  it("cancel, refund (with caller), and a still-active payment: metrics mirror the escrow's liability", async () => {
    const indexer = createTestIndexer();
    await indexer.process({
      chains: {
        143: {
          simulate: [
            created(1, 10_000_000n, 10), created(2, 5_000_000n, 11, 1), created(3, 7_000_000n, 12),
            cancelled(1, 10_000_000n, 13), refunded(2, 5_000_000n, 14),
          ],
        },
      },
    });
    expect(await indexer.Payment.getOrThrow(id(1))).toMatchObject({ status: "CANCELLED", recipient: undefined });
    expect(await indexer.Payment.getOrThrow(id(2))).toMatchObject({ status: "REFUNDED", refundCaller: ANYONE, mode: 1 });
    expect(await indexer.Payment.getOrThrow(id(3))).toMatchObject({ status: "ACTIVE", settledBlock: undefined });
    expect(await indexer.Stats.getOrThrow("143")).toMatchObject({
      created: 3, createdVolume: 22_000_000n, cancelled: 1, cancelledVolume: 10_000_000n, refunded: 1, refundedVolume: 5_000_000n,
      claimed: 0, activeCount: 1, activeLiability: 7_000_000n,
    });
    // history queries the web will run
    expect((await indexer.Payment.getWhere({ sender: { _eq: SENDER } })).length).toBe(3);
    expect((await indexer.Payment.getWhere({ status: { _eq: "ACTIVE" } })).map((p) => p.id)).toEqual([id(3)]);
  });

  it("refuses impossible history instead of recording it", async () => {
    await expect(createTestIndexer().process({ chains: { 143: { simulate: [claimed(9, 1n, 10)] } } })).rejects.toThrow(/unknown payment/);
    await expect(
      createTestIndexer().process({ chains: { 143: { simulate: [created(1, 1n, 10), claimed(1, 1n, 11), cancelled(1, 1n, 12)] } } }),
    ).rejects.toThrow(/in status CLAIMED/);
    await expect(
      createTestIndexer().process({ chains: { 143: { simulate: [created(1, 5n, 10), claimed(1, 4n, 11)] } } }),
    ).rejects.toThrow(/amount 4 != created 5/);
    const wrongSender = { ...cancelled(1, 5n, 11), params: { paymentId: id(1), sender: ANYONE, amount: 5n } };
    await expect(createTestIndexer().process({ chains: { 143: { simulate: [created(1, 5n, 10), wrongSender] } } })).rejects.toThrow(/sender .* != creator/);
  });
});
