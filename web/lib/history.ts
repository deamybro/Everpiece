import { getAddress, type Address, type Hex } from "viem";
import { PaymentMode, PaymentStatus } from "@everpiece/shared";
import { config } from "./config";
import { chainTime, paymentOf } from "./chain";
import { loadSent, type SentPayment } from "./flows";
import { usernameOf } from "./username";
import { loadLocalPayouts } from "./payout";

/**
 * Payment history (master §29, §30). The SOURCE OF TRUTH is the Envio indexer over executed escrow events, queried by
 * the signed-in account's address, so history survives refresh, sign-out/sign-in and a second browser or device.
 * This browser's sent list is only a cache: it adds labels (the phone, email or @username typed when sending) and
 * shows a just-sent payment before the indexer has caught up. Every cached entry is checked on-chain to belong to
 * the current account before it is shown, so a cache can never invent history or leak another account's.
 */

export type HistoryState = "protected" | "expired" | "claimed" | "cancelled" | "refunded" | "paid";
/** mode of an instant payment (EverpiecePay), not an escrow mode */
export const INSTANT = -1;
export type HistoryItem = {
  paymentId: Hex;
  direction: "sent" | "received";
  amount: bigint;
  mode: number;
  state: HistoryState;
  /** Who it was to (sent) or from (received), for display. */
  counterparty: string;
  /** Unix seconds: created for sent payments, claimed for received ones. */
  at: number;
  expiresAt: bigint;
  /** Username payments sent from this browser: inbox delivery still pending (local only). */
  delivery?: SentPayment["delivery"];
  /** The latest on-chain transaction for this payment (settle, else create), for the explorer link. */
  tx?: Hex;
  /** Known on this device and on-chain, not indexed yet. */
  pendingIndex?: boolean;
};
export type History = { items: HistoryItem[]; source: "indexer" | "device" };

type IndexedPayment = {
  id: string;
  sender: string;
  recipient: string | null;
  mode: number;
  amount: string;
  expiresAt: string;
  status: "ACTIVE" | "CLAIMED" | "CANCELLED" | "REFUNDED";
  createdAt: number;
  settledAt: number | null;
  createdTx: string;
  settledTx: string | null;
};

const QUERY = `query History($me: String!, $limit: Int!) {
  sent: Payment(where: { sender: { _eq: $me } }, order_by: { createdBlock: desc }, limit: $limit) { ...P }
  received: Payment(where: { recipient: { _eq: $me } }, order_by: { settledBlock: desc }, limit: $limit) { ...P }
  isent: InstantPayment(where: { sender: { _eq: $me } }, order_by: { block: desc }, limit: $limit) { ...I }
  ireceived: InstantPayment(where: { recipient: { _eq: $me } }, order_by: { block: desc }, limit: $limit) { ...I }
}
fragment I on InstantPayment { id ref sender recipient amount sourceToken pair timestamp txHash }
fragment P on Payment { id sender recipient mode amount expiresAt status createdAt settledAt createdTx settledTx }`;

const LIMIT = 100;
const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

const names = new Map<string, Promise<string | null>>();
/** Verified @username for an address (directory record signed by that account), cached per page load. */
function nameOf(address: string): Promise<string | null> {
  const key = address.toLowerCase();
  if (!names.has(key)) names.set(key, usernameOf(getAddress(address) as Address).catch(() => null));
  return names.get(key)!;
}

function stateOf(status: IndexedPayment["status"] | number, expiresAt: bigint, now: bigint): HistoryState {
  if (status === "CLAIMED" || status === PaymentStatus.CLAIMED) return "claimed";
  if (status === "CANCELLED" || status === PaymentStatus.CANCELLED) return "cancelled";
  if (status === "REFUNDED" || status === PaymentStatus.REFUNDED) return "refunded";
  return now >= expiresAt ? "expired" : "protected";
}

type IndexedInstant = { id: string; ref: string; sender: string; recipient: string; amount: string; sourceToken: string; pair: string; timestamp: number; txHash: string };
type Indexed = { sent: IndexedPayment[]; received: IndexedPayment[]; isent?: IndexedInstant[]; ireceived?: IndexedInstant[] };

async function fromIndexer(me: Address): Promise<Indexed> {
  const r = await fetch(config.indexerUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query: QUERY, variables: { me, limit: LIMIT } }),
  });
  if (!r.ok) throw new Error(`indexer HTTP ${r.status}`);
  const j = (await r.json()) as { data?: Indexed; errors?: unknown };
  if (!j.data) throw new Error("indexer: no data");
  return j.data;
}

