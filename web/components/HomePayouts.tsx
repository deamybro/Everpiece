"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { formatNaira, isFinalPayout, type PayoutState } from "@everpiece/shared";
import { loadLocalPayouts, loadPayoutRequest, payoutOrder, type LocalPayout } from "../lib/payout";

const LABEL: Record<PayoutState, string> = {
  AWAITING_PAYMENT: "Waiting for payment", PAYOUT_FUNDED: "Paid", BANK_PROCESSING: "Sending to the bank", DELIVERED: "Delivered",
  REFUNDING: "Failed, refunding", REFUNDED: "Refunded", EXPIRED: "Not paid",
};

/** Naira payouts this device sent, cashed out or asked for, with their live state (provider-confirmed). */
export function HomePayouts() {
  const [items, setItems] = useState<LocalPayout[]>([]);
  const [states, setStates] = useState<Record<string, PayoutState>>({});

  useEffect(() => {
    const all = loadLocalPayouts().slice(0, 6);
    setItems(all);
    const final: Record<string, boolean> = {};
    const check = () =>
      !document.hidden &&
      all.forEach(async (p) => {
        if (final[p.key]) return;
        const s = p.orderId
          ? (await payoutOrder(p.orderId).catch(() => null))?.state
          : p.requestId
            ? (await loadPayoutRequest(p.requestId).catch(() => null))?.order?.state
            : undefined;
        if (s) {
          if (isFinalPayout(s)) final[p.key] = true; // finished payouts aren't asked about again
          setStates((x) => ({ ...x, [p.key]: s }));
        }
      });
    check();
    const t = setInterval(check, 8000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!items.length) return null;
  return (
    <div className="card stack">
      <strong>Bank payouts</strong>
      <ul className="list" aria-label="Bank payouts">
        {items.map((p) => {
          const s = states[p.key];
          const what = p.role === "cashout" ? "Cash out" : p.role === "received" ? "You asked for" : `To ${p.who ?? "them"}`;
          const row = (
            <span className="row">
              <span className="stack">
                <strong>{what} · {formatNaira(BigInt(p.kobo))}</strong>
                <span className="muted small">{p.to}</span>
              </span>
              <span className={`pill${s === "DELIVERED" ? " ok" : s === "REFUNDED" || s === "REFUNDING" ? " bad" : ""}`}>{s ? LABEL[s] : "…"}</span>
            </span>
          );
          return <li key={p.key}>{p.requestId ? <Link href={`/payout/${p.requestId}`}>{row}</Link> : row}</li>;
        })}
      </ul>
    </div>
  );
}
