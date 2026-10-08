import type { AutomateService } from "./service.ts";
import { log } from "./log.ts";

/**
 * Trigger watcher (docs/AUTOMATE.md §Triggers): turns trusted facts into trigger events, in-process.
 * - PAYMENT_RECEIVED: money that arrived for an owner with rules, from the Envio indexer (which lags the head by the
 *   finality margin): instant payments (EverpiecePay.Paid) and claimed protected payments (escrow PaymentClaimed).
 *   The event id is the on-chain payment id + kind, so a replayed or re-polled fact never plans twice.
 * - BALANCE_CHECK / YIELD_CHECK: periodic, one id per owner per time slot (so at most one plan per slot).
 * Money the engine itself moved (Earn withdrawals) is not a "payment received" and is never seen here.
 */
export type WatcherConfig = { indexerUrl: string; pollMs: number; checkEverySec: number; now?: () => number };

type Row = { id: string; recipient: string; amount: string; timestamp: number };

export function startWatcher(svc: AutomateService, cfg: WatcherConfig): () => void {
  const now = cfg.now ?? (() => Math.floor(Date.now() / 1000));
  // only payments that arrive after the watcher starts (a rule never acts on money that came before it existed)
  let since = now();
  let running = false;

  async function gql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
    const r = await fetch(cfg.indexerUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ query, variables }) });
    if (!r.ok) throw new Error(`indexer HTTP ${r.status}`);
    const j = (await r.json()) as { data?: T; errors?: unknown };
    if (!j.data) throw new Error("indexer: no data");
    return j.data;
  }

  async function tick() {
    if (running) return;
    running = true;
    try {
      const owners = svc.store.enabledOwners();
      if (owners.length === 0) return;
      // a protected payment's `recipient` is set only when it is claimed (with settledAt), so no enum filter is needed
      const d = await gql<{ instant: Row[]; claimed: { id: string; recipient: string; amount: string; settledAt: number }[] }>(
        `query($owners: [String!]!, $since: Int!) {
          instant: InstantPayment(where: { recipient: { _in: $owners }, timestamp: { _gte: $since } }, order_by: { timestamp: asc }) { id recipient amount timestamp }
          claimed: Payment(where: { recipient: { _in: $owners }, settledAt: { _gte: $since } }, order_by: { settledAt: asc }) { id recipient amount settledAt }
        }`,
        { owners, since },
      );
      const facts = [
        ...d.instant.map((p) => ({ id: `paid:${p.id}`, recipient: p.recipient, amount: p.amount, at: p.timestamp })),
        ...d.claimed.map((c) => ({ id: `claimed:${c.id}`, recipient: c.recipient, amount: c.amount, at: c.settledAt })),
      ];
      for (const f of facts) {
        await svc.trigger({ event: { kind: "PAYMENT_RECEIVED", id: f.id, recipient: f.recipient, amount: f.amount, at: String(f.at), origin: "EXTERNAL" } });
      }
      // periodic checks, one per owner per slot
      const slot = Math.floor(now() / cfg.checkEverySec);
      for (const owner of svc.store.ownersWithTrigger("BALANCE_ABOVE")) {
        await svc.trigger({ event: { kind: "BALANCE_CHECK", id: `bal:${slot}`, owner, at: String(now()) } });
      }
      for (const [owner, positionId] of svc.store.yieldPositions()) {
        await svc.trigger({ event: { kind: "YIELD_CHECK", id: `yield:${slot}`, owner, positionId, at: String(now()) } });
      }
      // the indexer stamps block time; keep a small overlap (dedupe is by event id, so overlap is free)
      if (facts.length) since = Math.max(since, Math.max(...facts.map((f) => f.at)) - 60);
    } catch (e) {
      log("warn", "watcher.tick_failed", { err: String(e).slice(0, 160) });
    } finally {
      running = false;
    }
  }

  const timer = setInterval(tick, cfg.pollMs);
  timer.unref();
  void tick();
  return () => clearInterval(timer);
}
