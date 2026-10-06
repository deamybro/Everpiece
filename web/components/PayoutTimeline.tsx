"use client";

import type { PayoutState } from "@everpiece/shared";

/**
 * Paid → Sent to the bank → Delivered, with the time each step happened. "Delivered" lights up only when the payout
 * provider confirms the bank transfer (docs/PAYOUT.md §3). A failed transfer shows the refund path instead.
 */
const HAPPY: { state: PayoutState; label: string; hint: string }[] = [
  { state: "PAYOUT_FUNDED", label: "Paid", hint: "The Dollars reached the payout provider" },
  { state: "BANK_PROCESSING", label: "Sent to the bank", hint: "The bank transfer is on its way" },
  { state: "DELIVERED", label: "Delivered", hint: "The provider confirmed the money is in the account" },
];
const FAILED: { state: PayoutState; label: string; hint: string }[] = [
  { state: "PAYOUT_FUNDED", label: "Paid", hint: "The Dollars reached the payout provider" },
  { state: "REFUNDING", label: "Bank transfer failed", hint: "The money is being sent back" },
  { state: "REFUNDED", label: "Refunded", hint: "Back with the person who paid" },
];
const RANK: Record<PayoutState, number> = { AWAITING_PAYMENT: 0, PAYOUT_FUNDED: 1, BANK_PROCESSING: 2, DELIVERED: 3, REFUNDING: 2, REFUNDED: 3, EXPIRED: 0 };

const time = (ms: number) => new Date(ms).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" });

export function PayoutTimeline({ state, history = [] }: { state: PayoutState; history?: { state: PayoutState; at: number }[] }) {
  if (state === "EXPIRED") return <div className="status warn">Not paid in time. Nothing was taken.</div>;
  const failed = state === "REFUNDING" || state === "REFUNDED";
  const steps = failed ? FAILED : HAPPY;
  const at = (s: PayoutState) => history.find((h) => h.state === s)?.at;
  return (
    <ol className="timeline" aria-label="Payout progress">
      {steps.map((st, i) => {
        const done = RANK[state] >= i + 1;
        const active = !done && RANK[state] === i;
        const when = at(st.state);
        return (
          <li key={st.state} className={`${done ? "done" : active ? "active" : "todo"}${failed && i > 0 ? " failed" : ""}`}>
            <span className="dot" aria-hidden="true">{done ? (failed && i > 0 ? "!" : "✓") : ""}</span>
            <span className="what">
              <strong>{st.label}</strong>
              <span className="muted small">{done && when ? time(when) : active ? `${st.hint}…` : st.hint}</span>
            </span>
          </li>
        );
      })}
    </ol>
  );
}
