import { DatabaseSync } from "node:sqlite";

/**
 * Ciphertext envelopes only (master §24.3): never plaintext audio, text or keys.
 * payment_id is set once the message has been shown to belong to that payment on-chain (bind); delete_after is when
 * lifecycle deletion removes it (short for unbound uploads, after the payment's expiry for bound ones).
 */
export type StoredMessage = { locator: string; envelope: Uint8Array; size: number; created_at: number; payment_id: string | null; delete_after: number };

export class VoiceStore {
  readonly db: DatabaseSync;
  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS messages (locator TEXT PRIMARY KEY CHECK (locator = lower(locator)), envelope BLOB NOT NULL,
        size INTEGER NOT NULL, created_at INTEGER NOT NULL);
    `);
    // Encrypted address-book vaults: one latest ciphertext per account, replaced only by a higher sequence number.
    this.db.exec(`CREATE TABLE IF NOT EXISTS vaults (account TEXT PRIMARY KEY CHECK (account = lower(account)), vault TEXT NOT NULL,
      seq INTEGER NOT NULL, updated_at INTEGER NOT NULL)`);
    // Additive migration: messages stored before binding existed keep the old 45-day lifetime.
    const cols = (this.db.prepare(`PRAGMA table_info(messages)`).all() as { name: string }[]).map((c) => c.name);
    if (!cols.includes("payment_id")) this.db.exec(`ALTER TABLE messages ADD COLUMN payment_id TEXT`);
    if (!cols.includes("delete_after")) {
      this.db.exec(`ALTER TABLE messages ADD COLUMN delete_after INTEGER`);
      this.db.exec(`UPDATE messages SET delete_after = created_at + ${45 * 86_400_000} WHERE delete_after IS NULL`);
    }
    this.db.exec(`CREATE INDEX IF NOT EXISTS messages_delete_after ON messages(delete_after)`);
  }

  get(locator: string): StoredMessage | undefined {
    return this.db.prepare(`SELECT * FROM messages WHERE locator = ?`).get(locator) as StoredMessage | undefined;
  }
  insert(m: StoredMessage): void {
    this.db
      .prepare(`INSERT INTO messages (locator, envelope, size, created_at, payment_id, delete_after) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(m.locator, m.envelope, m.size, m.created_at, m.payment_id, m.delete_after);
  }
  bind(locator: string, paymentId: string, deleteAfter: number): void {
    this.db.prepare(`UPDATE messages SET payment_id = ?, delete_after = ? WHERE locator = ?`).run(paymentId, deleteAfter, locator);
  }
  getVault(account: string): { vault: string; seq: number; updated_at: number } | undefined {
    return this.db.prepare(`SELECT vault, seq, updated_at FROM vaults WHERE account = ?`).get(account) as { vault: string; seq: number; updated_at: number } | undefined;
  }
  putVault(account: string, vault: string, seq: number, now: number): void {
    this.db.prepare(`INSERT INTO vaults (account, vault, seq, updated_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(account) DO UPDATE SET vault = excluded.vault, seq = excluded.seq, updated_at = excluded.updated_at`).run(account, vault, seq, now);
  }
  vaultCount(): number {
    return (this.db.prepare(`SELECT COUNT(*) AS n FROM vaults`).get() as { n: number }).n;
  }
  totalBytes(): number {
    return (this.db.prepare(`SELECT COALESCE(SUM(size), 0) AS s FROM messages`).get() as { s: number }).s;
  }
  counts(): { messages: number; bound: number } {
    return this.db.prepare(`SELECT COUNT(*) AS messages, COUNT(payment_id) AS bound FROM messages`).get() as { messages: number; bound: number };
  }
  /** Lifecycle deletion (master §24.6). */
  deleteExpired(now: number): number {
    return Number(this.db.prepare(`DELETE FROM messages WHERE delete_after < ?`).run(now).changes);
  }
  close(): void {
    this.db.close();
  }
}
