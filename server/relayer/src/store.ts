import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import type { Method } from "./config.ts";

/**
 * Relayer request lifecycle (ESCROW_SPEC §17, D9 — inclusion is not success):
 *   SUBMITTED  accepted, validated, simulated; queued for broadcast
 *   PROCESSING broadcast (tx hash known); waiting for execution + finality
 *   CONFIRMED  receipt status 1, expected escrow event, getPayment@finalized matches, block <= finalized
 *   FAILED     broadcast error, on-chain revert, or expected event missing — chain state is canonical
 *   REJECTED   refused before broadcast (simulation revert, budget, balance); no gas spent
 */
export type Status = "SUBMITTED" | "PROCESSING" | "CONFIRMED" | "FAILED" | "REJECTED";

export type RequestRow = {
  id: string;
  idem_key: string;
  method: Method;
  signer: string | null;
  payment_id: string;
  calldata: string;
  gas_limit: string;
  status: Status;
  tx_hash: string | null;
  nonce: number | null;
  raw_tx: string | null;
  error: string | null;
  included_block: string | null;
  gas_used: string | null;
  chain_status: number | null;
  ip: string | null;
  created_at: number;
  updated_at: number;
  submitted_at: number | null;
};

export class Store {
  readonly db: DatabaseSync;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS requests (
        id TEXT PRIMARY KEY, idem_key TEXT NOT NULL, method TEXT NOT NULL, signer TEXT, payment_id TEXT NOT NULL,
        calldata TEXT NOT NULL, gas_limit TEXT NOT NULL, status TEXT NOT NULL, tx_hash TEXT, nonce INTEGER,
        raw_tx TEXT, error TEXT, included_block TEXT, gas_used TEXT, chain_status INTEGER, ip TEXT,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, submitted_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS requests_idem ON requests(idem_key);
      CREATE INDEX IF NOT EXISTS requests_status ON requests(status);
      CREATE INDEX IF NOT EXISTS requests_signer ON requests(signer, created_at);
      CREATE TABLE IF NOT EXISTS gas_budget (day TEXT PRIMARY KEY, used TEXT NOT NULL);
    `);
  }

  /** Live (non-rejected, non-failed) request for this idempotency key, if any. */
  findLive(idemKey: string): RequestRow | undefined {
    return this.db
      .prepare(`SELECT * FROM requests WHERE idem_key = ? AND status IN ('SUBMITTED','PROCESSING','CONFIRMED') ORDER BY created_at DESC LIMIT 1`)
      .get(idemKey) as RequestRow | undefined;
  }

  insert(r: Pick<RequestRow, "idem_key" | "method" | "signer" | "payment_id" | "calldata" | "gas_limit" | "ip">): RequestRow {
    const now = Date.now();
    const id = randomUUID();
    this.db
      .prepare(
        `INSERT INTO requests (id, idem_key, method, signer, payment_id, calldata, gas_limit, status, ip, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'SUBMITTED', ?, ?, ?)`,
      )
      .run(id, r.idem_key, r.method, r.signer, r.payment_id, r.calldata, r.gas_limit, r.ip, now, now);
    return this.get(id)!;
  }

  get(id: string): RequestRow | undefined {
    return this.db.prepare(`SELECT * FROM requests WHERE id = ?`).get(id) as RequestRow | undefined;
  }

  update(id: string, fields: Partial<Omit<RequestRow, "id">>): void {
    const keys = Object.keys(fields);
    if (keys.length === 0) return;
    const set = keys.map((k) => `${k} = ?`).join(", ");
    const values = keys.map((k) => (fields as Record<string, unknown>)[k]) as (string | number | null)[];
    this.db.prepare(`UPDATE requests SET ${set}, updated_at = ? WHERE id = ?`).run(...values, Date.now(), id);
  }

  byStatus(status: Status): RequestRow[] {
    return this.db.prepare(`SELECT * FROM requests WHERE status = ? ORDER BY created_at`).all(status) as RequestRow[];
  }

  maxNonce(): number | null {
    const r = this.db.prepare(`SELECT MAX(nonce) AS n FROM requests WHERE nonce IS NOT NULL`).get() as { n: number | null };
    return r.n;
  }

  countSignerSince(signer: string, since: number): number {
    const r = this.db
      .prepare(`SELECT COUNT(*) AS c FROM requests WHERE signer = ? AND created_at >= ? AND status != 'REJECTED'`)
      .get(signer, since) as { c: number };
    return r.c;
  }

  /** Atomically reserve `gas` from today's budget; false if it would exceed `budget`. */
  reserveGas(day: string, gas: bigint, budget: bigint): boolean {
    const row = this.db.prepare(`SELECT used FROM gas_budget WHERE day = ?`).get(day) as { used: string } | undefined;
    const used = row ? BigInt(row.used) : 0n;
    if (used + gas > budget) return false;
    this.db
      .prepare(`INSERT INTO gas_budget (day, used) VALUES (?, ?) ON CONFLICT(day) DO UPDATE SET used = excluded.used`)
      .run(day, (used + gas).toString());
    return true;
  }

  releaseGas(day: string, gas: bigint): void {
    const row = this.db.prepare(`SELECT used FROM gas_budget WHERE day = ?`).get(day) as { used: string } | undefined;
    if (!row) return;
    const left = BigInt(row.used) - gas;
    this.db.prepare(`UPDATE gas_budget SET used = ? WHERE day = ?`).run((left < 0n ? 0n : left).toString(), day);
  }

  close(): void {
    this.db.close();
  }
}