/** Cached entries that are really this account's payments on-chain (the cache is not scoped per account). */
async function verifiedLocal(me: Address, skip: Set<string>, now: bigint): Promise<HistoryItem[]> {
  const local = loadSent().filter((s) => !skip.has(s.paymentId.toLowerCase()) && (!s.sender || getAddress(s.sender) === me));
  const checked = await Promise.all(
    local.map(async (s) => {
      const p = await paymentOf(s.paymentId).catch(() => null);
      if (!p || Number(p.status) === PaymentStatus.NONE || getAddress(p.sender) !== me) return null;
      const item: HistoryItem = {
        paymentId: s.paymentId,
        direction: "sent",
        amount: p.amount,
        mode: Number(p.mode),
        state: stateOf(Number(p.status), p.expiresAt, now),
        counterparty: s.to,
        at: Math.floor(s.createdAt / 1000),
        expiresAt: p.expiresAt,
        delivery: s.delivery,
        pendingIndex: true,
      };
      return item;
    }),
  );
  return checked.filter((x): x is HistoryItem => x !== null);
}

export async function loadHistory(account: { address: Address }): Promise<History> {
  const me = getAddress(account.address);
  const now = await chainTime().catch(() => BigInt(Math.floor(Date.now() / 1000)));
  const cache = new Map(loadSent().map((s) => [s.paymentId.toLowerCase(), s]));

  if (!config.indexerUrl) return { items: sortItems(await verifiedLocal(me, new Set(), now)), source: "device" };
  let indexed: Indexed;
  try {
    indexed = await fromIndexer(me);
  } catch {
    // History service unreachable: show what this device can prove on-chain, and say so in the UI.
    return { items: sortItems(await verifiedLocal(me, new Set(), now)), source: "device" };
  }

  const sent = await Promise.all(
    indexed.sent.map(async (p): Promise<HistoryItem> => {
      const cached = cache.get(p.id.toLowerCase());
      const expiresAt = BigInt(p.expiresAt);
      // Label: what was typed on this device; else the claimer's verified @username; else what kind of payment it is.
      let counterparty = cached?.to;
      if (!counterparty && p.recipient) {
        const n = await nameOf(p.recipient);
        counterparty = n ? `@${n}` : short(p.recipient);
      }
      if (!counterparty) counterparty = Number(p.mode) === PaymentMode.USERNAME ? "an Everpiece user" : "a payment link";
      return {
        paymentId: p.id as Hex,
        direction: "sent",
        amount: BigInt(p.amount),
        mode: Number(p.mode),
        state: stateOf(p.status, expiresAt, now),
        counterparty,
        at: p.createdAt,
        expiresAt,
        tx: (p.settledTx ?? p.createdTx) as Hex,
        delivery: cached?.delivery,
      };
    }),
  );
  const received = await Promise.all(
    indexed.received.map(async (p): Promise<HistoryItem> => {
      const n = await nameOf(p.sender);
      return {
        paymentId: p.id as Hex,
        direction: "received",
        amount: BigInt(p.amount),
        mode: Number(p.mode),
        state: "claimed",
        counterparty: n ? `@${n}` : short(p.sender),
        at: p.settledAt ?? p.createdAt,
        expiresAt: BigInt(p.expiresAt),
        tx: (p.settledTx ?? p.createdTx) as Hex,
      };
    }),
  );
  // Instant payments (EverpiecePay): final at once. A conversion to yourself (adding money) shows once; a payment to a
  // bank payout's deposit address is labelled with the bank (this device's payout records, matched by request ref).
  const payouts = new Map(loadLocalPayouts().filter((x) => x.requestId).map((x) => [x.requestId!.toLowerCase(), x]));
  const instantSent = await Promise.all(
    (indexed.isent ?? []).map(async (p): Promise<HistoryItem> => {
      const self = getAddress(p.recipient) === me;
      const bank = payouts.get(p.ref.toLowerCase());
      const n = self || bank ? null : await nameOf(p.recipient);
      return {
        paymentId: p.id as Hex, direction: "sent", amount: BigInt(p.amount), mode: INSTANT, state: "paid",
        counterparty: self ? "yourself (converted to Dollars)" : bank ? `${bank.to} (bank)` : n ? `@${n}` : short(p.recipient),
        at: p.timestamp, expiresAt: 0n, tx: p.txHash as Hex,
      };
    }),
  );
  const instantReceived = await Promise.all(
    (indexed.ireceived ?? [])
      .filter((p) => getAddress(p.sender) !== me) // a conversion to yourself is already listed once
      .map(async (p): Promise<HistoryItem> => {
        const n = await nameOf(p.sender);
        return {
          paymentId: p.id as Hex, direction: "received", amount: BigInt(p.amount), mode: INSTANT, state: "paid",
          counterparty: n ? `@${n}` : short(p.sender), at: p.timestamp, expiresAt: 0n, tx: p.txHash as Hex,
        };
      }),
  );
  const seen = new Set([...sent, ...received].map((i) => i.paymentId.toLowerCase()));
  const pending = await verifiedLocal(me, seen, now);
  return { items: sortItems([...pending, ...sent, ...received, ...instantSent, ...instantReceived]), source: "indexer" };
}

function sortItems(items: HistoryItem[]): HistoryItem[] {
  return items.sort((a, b) => b.at - a.at);
}
