import { DatabaseSync } from "node:sqlite";
import type { PayoutState } from "@everpiece/shared";

/** A bank account being verified, before its owner has signed it (15 minutes). */
export type PendingRow = { prepare_id: string; account: string; institution: string; enc_number: string; salt: string; account_name: string; last4: string; expires_at: number };
/** The owner-signed destination. `enc_number` is AES-GCM ciphertext; `record` is the signed public PayoutAccount (JSON). */
export type AccountRow = { account: string; record: string; sig: string; enc_number: string; salt: string; updated_at: number };
export type RequestRow = { request_id: string; recipient: string; record: string; sig: string; created_at: number; direct?: number };
export type OrderRow = {
  order_id: string; request_id: string; sender: string; receive_address: string; amount_to_transfer: string; currency: string;
  valid_until: string; state: PayoutState; created_at: number; updated_at: number; checked_at: number;
  /** JSON [{state, at}] — every state the order has been in, with the time it was first seen (the UI timeline). */
  history: string;
};

export class PayoutStore {
  readonly db: DatabaseSync;
  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS pending (prepare_id TEXT PRIMARY KEY, account TEXT NOT NULL, institution TEXT NOT NULL, enc_number TEXT NOT NULL,
        salt TEXT NOT NULL, account_name TEXT NOT NULL, last4 TEXT NOT NULL, expires_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS accounts (account TEXT PRIMARY KEY, record TEXT NOT NULL, sig TEXT NOT NULL, enc_number TEXT NOT NULL,
        salt TEXT NOT NULL, updated_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS requests (request_id TEXT PRIMARY KEY, recipient TEXT NOT NULL, record TEXT NOT NULL, sig TEXT NOT NULL, created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS orders (order_id TEXT PRIMARY KEY, request_id TEXT NOT NULL, sender TEXT NOT NULL, receive_address TEXT NOT NULL,
        amount_to_transfer TEXT NOT NULL, currency TEXT NOT NULL, valid_until TEXT NOT NULL, state TEXT NOT NULL,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, checked_at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS orders_request ON orders(request_id);
      CREATE TABLE IF NOT EXISTS verifications (ip TEXT NOT NULL, ts INTEGER NOT NULL);
    `);
    // additive migrations
    const cols = (this.db.prepare(`PRAGMA table_info(orders)`).all() as { name: string }[]).map((c) => c.name);
    if (!cols.includes("history")) this.db.exec(`ALTER TABLE orders ADD COLUMN history TEXT NOT NULL DEFAULT '[]'`);
    const rcols = (this.db.prepare(`PRAGMA table_info(requests)`).all() as { name: string }[]).map((c) => c.name);
    // direct = the SENDER chose the amount, to the recipient's signed destination ("send to their bank" / cash out)
    if (!rcols.includes("direct")) this.db.exec(`ALTER TABLE requests ADD COLUMN direct INTEGER NOT NULL DEFAULT 0`);
  }
  putPending(p: PendingRow) {
    this.db.prepare(`INSERT INTO pending VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(p.prepare_id, p.account, p.institution, p.enc_number, p.salt, p.account_name, p.last4, p.expires_at);
  }
  takePending(id: string, now: number): PendingRow | undefined {
    this.db.prepare(`DELETE FROM pending WHERE expires_at < ?`).run(now);
    const p = this.db.prepare(`SELECT * FROM pending WHERE prepare_id = ?`).get(id) as PendingRow | undefined;
    if (p) this.db.prepare(`DELETE FROM pending WHERE prepare_id = ?`).run(id);
    return p;
  }
  putAccount(a: AccountRow) {
    this.db.prepare(`INSERT OR REPLACE INTO accounts VALUES (?, ?, ?, ?, ?, ?)`).run(a.account, a.record, a.sig, a.enc_number, a.salt, a.updated_at);
  }
  account(account: string) {
    return this.db.prepare(`SELECT * FROM accounts WHERE account = ?`).get(account.toLowerCase()) as AccountRow | undefined;
  }
  putRequest(r: RequestRow) {
    this.db.prepare(`INSERT INTO requests (request_id, recipient, record, sig, created_at, direct) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(r.request_id, r.recipient, r.record, r.sig, r.created_at, r.direct ?? 0);
  }
  request(id: string) {
    return this.db.prepare(`SELECT * FROM requests WHERE request_id = ?`).get(id.toLowerCase()) as RequestRow | undefined;
  }
  putOrder(o: OrderRow) {
    this.db.prepare(`INSERT INTO orders (order_id, request_id, sender, receive_address, amount_to_transfer, currency, valid_until, state, created_at, updated_at, checked_at, history)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(o.order_id, o.request_id, o.sender, o.receive_address, o.amount_to_transfer, o.currency, o.valid_until, o.state, o.created_at, o.updated_at, o.checked_at, o.history);
  }
  order(id: string) {
    return this.db.prepare(`SELECT * FROM orders WHERE order_id = ?`).get(id) as OrderRow | undefined;
  }
  ordersFor(requestId: string) {
    return this.db.prepare(`SELECT * FROM orders WHERE request_id = ? ORDER BY created_at DESC`).all(requestId.toLowerCase()) as OrderRow[];
  }
  setState(id: string, state: PayoutState, now: number) {
    const o = this.order(id);
    const history = JSON.parse(o?.history ?? "[]") as { state: string; at: number }[];
    if (!history.some((h) => h.state === state)) history.push({ state, at: now });
    this.db.prepare(`UPDATE orders SET state = ?, updated_at = ?, checked_at = ?, history = ? WHERE order_id = ?`).run(state, now, now, JSON.stringify(history), id);
  }
  touch(id: string, now: number) {
    this.db.prepare(`UPDATE orders SET checked_at = ? WHERE order_id = ?`).run(now, id);
  }
  recordVerification(ip: string, now: number) {
    this.db.prepare(`INSERT INTO verifications VALUES (?, ?)`).run(ip, now);
  }
  verificationsSince(ip: string, since: number): number {
    return (this.db.prepare(`SELECT COUNT(*) AS n FROM verifications WHERE ip = ? AND ts > ?`).get(ip, since) as { n: number }).n;
  }
  counts() {
    return this.db.prepare(`SELECT (SELECT COUNT(*) FROM accounts) AS accounts, (SELECT COUNT(*) FROM requests) AS requests, (SELECT COUNT(*) FROM orders) AS orders`).get();
  }
  close() {
    this.db.close();
  }
}
