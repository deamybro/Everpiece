import { DatabaseSync } from "node:sqlite";

export type User = {
  username: string;
  /** usernameSkeleton(username): UNIQUE, so lookalike names can't belong to two people. */
  skeleton: string;
  account: string;
  display_name: string;
  inbox_key_hash: string;
  deadline: string;
  sig: string;
  created_at: number;
};
/** message_wrap: the payment's message secret sealed to the recipient's message key (HPKE), or null. Opaque here. */
/** A signed payment request ("Pay @maris $25"): the recipient's EIP-712 PaymentRequest + signature, as strings. */
export type RequestRow = {
  request_id: string; recipient: string; asset: string; amount: string; mode: number; expires_at: string; memo_hash: string;
  sig: string; created_at: number; paid_payment_id: string | null; paid_kind: string | null; paid_at: number | null;
};
export type InboxItem = { payment_id: string; recipient: string; recipient_salt: string; message_wrap: string | null; created_at: number };
/** An account's X25519 message key, signed by the account (MessageKeyRegistration). */
export type MessageKey = { account: string; message_key: string; deadline: string; sig: string; created_at: number };

export class DirectoryStore {
  readonly db: DatabaseSync;
  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS users (username TEXT PRIMARY KEY CHECK (username = lower(username)), skeleton TEXT NOT NULL UNIQUE,
        account TEXT NOT NULL UNIQUE, display_name TEXT NOT NULL, inbox_key_hash TEXT NOT NULL, deadline TEXT NOT NULL,
        sig TEXT NOT NULL, created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS inbox (payment_id TEXT PRIMARY KEY, recipient TEXT NOT NULL, recipient_salt TEXT NOT NULL,
        created_at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS inbox_recipient ON inbox(recipient, created_at);
      CREATE TABLE IF NOT EXISTS message_keys (account TEXT PRIMARY KEY, message_key TEXT NOT NULL, deadline TEXT NOT NULL, sig TEXT NOT NULL,
        created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS requests (request_id TEXT PRIMARY KEY, recipient TEXT NOT NULL, asset TEXT NOT NULL, amount TEXT NOT NULL,
        mode INTEGER NOT NULL, expires_at TEXT NOT NULL, memo_hash TEXT NOT NULL, sig TEXT NOT NULL, created_at INTEGER NOT NULL,
        paid_payment_id TEXT, paid_kind TEXT, paid_at INTEGER);
      CREATE INDEX IF NOT EXISTS requests_recipient ON requests(recipient, created_at);
      CREATE TABLE IF NOT EXISTS registrations (ip TEXT NOT NULL, ts INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS registrations_ip ON registrations(ip, ts);
    `);
    const cols = (this.db.prepare(`PRAGMA table_info(users)`).all() as { name: string }[]).map((c) => c.name);
    if (!cols.includes("skeleton")) throw new Error("directory db: users table predates the lookalike (skeleton) column; migrate before starting");
    // Additive migration: inbox entries from before messages simply have no wrap.
    const inboxCols = (this.db.prepare(`PRAGMA table_info(inbox)`).all() as { name: string }[]).map((c) => c.name);
    if (!inboxCols.includes("message_wrap")) this.db.exec(`ALTER TABLE inbox ADD COLUMN message_wrap TEXT`);
  }

  byUsername(username: string): User | undefined {
    return this.db.prepare(`SELECT * FROM users WHERE username = ?`).get(username) as User | undefined;
  }
  bySkeleton(skeleton: string): User | undefined {
    return this.db.prepare(`SELECT * FROM users WHERE skeleton = ?`).get(skeleton) as User | undefined;
  }
  byAccount(account: string): User | undefined {
    return this.db.prepare(`SELECT * FROM users WHERE account = ?`).get(account) as User | undefined;
  }
  insertUser(u: User): void {
    this.db
      .prepare(`INSERT INTO users (username, skeleton, account, display_name, inbox_key_hash, deadline, sig, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(u.username, u.skeleton, u.account, u.display_name, u.inbox_key_hash, u.deadline, u.sig, u.created_at);
  }

  registrationsSince(ip: string, since: number): number {
    return (this.db.prepare(`SELECT COUNT(*) AS c FROM registrations WHERE ip = ? AND ts >= ?`).get(ip, since) as { c: number }).c;
  }
  recordRegistration(ip: string, ts: number): void {
    this.db.prepare(`INSERT INTO registrations (ip, ts) VALUES (?, ?)`).run(ip, ts);
  }

  getInbox(paymentId: string): InboxItem | undefined {
    return this.db.prepare(`SELECT * FROM inbox WHERE payment_id = ?`).get(paymentId) as InboxItem | undefined;
  }
  insertInbox(i: InboxItem): void {
    this.db
      .prepare(`INSERT INTO inbox (payment_id, recipient, recipient_salt, message_wrap, created_at) VALUES (?, ?, ?, ?, ?)`)
      .run(i.payment_id, i.recipient, i.recipient_salt, i.message_wrap, i.created_at);
  }
  inboxFor(recipient: string, limit: number): InboxItem[] {
    return this.db.prepare(`SELECT * FROM inbox WHERE recipient = ? ORDER BY created_at DESC LIMIT ?`).all(recipient, limit) as InboxItem[];
  }

  messageKeyOf(account: string): MessageKey | undefined {
    return this.db.prepare(`SELECT * FROM message_keys WHERE account = ?`).get(account) as MessageKey | undefined;
  }
  insertMessageKey(k: MessageKey): void {
    this.db.prepare(`INSERT INTO message_keys (account, message_key, deadline, sig, created_at) VALUES (?, ?, ?, ?, ?)`).run(k.account, k.message_key, k.deadline, k.sig, k.created_at);
  }

  getRequest(id: string): RequestRow | undefined {
    return this.db.prepare(`SELECT * FROM requests WHERE request_id = ?`).get(id) as RequestRow | undefined;
  }
  insertRequest(r: RequestRow): void {
    this.db
      .prepare(`INSERT INTO requests (request_id, recipient, asset, amount, mode, expires_at, memo_hash, sig, created_at, paid_payment_id, paid_kind, paid_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL)`)
      .run(r.request_id, r.recipient, r.asset, r.amount, r.mode, r.expires_at, r.memo_hash, r.sig, r.created_at);
  }
  /** First proof wins; a request is paid once. */
  /** A payment id / delivery tx already used to settle some request (one delivery pays one request). */
  paidBy(paymentId: string): RequestRow | undefined {
    return this.db.prepare(`SELECT * FROM requests WHERE paid_payment_id = ?`).get(paymentId.toLowerCase()) as RequestRow | undefined;
  }
  markRequestPaid(id: string, paymentId: string, kind: string, at: number): boolean {
    return Number(this.db.prepare(`UPDATE requests SET paid_payment_id = ?, paid_kind = ?, paid_at = ? WHERE request_id = ? AND paid_payment_id IS NULL`).run(paymentId, kind, at, id).changes) === 1;
  }
  requestsFor(recipient: string, limit: number): RequestRow[] {
    return this.db.prepare(`SELECT * FROM requests WHERE recipient = ? ORDER BY created_at DESC LIMIT ?`).all(recipient, limit) as RequestRow[];
  }

  close(): void {
    this.db.close();
  }
}
