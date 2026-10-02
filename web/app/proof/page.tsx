"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { config, isDevStack } from "../../lib/config";
import { formatDollars } from "../../lib/chain";

/**
 * Public proof (master §56 part 3, §60 "Metrics: real only"): every number comes from executed escrow events in the
 * indexer, and every transaction links to the explorer. Nothing is seeded, estimated or rounded up.
 */

type Stats = {
  created: number;
  createdVolume: string;
  claimed: number;
  claimedVolume: string;
  cancelled: number;
  cancelledVolume: string;
  refunded: number;
  refundedVolume: string;
  activeCount: number;
  activeLiability: string;
  users: number;
};
type Event = { kind: "CREATED" | "CLAIMED" | "CANCELLED" | "REFUNDED"; amount: string; timestamp: number; txHash: string };
type Proof = { stats: Stats | null; claims: { createdAt: number; settledAt: number }[]; events: Event[] };

const CLAIM_SAMPLE = 1000;
const QUERY = `query Proof($chain: String!, $sample: Int!) {
  Stats(where: { id: { _eq: $chain } }) {
    created createdVolume claimed claimedVolume cancelled cancelledVolume refunded refundedVolume activeCount activeLiability users
  }
  claims: Payment(where: { status: { _eq: CLAIMED } }, order_by: { settledBlock: desc }, limit: $sample) { createdAt settledAt }
  events: PaymentEvent(order_by: [{ blockNumber: desc }, { logIndex: desc }], limit: 10) { kind amount timestamp txHash }
}`;

async function loadProof(): Promise<Proof> {
  const r = await fetch(config.indexerUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query: QUERY, variables: { chain: String(config.chainId), sample: CLAIM_SAMPLE } }),
  });
  if (!r.ok) throw new Error(`indexer HTTP ${r.status}`);
  const j = (await r.json()) as { data?: { Stats: Stats[]; claims: Proof["claims"]; events: Event[] } };
  if (!j.data) throw new Error("indexer: no data");
  return { stats: j.data.Stats[0] ?? null, claims: j.data.claims, events: j.data.events };
}

function median(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function duration(seconds: number): string {
  const unit = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;
  if (seconds < 90) return unit(Math.round(seconds), "second");
  if (seconds < 90 * 60) return unit(Math.round(seconds / 60), "minute");
  if (seconds < 36 * 3600) return unit(Math.round(seconds / 3600), "hour");
  return unit(Math.round(seconds / 86400), "day");
}

const KIND: Record<Event["kind"], string> = { CREATED: "Sent", CLAIMED: "Claimed", CANCELLED: "Cancelled", REFUNDED: "Refunded" };
const when = (unix: number) => new Date(unix * 1000).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });

export default function ProofPage() {
  const [proof, setProof] = useState<Proof | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!config.indexerUrl) return setFailed(true);
    loadProof().then(setProof, () => setFailed(true));
  }, []);

  const s = proof?.stats;
  const finished = s ? s.claimed + s.cancelled + s.refunded : 0;
  const claimTimes = proof?.claims.map((c) => c.settledAt - c.createdAt) ?? [];
  const med = median(claimTimes);

  return (
    <div className="stack">
      <div className="row">
        <div className="brand">Everpiece in numbers</div>
        <Link className="small" href="/">Back</Link>
      </div>
      <p className="muted">Every number here is counted from real payments on {isDevStack ? config.networkLabel : "Monad"}. Nothing is estimated.</p>

      {failed && <div className="status warn">The numbers are unavailable right now. Please try again later.</div>}
      {!failed && !proof && <p className="muted">Loading…</p>}

      {proof && !s && <p className="muted">No payments yet.</p>}
      {s && (
        <div className="card review">
          <dl aria-label="Everpiece numbers">
            <dt>People</dt>
            <dd>{s.users}</dd>
            <dt>Payments sent</dt>
            <dd>{s.created} · {formatDollars(BigInt(s.createdVolume))}</dd>
            <dt>Claimed by the right person</dt>
            <dd>{s.claimed} · {formatDollars(BigInt(s.claimedVolume))}</dd>
            <dt>Cancelled, money returned</dt>
            <dd>{s.cancelled} · {formatDollars(BigInt(s.cancelledVolume))}</dd>
            <dt>Expired, money returned</dt>
            <dd>{s.refunded} · {formatDollars(BigInt(s.refundedVolume))}</dd>
            <dt>Protected right now</dt>
            <dd>{s.activeCount} · {formatDollars(BigInt(s.activeLiability))}</dd>
            <dt>Claim rate</dt>
            <dd>{finished === 0 ? "—" : `${Math.round((s.claimed / finished) * 100)}%`}</dd>
            <dt>Median time to claim</dt>
            <dd>{med === null ? "—" : duration(med)}</dd>
          </dl>
          <p className="muted small">
            Claim rate is the share of finished payments (claimed, cancelled or expired) that reached the recipient.
            {s.claimed > claimTimes.length && ` Median time to claim uses the latest ${claimTimes.length} claims.`}
          </p>
        </div>
      )}

      {proof && proof.events.length > 0 && (
        <>
          <h2>Latest transactions</h2>
          <ul className="list" aria-label="Latest transactions">
            {proof.events.map((e) => (
              <li key={e.txHash + e.kind} className="row">
                <div>
                  <strong>{KIND[e.kind]}</strong> <span className="muted">{formatDollars(BigInt(e.amount))}</span>
                  <div className="muted small">{when(e.timestamp)}</div>
                </div>
                <a className="small" href={`${config.explorerUrl}/tx/${e.txHash}`} target="_blank" rel="noopener noreferrer">See it on Monad</a>
              </li>
            ))}
          </ul>
        </>
      )}

      {config.escrow && (
        <p className="muted small">
          Payments are held by the Everpiece contract{" "}
          <a className="mono" href={`${config.explorerUrl}/address/${config.escrow}`} target="_blank" rel="noopener noreferrer">{config.escrow}</a>
        </p>
      )}
    </div>
  );
}
