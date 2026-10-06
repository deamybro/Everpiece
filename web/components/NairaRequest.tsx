"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import type { Hex } from "viem";
import { formatNaira, parseNaira, type PayoutState } from "@everpiece/shared";
import { QrCode } from "./QrCode";
import { Progress } from "./status";
import { friendlyError } from "../lib/api";
import { friendlyPasskeyError, type Account } from "../lib/mera";
import { PayError } from "../lib/pay";
import { createPayoutRequest, loadPayoutRequest, myBankAccount, payoutSimulated, type SignedAccount } from "../lib/payout";

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
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    myBankAccount(account).then(setBank).catch((e) => setError(errText(e)));
  }, [account]);
  useEffect(() => {
    if (!requestId) return;
    const tick = () => loadPayoutRequest(requestId).then((r) => setState(r.order?.state ?? null)).catch(() => {});
    tick();
    const t = setInterval(tick, 4000);
    return () => clearInterval(t);
  }, [requestId]);

  const kobo = parseNaira(amountText);
  async function create() {
    if (!bank || kobo === null) return;
    setBusy(true);
    setError("");
    try {
      setRequestId(await createPayoutRequest(account, bank, kobo));
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
        {state === "DELIVERED" ? (
          <div className="status ok">{PAYOUT_STATE_TEXT.DELIVERED} At least {formatNaira(kobo)} to {to}.</div>
        ) : (
          <>
            <h1>Show this to the person paying</h1>
            <div className="card center stack">
              <div className="muted">You&apos;ll receive at least</div>
              <div className="amount">{formatNaira(kobo)}</div>
              <div className="muted small">in {to}</div>
              <QrCode value={link} label="Payment request QR code" />
            </div>
            <Progress text={state ? PAYOUT_STATE_TEXT[state] : PAYOUT_STATE_TEXT.AWAITING_PAYMENT} />
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
      <p className="muted small">Paid straight to <strong>{to}</strong> (verified name: {bank.record.accountName}). They pay in Dollars; you get at least this many naira.</p>
      {error && <div className="status bad">{error}</div>}
      <button disabled={busy || kobo === null || kobo < 200_000n} onClick={create}>Create request with fingerprint or screen lock</button>
      {kobo !== null && kobo < 200_000n && <p className="muted small center">The minimum is ₦2,000.</p>}
    </div>
  );
}
