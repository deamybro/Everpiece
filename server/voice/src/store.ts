import { DatabaseSync } from "node:sqlite";

/** Ciphertext envelopes only (master §24.3): never plaintext audio, text or keys. */
export type StoredMessage = { locator: string; envelope: Uint8Array; size: number; created_at: number };

export class VoiceStore {
  readonly db: DatabaseSync;
  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS messages (locator TEXT PRIMARY KEY CHECK (locator = lower(locator)), envelope BLOB NOT NULL,
        size INTEGER NOT NULL, created_at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS messages_created ON messages(created_at);
    `);
  }

  get(locator: string): StoredMessage | undefined {
    return this.db.prepare(`SELECT * FROM messages WHERE locator = ?`).get(locator) as StoredMessage | undefined;
  }
  insert(m: StoredMessage): void {
    this.db.prepare(`INSERT INTO messages (locator, envelope, size, created_at) VALUES (?, ?, ?, ?)`).run(m.locator, m.envelope, m.size, m.created_at);
  }
  totalBytes(): number {
    return (this.db.prepare(`SELECT COALESCE(SUM(size), 0) AS s FROM messages`).get() as { s: number }).s;
  }
  count(): number {
    return (this.db.prepare(`SELECT COUNT(*) AS c FROM messages`).get() as { c: number }).c;
  }
  /** Lifecycle deletion (master §24.6). */
  deleteOlderThan(ts: number): number {
    return Number(this.db.prepare(`DELETE FROM messages WHERE created_at < ?`).run(ts).changes);
  }
  close(): void {
    this.db.close();
  }
}
