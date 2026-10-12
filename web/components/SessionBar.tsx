"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import { fromBaseUnits } from "@everpiece/shared";
import { friendlyPasskeyError, unlockSession, type Account } from "../lib/mera";
import { getSessionSnapshot, lockSession, subscribeSession } from "../lib/session";

const TTL_MS = 5 * 60_000;
const CAPS = [10, 20, 50];
const dollars = (v: bigint) => `$${Number(fromBaseUnits(v, 6)).toFixed(2)}`;

/**
 * One fingerprint, then small payments without asking again, for a few minutes (lib/session.ts). Everything else
 * (account changes, rules, private payments, anything with no amount) still asks every time.
 */
export function SessionBar({ account }: { account: Account }) {
  const s = useSyncExternalStore(subscribeSession, getSessionSnapshot, () => null);
  const [cap, setCap] = useState(20);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!s) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [s]);

  if (s) {
    const left = Math.max(0, Math.round((s.expiresAt - now) / 1000));
    return (
      <div className="card stack small" aria-label="Unlocked session">
        <div className="row">
          <span>🔓 Unlocked · {Math.floor(left / 60)}:{String(left % 60).padStart(2, "0")} · {dollars(s.capLeft)} left</span>
          <button className="ghost" onClick={lockSession}>Lock now</button>
        </div>
        <span className="muted">Payments up to what&apos;s left won&apos;t ask again. It locks by itself when the time or the amount runs out, or if you leave the page.</span>
      </div>
    );
  }
  return (
    <div className="card stack small" aria-label="Unlock for quick payments">
      <div className="row">
        <span>🔒 Quick payments are off</span>
        <button
          className="secondary"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            setError("");
            try {
              await unlockSession(account, { ttlMs: TTL_MS, cap: BigInt(cap) * 1_000_000n });
            } catch (e) {
              setError(friendlyPasskeyError(e));
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy ? "…" : "Unlock for 5 min"}
        </button>
      </div>
      <label className="muted">
        Up to{" "}
        <select value={cap} onChange={(e) => setCap(Number(e.target.value))}>
          {CAPS.map((c) => <option key={c} value={c}>${c}</option>)}
        </select>{" "}
        in that time, then it locks.
      </label>
      {error && <div className="status bad">{error}</div>}
    </div>
  );
}
