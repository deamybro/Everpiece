"use client";

import Link from "next/link";
import { useState } from "react";
import { Icon } from "./Icon";
import { formatDollars } from "../lib/chain";
import { config } from "../lib/config";
import type { HistoryItem } from "../lib/history";
import { receiptPath } from "../lib/receipt";
import { activityLabel, activityTitle, isReturned } from "../lib/activity-view";

export function PageHeader({ title, description }: { title: string; description?: string }) {
  return <div className="page-heading"><h1>{title}</h1>{description && <p>{description}</p>}</div>;
}

export function EmptyState({ title, description, icon = "activity", children }: { title: string; description: string; icon?: string; children?: React.ReactNode }) {
  return <div className="empty-state"><span className="empty-state-icon"><Icon name={icon} size={24} /></span><strong>{title}</strong><p>{description}</p>{children}</div>;
}

export function LoadingSkeleton({ label = "Loading" }: { label?: string }) {
  return <span className="loading-skeleton" role="status" aria-label={label}><span className="sr-only">{label}</span></span>;
}

export function CopyButton({ value, label = "Copy" }: { value: string; label?: string }) {
  const [feedback, setFeedback] = useState("");
  async function copy() {
    try { await navigator.clipboard.writeText(value); setFeedback("Copied"); }
    catch { setFeedback("Copy unavailable. Select the text to copy it."); }
  }
  return <div className="copy-control"><button className="secondary small" onClick={copy}><Icon name="copy" size={15} />{label}</button><span className="small muted" role="status">{feedback}</span></div>;
}

export function StatusBadge({ item }: { item: HistoryItem }) {
  const complete = item.state === "paid" || item.state === "claimed";
  return <span className={`pill${complete ? " ok" : isReturned(item) ? " muted" : ""}`}>{activityLabel(item)}</span>;
}

export function TransactionRow({ item }: { item: HistoryItem }) {
  const received = item.direction === "received";
  const returned = isReturned(item);
  return <li className="transaction-row" data-payment-id={item.paymentId}>
    <Link className="transaction-link" href={receiptPath(item.paymentId)}>
      <span className={`transaction-icon${received ? " received" : returned ? " returned" : ""}`}><Icon name={returned ? "back" : received ? "request" : "send"} size={19} /></span>
      <span className="transaction-copy"><strong>{activityTitle(item)}</strong><span>{new Date(item.at * 1000).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}</span><StatusBadge item={item} /></span>
      <span className={`transaction-amount${received ? " positive" : ""}`}><strong>{received ? "+" : returned ? "" : "−"}{formatDollars(item.amount)}</strong><span>AUSD</span></span>
    </Link>
    {item.tx && <a className="transaction-explorer" href={`${config.explorerUrl}/tx/${item.tx}`} target="_blank" rel="noopener noreferrer" aria-label={`View ${activityTitle(item)} on Monad explorer`}>Explorer ↗</a>}
  </li>;
}

export function ProfileSection({ title, children, id }: { title: string; children: React.ReactNode; id?: string }) {
  return <section className="profile-section card" id={id}><h2>{title}</h2>{children}</section>;
}
