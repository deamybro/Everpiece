"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useAccountView } from "../../components/AccountView";
import { EmptyState, LoadingSkeleton, PageHeader, TransactionRow } from "../../components/DashboardUI";
import { loadHistory, type History } from "../../lib/history";
import { activityFilters, matchesActivity, type ActivityFilter } from "../../lib/activity-view";
import { config } from "../../lib/config";

export default function ActivityPage() {
  const { account, loaded } = useAccountView();
  const [history, setHistory] = useState<History | null>(null);
  const [filter, setFilter] = useState<ActivityFilter>("All");
  const [error, setError] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  useEffect(() => {
    if (!account) { setHistory(null); return; }
    let live = true, running = false;
    setHistory(null); setError(false);
    const read = async () => {
      if (running) return;
      running = true;
      try { const next = await loadHistory(account); if (live) { setHistory(next); setError(false); } }
      catch { if (live) setError(true); }
      finally { running = false; }
    };
    void read();
    const timer = setInterval(() => { if (!document.hidden) void read(); }, 10_000);
    return () => { live = false; clearInterval(timer); };
  }, [account?.address, refreshKey]);
  const items = history?.items.filter(item => matchesActivity(item, filter)) ?? [];
  return <div className="stack activity-page"><PageHeader title="Activity" description="Every payment, with a clear trail." /><div className="activity-filters" role="group" aria-label="Filter activity">{activityFilters.map(f => <button key={f} className="small" aria-pressed={filter === f} onClick={() => setFilter(f)}>{f}</button>)}</div>
    {!loaded ? <LoadingSkeleton label="Loading your account" /> : !account ? <div className="card"><EmptyState title="Your payments live here" description="Sign in to view your real transaction history."><Link className="button" href="/profile">Sign in with your passkey</Link></EmptyState></div> : <>
      {error && <div className="status warn" role="status">{history ? "Unable to refresh. Showing the last loaded history." : "Couldn’t load your payment history."}<button className="secondary small" onClick={() => setRefreshKey(k => k + 1)}>Try again</button></div>}
      {history?.source === "device" && <p className="muted small">{config.indexerUrl ? "Full history is temporarily unavailable. Showing verified payments from this device." : "Showing verified payments from this device."}</p>}
      {!history && !error ? <LoadingSkeleton label="Loading payment history" /> : history && (items.length ? <ul className="transaction-list card">{items.map(item => <TransactionRow key={item.direction + item.paymentId} item={item} />)}</ul> : <div className="card"><EmptyState title={filter === "All" ? "No payments yet" : "No matching payments"} description={filter === "All" ? "Your completed and protected payments will appear here." : "Try another activity filter."} /></div>)}
      <p className="muted small">To cancel or return a protected payment, <Link href="/">open Home</Link>.</p>
    </>}
  </div>;
}
