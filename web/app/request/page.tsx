"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import type { Hex } from "viem";
import { Welcome } from "../../components/Welcome";
import { NairaRequest } from "../../components/NairaRequest";
import { payoutAvailable } from "../../lib/payout";
import { QrCode } from "../../components/QrCode";
import { StepHint } from "../../components/HowItWorks";
import { Progress } from "../../components/status";
import { formatDollars, parseDollars } from "../../lib/chain";
import { friendlyError } from "../../lib/api";
import { friendlyPasskeyError, loadAccount, type Account } from "../../lib/mera";
import { PayError, RequestMode, createRequest, instantAvailable, loadRequest, requestLink, type LoadedRequest } from "../../lib/pay";
import { receiptPath } from "../../lib/receipt";

/** "Request money": the recipient signs an exact AUSD amount; the payer scans the QR (or opens the link) and pays. */
export default function RequestPage() {
  const [account, setAccount] = useState<Account | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [amountText, setAmountText] = useState("");
  const [mode, setMode] = useState<RequestMode>(RequestMode.INSTANT);
  const [currency, setCurrency] = useState<"USD" | "NGN">("USD");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [requestId, setRequestId] = useState<Hex | null>(null);
  const [status, setStatus] = useState<LoadedRequest | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    const a = loadAccount();
    setAccount(a);
    setLoaded(true);
    if (!instantAvailable()) setMode(RequestMode.PROTECTED);
  }, []);

  // Watch for payment: the directory marks it paid only with an on-chain proof.
  useEffect(() => {
    if (!requestId) return;
    const check = () => loadRequest(requestId).then(setStatus).catch(() => {});
    check();
    const t = setInterval(check, 4000);
    return () => clearInterval(t);
  }, [requestId]);

  if (!loaded) return null;
  if (!account) return <Welcome onReady={setAccount} title="Create your account to request money." />;

  const amount = parseDollars(amountText);

  async function create() {
    if (!account || amount === null) return;
    setBusy(true);
    setError("");
    try {
      setRequestId(await createRequest(account, amount, mode));
    } catch (e) {
      setError(e instanceof PayError ? friendlyError(e.code) : friendlyPasskeyError(e));
    } finally {
      setBusy(false);
    }
  }

  if (requestId) {
    const link = requestLink(requestId);
    const paid = status?.paid;
    return (
      <div className="stack">
        <div className="row">
          <Link href="/" className="brand">Everpiece</Link>
          <Link href="/" className="muted small">Done</Link>
        </div>
        {paid ? (
          <>
            <div className="status ok">Paid ✓ You received {formatDollars(amount ?? 0n)}{paid.kind === "protected" ? " (protected: claim it on Home)" : ""}.</div>
            <Link className="button" href={receiptPath(paid.paymentId)}>View receipt</Link>
            <Link className="button ghost" href="/">Back to Everpiece</Link>
          </>
        ) : (
          <>
            <h1>Show this to the person paying</h1>
            <div className="card center stack">
              <div className="muted">You&apos;ll receive exactly</div>
              <div className="amount">{formatDollars(amount ?? 0n)}</div>
              <QrCode value={link} label="Payment request QR code" />
              <div className="muted small">
                {mode === RequestMode.INSTANT ? "Instant: the money arrives at once and is final." : "Protected: they can cancel until you claim it."} Expires in 24 hours.
              </div>
            </div>
            <Progress text="Waiting for the payment…" />
            <div className="row" role="group">
              {typeof navigator !== "undefined" && "share" in navigator && (
                <button className="secondary" onClick={() => navigator.share({ title: "Everpiece", text: "Pay me on Everpiece", url: link }).catch(() => {})}>Share link</button>
              )}
              <button className="secondary" onClick={() => navigator.clipboard.writeText(link).then(() => setCopied(true)).catch(() => {})}>
                {copied ? "Link copied ✓" : "Copy link"}
              </button>
            </div>
            <p className="muted small">They can pay with Dollars or another supported currency. Either way, you receive exactly this amount in Dollars.</p>
          </>
        )}
      </div>
    );
  }

  return (
    <div className="stack">
      <div className="row">
        <Link href="/" className="brand">Everpiece</Link>
        <Link href="/" className="muted small">Cancel</Link>
      </div>
      <StepHint step={1} of={2} />
      <h1>Request money</h1>
      {payoutAvailable() && (
        <div className="row" role="group" aria-label="Receive as">
          <button className={currency === "USD" ? "" : "secondary"} aria-pressed={currency === "USD"} onClick={() => setCurrency("USD")}>Dollars</button>
          <button className={currency === "NGN" ? "" : "secondary"} aria-pressed={currency === "NGN"} onClick={() => setCurrency("NGN")}>Naira to my bank</button>
        </div>
      )}
      {currency === "NGN" ? <NairaRequest account={account} /> : <>
      {!account.username && <div className="status warn">Pick your @username on Home first, so people can see who they&apos;re paying.</div>}
      <input className="big" inputMode="decimal" placeholder="$0.00" value={amountText} onChange={(e) => setAmountText(e.target.value)} aria-label="Amount to request" />
      <div className="row" role="group" aria-label="How it arrives">
        {instantAvailable() && (
          <button className={mode === RequestMode.INSTANT ? "" : "secondary"} aria-pressed={mode === RequestMode.INSTANT} onClick={() => setMode(RequestMode.INSTANT)}>Instant</button>
        )}
        <button className={mode === RequestMode.PROTECTED ? "" : "secondary"} aria-pressed={mode === RequestMode.PROTECTED} onClick={() => setMode(RequestMode.PROTECTED)}>Protected</button>
      </div>
      <p className="muted small">
        {mode === RequestMode.INSTANT
          ? "Instant: the money is yours the moment they pay. Final — they can't take it back."
          : "Protected: the money is held for you until you claim it, and they can cancel before then."}
      </p>
      {error && <div className="status bad">{error}</div>}
      <button disabled={busy || amount === null || amount < 1_000_000n || !account.username} onClick={create}>
        Create request with fingerprint or screen lock
      </button>
      {amount !== null && amount < 1_000_000n && <p className="muted small center">The minimum is $1.00.</p>}
      </>}
    </div>
  );
}
