import { DatabaseSync } from "node:sqlite";
import type { ExecutionState, LegStatus } from "@everpiece/shared";

/** The owner-signed rule as received (JSON with bigint as strings) plus its signature. The newest `updated_at` wins. */
export type RuleRow = { rule_id: string; owner: string; record: string; sig: string; enabled: number; updated_at: number; created_at: number };
export type ExecutionRow = {
  execution_id: string; rule_id: string; owner: string; event_id: string; state: ExecutionState; base: string; moving: string;
  kept: string; source: string; day: number; month: string; created_at: number; updated_at: number; expires_at: number;
  /** JSON [{state, at}] */
  history: string;
};
export type LegRow = {
  execution_id: string; leg_index: number; idempotency_key: string; action: string; allocated: string; amount: string;
  left_in_balance: string; status: LegStatus; reason: string | null; tx_hash: string | null; updated_at: number;
};

export class AutomateStore {
  readonly db: DatabaseSync;
  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS rules (rule_id TEXT PRIMARY KEY, owner TEXT NOT NULL, record TEXT NOT NULL, sig TEXT NOT NULL,
        enabled INTEGER NOT NULL, updated_at INTEGER NOT NULL, created_at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS rules_owner ON rules(owner);
      CREATE TABLE IF NOT EXISTS executions (execution_id TEXT PRIMARY KEY, rule_id TEXT NOT NULL, owner TEXT NOT NULL, event_id TEXT NOT NULL,
        state TEXT NOT NULL, base TEXT NOT NULL, moving TEXT NOT NULL, kept TEXT NOT NULL, source TEXT NOT NULL, day INTEGER NOT NULL,
        month TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, history TEXT NOT NULL,
        UNIQUE (rule_id, event_id));
      CREATE INDEX IF NOT EXISTS executions_owner ON executions(owner, created_at);
      -- one row per leg; the idempotency key (ruleId:eventId:actionIndex) is unique across everything ever planned
      CREATE TABLE IF NOT EXISTS legs (execution_id TEXT NOT NULL, leg_index INTEGER NOT NULL, idempotency_key TEXT NOT NULL UNIQUE,
        action TEXT NOT NULL, allocated TEXT NOT NULL, amount TEXT NOT NULL, left_in_balance TEXT NOT NULL, status TEXT NOT NULL,
        reason TEXT, tx_hash TEXT UNIQUE, updated_at INTEGER NOT NULL, PRIMARY KEY (execution_id, leg_index));
    `);
  }
  close() { this.db.close(); }

  getRule(id: string): RuleRow | undefined {
    return this.db.prepare("SELECT * FROM rules WHERE rule_id = ?").get(id.toLowerCase()) as RuleRow | undefined;
  }
  rulesOf(owner: string): RuleRow[] {
    return this.db.prepare("SELECT * FROM rules WHERE owner = ? ORDER BY created_at").all(owner.toLowerCase()) as RuleRow[];
  }
  countRules(owner: string): number {
    return Number((this.db.prepare("SELECT COUNT(*) AS n FROM rules WHERE owner = ?").get(owner.toLowerCase()) as { n: number }).n);
  }
  /** Insert or replace only with a strictly newer version (no replay of an older signed rule, e.g. re-enabling). */
  putRule(r: RuleRow): boolean {
    const res = this.db.prepare(`INSERT INTO rules (rule_id, owner, record, sig, enabled, updated_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(rule_id) DO UPDATE SET record = excluded.record, sig = excluded.sig, enabled = excluded.enabled, updated_at = excluded.updated_at
      WHERE excluded.updated_at > rules.updated_at AND rules.owner = excluded.owner`)
      .run(r.rule_id.toLowerCase(), r.owner.toLowerCase(), r.record, r.sig, r.enabled, r.updated_at, r.created_at);
    return Number(res.changes) > 0;
  }

  /**
   * Record a planned execution and its legs atomically. Returns false (and writes nothing) if this rule already has an
   * execution for this event, or any idempotency key was used before: a duplicate trigger never runs twice.
   */
  insertExecution(e: ExecutionRow, legs: LegRow[]): boolean {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const dup = this.db.prepare("SELECT 1 FROM executions WHERE rule_id = ? AND event_id = ?").get(e.rule_id, e.event_id);
      const keyUsed = legs.some((l) => this.db.prepare("SELECT 1 FROM legs WHERE idempotency_key = ?").get(l.idempotency_key));
      if (dup || keyUsed) {
        this.db.exec("ROLLBACK");
        return false;
      }
      this.db.prepare(`INSERT INTO executions (execution_id, rule_id, owner, event_id, state, base, moving, kept, source, day, month, created_at, updated_at, expires_at, history)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(e.execution_id, e.rule_id, e.owner, e.event_id, e.state, e.base, e.moving, e.kept, e.source, e.day, e.month, e.created_at, e.updated_at, e.expires_at, e.history);
      const ins = this.db.prepare(`INSERT INTO legs (execution_id, leg_index, idempotency_key, action, allocated, amount, left_in_balance, status, reason, tx_hash, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
      for (const l of legs) ins.run(l.execution_id, l.leg_index, l.idempotency_key, l.action, l.allocated, l.amount, l.left_in_balance, l.status, l.reason, l.tx_hash, l.updated_at);
      this.db.exec("COMMIT");
      return true;
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  getExecution(id: string): ExecutionRow | undefined {
    return this.db.prepare("SELECT * FROM executions WHERE execution_id = ?").get(id.toLowerCase()) as ExecutionRow | undefined;
  }
  executionsOf(owner: string, limit = 50): ExecutionRow[] {
    return this.db.prepare("SELECT * FROM executions WHERE owner = ? ORDER BY created_at DESC LIMIT ?").all(owner.toLowerCase(), limit) as ExecutionRow[];
  }
  legsOf(executionId: string): LegRow[] {
    return this.db.prepare("SELECT * FROM legs WHERE execution_id = ? ORDER BY leg_index").all(executionId.toLowerCase()) as LegRow[];
  }
  setLeg(executionId: string, index: number, status: LegStatus, txHash: string | null, reason: string | null, now: number): void {
    this.db.prepare("UPDATE legs SET status = ?, tx_hash = COALESCE(?, tx_hash), reason = COALESCE(?, reason), updated_at = ? WHERE execution_id = ? AND leg_index = ?")
      .run(status, txHash, reason, now, executionId.toLowerCase(), index);
  }
  setExecutionState(id: string, state: ExecutionState, now: number): void {
    const e = this.getExecution(id);
    if (!e) return;
    const history = JSON.parse(e.history) as { state: string; at: number }[];
    if (history.at(-1)?.state !== state) history.push({ state, at: now });
    this.db.prepare("UPDATE executions SET state = ?, updated_at = ?, history = ? WHERE execution_id = ?").run(state, now, JSON.stringify(history), id.toLowerCase());
  }
  /** Open executions past their confirmation window. */
  stale(now: number): ExecutionRow[] {
    return this.db.prepare("SELECT * FROM executions WHERE state IN ('READY', 'EXECUTING') AND expires_at <= ?").all(now) as ExecutionRow[];
  }

  /**
   * What a rule has used toward its limits: every leg that moved or may still move (planned, executing, done). Failed,
   * unavailable and expired legs free their share again.
   */
  used(ruleId: string, day: number, month: string): { today: bigint; month: bigint } {
    const rows = this.db.prepare(`SELECT l.amount, e.day, e.month FROM legs l JOIN executions e ON e.execution_id = l.execution_id
      WHERE e.rule_id = ? AND e.month = ? AND l.status IN ('PENDING', 'LIMITED', 'EXECUTING', 'DONE')`).all(ruleId.toLowerCase(), month) as { amount: string; day: number; month: string }[];
    let today = 0n, m = 0n;
    for (const r of rows) {
      m += BigInt(r.amount);
      if (r.day === day) today += BigInt(r.amount);
    }
    return { today, month: m };
  }
  /** Money committed by this owner's open executions: not spendable by another rule meanwhile. */
  inFlight(owner: string): bigint {
    const rows = this.db.prepare(`SELECT l.amount FROM legs l JOIN executions e ON e.execution_id = l.execution_id
      WHERE e.owner = ? AND e.source = 'BALANCE' AND e.state IN ('READY', 'EXECUTING') AND l.status IN ('PENDING', 'LIMITED', 'EXECUTING')`).all(owner.toLowerCase()) as { amount: string }[];
    return rows.reduce((s, r) => s + BigInt(r.amount), 0n);
  }
  /** Highest SCHEDULE period this rule has an execution for (whatever its outcome: a period never runs twice). */
  lastSchedulePeriod(ruleId: string): bigint | undefined {
    const rows = this.db.prepare("SELECT event_id FROM executions WHERE rule_id = ? AND event_id LIKE 'sched:%'").all(ruleId.toLowerCase()) as { event_id: string }[];
    let max: bigint | undefined;
    for (const r of rows) {
      const p = BigInt(r.event_id.slice(6));
      if (max === undefined || p > max) max = p;
    }
    return max;
  }
}
