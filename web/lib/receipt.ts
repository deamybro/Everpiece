import { getAddress, type Address, type Hex } from "viem";
import { PaymentMode, PaymentStatus, everpiecePayAbi } from "@everpiece/shared";
import { config } from "./config";
import { chainTime, client, paymentOf } from "./chain";
import { loadSent } from "./flows";
import { usernameOf } from "./username";

/**
 * A payment receipt, rebuilt from public data only: the indexer's timeline (each step with its transaction) and the
 * escrow's own state read from the chain, which wins if the two disagree (the indexer can lag a few seconds).
 * Nothing private goes in: before a claim the recipient is only a commitment on-chain, so the receipt says so. The
 * phone/email/@username the SENDER typed is shown only on the sender's own device (from its local cache).
 */

export type ReceiptStep = { kind: "CREATED" | "CLAIMED" | "CANCELLED" | "REFUNDED" | "PAID"; at: number; tx: Hex; actor: Address };
export type ReceiptState = "protected" | "expired" | "claimed" | "cancelled" | "refunded" | "paid";
/** mode for an instant payment (EverpiecePay): not an escrow mode. */
export const INSTANT_MODE = -1;
export type Receipt = {
  paymentId: Hex;
  amount: bigint;
  mode: number;
  state: ReceiptState;
  sender: Address;
  senderName: string | null;
  /** The account that claimed it (null until claimed). */
  recipient: Address | null;
  recipientName: string | null;
  /** What the sender typed, only when the viewer is the sender on the device that sent it. */
  senderLabel: string | null;
  expiresAt: bigint;
  steps: ReceiptStep[];
  /** True if the chain already shows a step the indexer hasn't caught up with yet. */
  pending: boolean;
  /** Instant payments: what the payer paid in (AUSD, or a token converted by Agora). */
  instant?: { sourceToken: Address; sourceAmount: bigint; viaAgora: boolean };
};

type Indexed = {
  i?: { id: string; sender: string; recipient: string; amount: string; sourceToken: string; sourceAmount: string; pair: string; timestamp: number; txHash: string }[];
  p: { id: string; sender: string; recipient: string | null; mode: number; amount: string; expiresAt: string; status: string }[];
  e: { kind: ReceiptStep["kind"]; actor: string; timestamp: number; txHash: string }[];
};

const QUERY = `query Receipt($id: String!) {
  p: Payment(where: { id: { _eq: $id } }) { id sender recipient mode amount expiresAt status }
  e: PaymentEvent(where: { payment_id: { _eq: $id } }, order_by: [{ blockNumber: asc }, { logIndex: asc }]) { kind actor timestamp txHash }
  i: InstantPayment(where: { id: { _eq: $id } }) { id sender recipient amount sourceToken sourceAmount pair timestamp txHash }
}`;

const STATUS: Record<number, ReceiptState> = {
  [PaymentStatus.CLAIMED]: "claimed",
  [PaymentStatus.CANCELLED]: "cancelled",
  [PaymentStatus.REFUNDED]: "refunded",
};

/** null: no such payment (or not on-chain yet). Throws only if neither the indexer nor the chain can be reached. */
/** `viewer` is the signed-in account on this device; its own @username needs no directory lookup. */
export async function loadReceipt(paymentId: Hex, viewer?: { address: Address; username?: string }): Promise<Receipt | null> {
  const id = paymentId.toLowerCase() as Hex;
  const [indexed, onchain, now] = await Promise.all([
    config.indexerUrl
      ? fetch(config.indexerUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ query: QUERY, variables: { id } }) })
          .then((r) => (r.ok ? r.json() : null))
          .then((j: { data?: Indexed } | null) => j?.data ?? null)
          .catch(() => null)
      : Promise.resolve(null),
    paymentOf(id),
    chainTime().catch(() => BigInt(Math.floor(Date.now() / 1000))),
  ]);
  if (Number(onchain.status) === PaymentStatus.NONE) return instantReceipt(id, indexed?.i?.[0], viewer);

  const status = Number(onchain.status);
  const state: ReceiptState = STATUS[status] ?? (now >= onchain.expiresAt ? "expired" : "protected");
  const steps: ReceiptStep[] = (indexed?.e ?? []).map((e) => ({ kind: e.kind, at: e.timestamp, tx: e.txHash as Hex, actor: getAddress(e.actor) }));
  const settled = steps.some((s) => s.kind !== "CREATED");
  const pending = steps.length === 0 || (status !== PaymentStatus.ACTIVE && !settled);
  const recipientRaw = indexed?.p[0]?.recipient ?? null;
  const recipient = recipientRaw ? getAddress(recipientRaw) : null;
  const sender = getAddress(onchain.sender);
  const own = (a: Address) => (viewer?.username && getAddress(viewer.address) === a ? viewer.username : null);
  const nameOf = (a: Address) => own(a) ?? usernameOf(a).catch(() => null);
  const [senderName, recipientName] = await Promise.all([nameOf(sender), recipient ? nameOf(recipient) : Promise.resolve(null)]);
  const mine = viewer && getAddress(viewer.address) === sender ? loadSent().find((s) => s.paymentId.toLowerCase() === id) : undefined;
  return {
    paymentId: id,
    amount: onchain.amount,
    mode: Number(onchain.mode),
    state,
    sender,
    senderName,
    recipient,
    recipientName,
    senderLabel: mine?.to ?? null,
    expiresAt: onchain.expiresAt,
    steps,
    pending,
  };
}

/** An instant payment (EverpiecePay): shown only if the contract itself says it settled. */
async function instantReceipt(id: Hex, i: NonNullable<Indexed["i"]>[number] | undefined, viewer?: { address: Address; username?: string }): Promise<Receipt | null> {
  if (!i || !config.pay) return null;
  const settled = await client.readContract({ address: config.pay, abi: everpiecePayAbi, functionName: "settled", args: [id] }).catch(() => false);
  if (!settled) return null;
  const sender = getAddress(i.sender);
  const recipient = getAddress(i.recipient);
  const own = (a: Address) => (viewer?.username && getAddress(viewer.address) === a ? viewer.username : null);
  const nameOf = (a: Address) => own(a) ?? usernameOf(a).catch(() => null);
  const [senderName, recipientName] = await Promise.all([nameOf(sender), nameOf(recipient)]);
  return {
    paymentId: id, amount: BigInt(i.amount), mode: INSTANT_MODE, state: "paid", sender, senderName, recipient, recipientName, senderLabel: null,
    expiresAt: 0n, steps: [{ kind: "PAID", at: i.timestamp, tx: i.txHash as Hex, actor: sender }], pending: false,
    instant: { sourceToken: getAddress(i.sourceToken), sourceAmount: BigInt(i.sourceAmount), viaAgora: !/^0x0{40}$/i.test(i.pair) },
  };
}

export const kindLabel = (mode: number) => (mode === INSTANT_MODE ? "Instant payment" : mode === PaymentMode.USERNAME ? "To an @username" : "By link with a code");
export const receiptPath = (paymentId: Hex) => `/r/${paymentId.toLowerCase()}`;
