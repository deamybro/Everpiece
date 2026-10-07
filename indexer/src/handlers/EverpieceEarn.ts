import { indexer } from "envio";

// EverpieceEarn (docs/EARN.md): one row per deposit/withdrawal. Ids are EIP-712 digests the contract settles once.
indexer.onEvent({ contract: "EverpieceEarn", event: "EarnDeposited" }, async ({ event, context }) => {
  const p = event.params;
  if (await context.EarnEvent.get(p.id)) throw new Error(`EarnDeposited twice for ${p.id}`); // the contract forbids it
  context.EarnEvent.set({
    id: p.id, kind: "DEPOSIT", ref: p.ref, owner: p.owner, vault: p.vault, assets: p.assets, shares: p.shares,
    block: event.block.number, timestamp: event.block.timestamp, txHash: event.transaction.hash,
  });
});

indexer.onEvent({ contract: "EverpieceEarn", event: "EarnWithdrawn" }, async ({ event, context }) => {
  const p = event.params;
  if (await context.EarnEvent.get(p.id)) throw new Error(`EarnWithdrawn twice for ${p.id}`);
  context.EarnEvent.set({
    id: p.id, kind: "WITHDRAW", ref: p.ref, owner: p.owner, vault: p.vault, assets: p.assets, shares: p.shares,
    block: event.block.number, timestamp: event.block.timestamp, txHash: event.transaction.hash,
  });
});
