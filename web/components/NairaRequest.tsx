"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import type { Hex } from "viem";
import { formatNaira, parseNaira, type PayoutState } from "@everpiece/shared";
import { formatDollars } from "../lib/chain";
import { QrCode } from "./QrCode";
import { Progress } from "./status";
import { friendlyError } from "../lib/api";
import { friendlyPasskeyError, type Account } from "../lib/mera";
import { PayError } from "../lib/pay";
import { nairaEstimate, bankLine, createPayoutRequest, loadPayoutRequest, myBankAccount, payoutSimulated, rememberPayout, type PublicOrder, type SignedAccount } from "../lib/payout";
import { PayoutTimeline } from "./PayoutTimeline";

const errText = (e: unknown) => (e instanceof PayError ? friendlyError(e.code) : friendlyPasskeyError(e));
export const PAYOUT_STATE_TEXT: Record<PayoutState, string> = {
  AWAITING_PAYMENT: "Waiting for the payment…",
  PAYOUT_FUNDED: "Paid. Sending it to the bank…",
  BANK_PROCESSING: "The bank transfer is in progress…",
  DELIVERED: "Delivered to the bank account ✓",
  REFUNDING: "The bank transfer failed. Refunding the sender…",
  REFUNDED: "The bank transfer failed. The sender was refunded.",
  EXPIRED: "Not paid in time. Nothing was taken.",
};

/** "I want to receive at least ₦X in my bank account" as a QR code / link (docs/PAYOUT.md). */
export function NairaRequest({ account }: { account: Account }) {
  const [bank, setBank] = useState<SignedAccount | null | undefined>(undefined);
  const [amountText, setAmountText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [requestId, setRequestId] = useState<Hex | null>(null);
  const [state, setState] = useState<PayoutState | null>(null);
  const [order, setOrder] = useState<PublicOrder | null>(null);
  const [copied, setCopied] = useState(false);
  const [estimate, setEstimate] = useState<bigint | null>(null);

  useEffect(() => {
    myBankAccount(account).then(setBank).catch((e) => setError(errText(e)));
  }, [account]);
  useEffect(() => {
    if (!requestId) return;
    const tick = () =>
      !document.hidden &&
      loadPayoutRequest(requestId)
        .then((r) => {
          setState(r.order?.state ?? null);
          setOrder(r.order);
        })
        .catch(() => {});
    tick();
    const t = setInterval(() => {
      if (state === "DELIVERED" || state === "REFUNDED" || state === "EXPIRED") return;
      tick();
    }, 5000);
    return () => clearInterval(t);
  }, [requestId, state]);

  const kobo = parseNaira(amountText);
  useEffect(() => {
    setEstimate(null);
    if (kobo === null || kobo < 200_000n) return;
    const t = setTimeout(() => nairaEstimate(kobo).then((e) => setEstimate(e.stableAmount)).catch(() => {}), 350);
    return () => clearTimeout(t);
  }, [kobo]);
  async function create() {
    if (!bank || kobo === null) return;
    setBusy(true);
    setError("");
    try {
      const id = await createPayoutRequest(account, bank, kobo);
      rememberPayout({ key: id, role: "received", requestId: id, kobo: kobo.toString(), to: bankLine(bank), at: Date.now() });
      setRequestId(id);
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  }

  if (bank === undefined) return <Progress text={error ? "" : "Checking your bank account…"} />;
  if (!bank) {
    return (
      <div className="stack">
        <p className="muted">Add your Nigerian bank account first. People will pay you in naira, straight to it.</p>
        <Link className="button" href="/receive">Add my bank account</Link>
        {error && <div className="status bad">{error}</div>}
      </div>
    );
  }
  const to = `${bank.institutionName ?? bank.record.institution} ••${bank.record.last4}`;
  if (requestId && kobo !== null) {
    const link = `${window.location.origin}/payout/${requestId}`;
    return (
      <div className="stack">
        {state && state !== "AWAITING_PAYMENT" ? (
          <>
            <div className="card center stack">
              <div className="muted">{state === "DELIVERED" ? "You received at least" : "On its way to you"}</div>
              <div className="amount">{formatNaira(kobo)}</div>
              <div className="muted small">in {to}</div>
            </div>
            <PayoutTimeline state={state} history={order?.history} />
          </>
        ) : (
          <>
            <h1>Show this to the person paying</h1>
            <div className="card center stack">
              <div className="muted">You&apos;ll receive at least</div>
              <div className="amount">{formatNaira(kobo)}</div>
              <div className="muted small">in {to}</div>
              <QrCode value={link} label="Payment request QR code" />
            </div>
            <Progress text={PAYOUT_STATE_TEXT.AWAITING_PAYMENT} />
            <button className="secondary" onClick={() => navigator.clipboard.writeText(link).then(() => setCopied(true)).catch(() => {})}>
              {copied ? "Link copied ✓" : "Copy link"}
            </button>
          </>
        )}
        <Link className="button ghost" href="/">Back to Everpiece</Link>
      </div>
    );
  }
  return (
    <div className="stack">
      {payoutSimulated() && <div className="dev">Simulated bank payout: no real bank is paid on this test site.</div>}
      <input className="big" inputMode="decimal" placeholder="₦0" value={amountText} onChange={(e) => setAmountText(e.target.value)} aria-label="Naira to receive" />
      <div className="chips" role="group" aria-label="Quick amounts">
        {[5_000, 10_000, 20_000, 50_000].map((n) => (
          <button key={n} className="secondary" onClick={() => setAmountText(String(n))}>{formatNaira(BigInt(n) * 100n)}</button>
        ))}
      </div>
      <div className="estimate" aria-live="polite">{estimate !== null ? `They'll pay about ${formatDollars(estimate)}` : ""}</div>
      <p className="muted small">Paid straight to <strong>{to}</strong> (verified name: {bank.record.accountName}). They pay in Dollars; you get at least this many naira.</p>
      {error && <div className="status bad">{error}</div>}
      <button disabled={busy || kobo === null || kobo < 200_000n} onClick={create}>Create request with fingerprint or screen lock</button>
      {kobo !== null && kobo < 200_000n && <p className="muted small center">The minimum is ₦2,000.</p>}
    </div>
  );
}
