import { indexer, type EvmOnEventContext } from "envio";

// History and metrics from EXECUTED escrow events only (reverted transactions emit nothing; ESCROW_SPEC §441).
// The escrow allows exactly one transition, ACTIVE → CLAIMED | CANCELLED | REFUNDED. Anything else means a
// misconfigured start block or a bug, so the handlers fail loudly instead of writing wrong history.

type Kind = "CREATED" | "CLAIMED" | "CANCELLED" | "REFUNDED";

const eventId = (chainId: number, block: number, logIndex: number) => `${chainId}_${block}_${logIndex}`;

const emptyStats = (id: string) => ({
  id,
  created: 0,
  createdVolume: 0n,
  claimed: 0,
  claimedVolume: 0n,
  cancelled: 0,
  cancelledVolume: 0n,
  refunded: 0,
  refundedVolume: 0n,
  activeCount: 0,
  activeLiability: 0n,
  users: 0,
  instantCount: 0,
  instantVolume: 0n,
});

type Stats = ReturnType<typeof emptyStats>;

/** Counts an address the first time it sends or claims. */
async function withUser(s: Stats, address: string, event: { block: { number: number; timestamp: number } }, context: EvmOnEventContext): Promise<Stats> {
  if (await context.Account.get(address)) return s;
  context.Account.set({ id: address, firstSeenAt: event.block.timestamp, firstSeenBlock: event.block.number });
  return { ...s, users: s.users + 1 };
}

indexer.onEvent({ contract: "EverpieceEscrow", event: "PaymentCreated" }, async ({ event, context }) => {
  const p = event.params;
  if (await context.Payment.get(p.paymentId)) throw new Error(`PaymentCreated twice for ${p.paymentId}`);
  context.Payment.set({
    id: p.paymentId,
    sender: p.sender,
    mode: Number(p.mode),
    recipientCommitment: p.recipientCommitment,
    amount: p.amount,
    expiresAt: p.expiresAt,
    status: "ACTIVE",
    recipient: undefined,
    createdAt: event.block.timestamp,
    createdBlock: event.block.number,
    createdTx: event.transaction.hash,
    settledAt: undefined,
    settledBlock: undefined,
    settledTx: undefined,
    refundCaller: undefined,
  });
  context.PaymentEvent.set({
    id: eventId(event.chainId, event.block.number, event.logIndex),
    payment_id: p.paymentId,
    kind: "CREATED",
    actor: p.sender,
    amount: p.amount,
    blockNumber: event.block.number,
    timestamp: event.block.timestamp,
    txHash: event.transaction.hash,
    logIndex: event.logIndex,
  });
  const s = await withUser(await context.Stats.getOrCreate(emptyStats(String(event.chainId))), p.sender, event, context);
  context.Stats.set({
    ...s,
    created: s.created + 1,
    createdVolume: s.createdVolume + p.amount,
    activeCount: s.activeCount + 1,
    activeLiability: s.activeLiability + p.amount,
  });
});

/** Shared by the three terminal events. */
async function settle(
  kind: Exclude<Kind, "CREATED">,
  args: { paymentId: string; actor: string; amount: bigint; sender?: string; recipient?: string; refundCaller?: string },
  event: { chainId: number; logIndex: number; block: { number: number; timestamp: number }; transaction: { hash: string } },
  context: EvmOnEventContext,
) {
  const payment = await context.Payment.getOrThrow(args.paymentId, `${kind} for unknown payment ${args.paymentId} (start_block after its creation?)`);
  if (payment.status !== "ACTIVE") throw new Error(`${kind} for ${args.paymentId} in status ${payment.status}`);
  if (payment.amount !== args.amount) throw new Error(`${kind} amount ${args.amount} != created ${payment.amount} for ${args.paymentId}`);
  if (args.sender !== undefined && args.sender !== payment.sender) throw new Error(`${kind} sender ${args.sender} != creator ${payment.sender}`);
  context.Payment.set({
    ...payment,
    status: kind,
    recipient: args.recipient ?? payment.recipient,
    refundCaller: args.refundCaller ?? payment.refundCaller,
    settledAt: event.block.timestamp,
    settledBlock: event.block.number,
    settledTx: event.transaction.hash,
  });
  context.PaymentEvent.set({
    id: eventId(event.chainId, event.block.number, event.logIndex),
    payment_id: args.paymentId,
    kind,
    actor: args.actor,
    amount: args.amount,
    blockNumber: event.block.number,
    timestamp: event.block.timestamp,
    txHash: event.transaction.hash,
    logIndex: event.logIndex,
  });
  const before = await context.Stats.getOrThrow(String(event.chainId));
  const s = kind === "CLAIMED" ? await withUser(before, args.actor, event, context) : before;
  const next = { ...s, activeCount: s.activeCount - 1, activeLiability: s.activeLiability - args.amount };
  if (kind === "CLAIMED") context.Stats.set({ ...next, claimed: s.claimed + 1, claimedVolume: s.claimedVolume + args.amount });
  if (kind === "CANCELLED") context.Stats.set({ ...next, cancelled: s.cancelled + 1, cancelledVolume: s.cancelledVolume + args.amount });
  if (kind === "REFUNDED") context.Stats.set({ ...next, refunded: s.refunded + 1, refundedVolume: s.refundedVolume + args.amount });
}

indexer.onEvent({ contract: "EverpieceEscrow", event: "PaymentClaimed" }, async ({ event, context }) => {
  const p = event.params;
  await settle("CLAIMED", { paymentId: p.paymentId, actor: p.recipient, amount: p.amount, recipient: p.recipient }, event, context);
});

indexer.onEvent({ contract: "EverpieceEscrow", event: "PaymentCancelled" }, async ({ event, context }) => {
  const p = event.params;
  await settle("CANCELLED", { paymentId: p.paymentId, actor: p.sender, amount: p.amount, sender: p.sender }, event, context);
});

indexer.onEvent({ contract: "EverpieceEscrow", event: "PaymentRefunded" }, async ({ event, context }) => {
  const p = event.params;
  await settle("REFUNDED", { paymentId: p.paymentId, actor: p.sender, amount: p.amount, sender: p.sender, refundCaller: p.caller }, event, context);
});

indexer.onEvent({ contract: "EverpiecePay", event: "Paid" }, async ({ event, context }) => {
  const p = event.params;
  if (await context.InstantPayment.get(p.paymentId)) throw new Error(`Paid twice for ${p.paymentId}`); // the contract forbids it
  context.InstantPayment.set({
    id: p.paymentId,
    ref: p.ref,
    sender: p.sender,
    recipient: p.recipient,
    amount: p.amount,
    sourceToken: p.sourceToken,
    sourceAmount: p.sourceAmount,
    pair: p.pair,
    block: event.block.number,
    timestamp: event.block.timestamp,
    txHash: event.transaction.hash,
  });
  let s = await withUser(await context.Stats.getOrCreate(emptyStats(String(event.chainId))), p.sender, event, context);
  s = await withUser(s, p.recipient, event, context);
  context.Stats.set({ ...s, instantCount: s.instantCount + 1, instantVolume: s.instantVolume + p.amount });
});
