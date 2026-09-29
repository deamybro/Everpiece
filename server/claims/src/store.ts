import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";

export type Invite = { payment_id: string; phone_enc: string; phone_mask: string; phone_key: string; sender: string; created_at: number };
export type Session = {
  id: string;
  payment_id: string;
  recipient: string;
  provider_ref: string;
  attempts: number;
  status: "OPEN" | "APPROVED" | "CLOSED";
  created_at: number;
};

export class ClaimsStore {
  readonly db: DatabaseSync;
  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS invites (payment_id TEXT PRIMARY KEY, phone_enc TEXT NOT NULL, phone_mask TEXT NOT NULL,
        phone_key TEXT NOT NULL, sender TEXT NOT NULL, created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, payment_id TEXT NOT NULL, recipient TEXT NOT NULL,
        provider_ref TEXT NOT NULL, attempts INTEGER NOT NULL, status TEXT NOT NULL, created_at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS sessions_payment ON sessions(payment_id, created_at);
      CREATE TABLE IF NOT EXISTS sends (payment_id TEXT NOT NULL, phone_key TEXT NOT NULL, ts INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS sends_payment ON sends(payment_id, ts);
      CREATE INDEX IF NOT EXISTS sends_phone ON sends(phone_key, ts);
      CREATE TABLE IF NOT EXISTS approvals (payment_id TEXT NOT NULL, recipient TEXT NOT NULL, approval_nonce TEXT PRIMARY KEY,
        deadline INTEGER NOT NULL, created_at INTEGER NOT NULL);
    `);
  }

  getInvite(paymentId: string): Invite | undefined {
    return this.db.prepare(`SELECT * FROM invites WHERE payment_id = ?`).get(paymentId) as Invite | undefined;
  }
  insertInvite(i: Invite): void {
    this.db
      .prepare(`INSERT INTO invites (payment_id, phone_enc, phone_mask, phone_key, sender, created_at) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(i.payment_id, i.phone_enc, i.phone_mask, i.phone_key, i.sender, i.created_at);
  }

  sendsForPaymentSince(paymentId: string, since: number): number[] {
    return (this.db.prepare(`SELECT ts FROM sends WHERE payment_id = ? AND ts >= ? ORDER BY ts`).all(paymentId, since) as { ts: number }[]).map((r) => r.ts);
  }
  sendsForPhoneSince(phoneKey: string, since: number): number {
    return (this.db.prepare(`SELECT COUNT(*) AS c FROM sends WHERE phone_key = ? AND ts >= ?`).get(phoneKey, since) as { c: number }).c;
  }
  recordSend(paymentId: string, phoneKey: string, ts: number): void {
    this.db.prepare(`INSERT INTO sends (payment_id, phone_key, ts) VALUES (?, ?, ?)`).run(paymentId, phoneKey, ts);
  }

  openSession(paymentId: string, recipient: string, providerRef: string, now: number): Session {
    this.db.prepare(`UPDATE sessions SET status = 'CLOSED' WHERE payment_id = ? AND status = 'OPEN'`).run(paymentId);
    const id = randomUUID();
    this.db
      .prepare(`INSERT INTO sessions (id, payment_id, recipient, provider_ref, attempts, status, created_at) VALUES (?, ?, ?, ?, 0, 'OPEN', ?)`)
      .run(id, paymentId, recipient, providerRef, now);
    return this.db.prepare(`SELECT * FROM sessions WHERE id = ?`).get(id) as Session;
  }
  latestOpenSession(paymentId: string): Session | undefined {
    return this.db
      .prepare(`SELECT * FROM sessions WHERE payment_id = ? AND status = 'OPEN' ORDER BY created_at DESC LIMIT 1`)
      .get(paymentId) as Session | undefined;
  }
  bumpAttempts(id: string): number {
    this.db.prepare(`UPDATE sessions SET attempts = attempts + 1 WHERE id = ?`).run(id);
    return (this.db.prepare(`SELECT attempts FROM sessions WHERE id = ?`).get(id) as { attempts: number }).attempts;
  }
  setSessionStatus(id: string, status: Session["status"]): void {
    this.db.prepare(`UPDATE sessions SET status = ? WHERE id = ?`).run(status, id);
  }

  recordApproval(paymentId: string, recipient: string, nonce: string, deadline: number, now: number): void {
    this.db
      .prepare(`INSERT INTO approvals (payment_id, recipient, approval_nonce, deadline, created_at) VALUES (?, ?, ?, ?, ?)`)
      .run(paymentId, recipient, nonce, deadline, now);
  }
  approvalsFor(paymentId: string): { recipient: string; approval_nonce: string; deadline: number }[] {
    return this.db.prepare(`SELECT recipient, approval_nonce, deadline FROM approvals WHERE payment_id = ?`).all(paymentId) as never;
  }

  close(): void {
    this.db.close();
  }
}
