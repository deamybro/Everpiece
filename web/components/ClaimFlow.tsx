"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import type { Hex } from "viem";
import { PaymentStatus } from "@everpiece/shared";
import { Welcome } from "./Welcome";
import { Progress, progressText } from "./status";
import { config, isDevStack } from "../lib/config";
import { chainTime, formatDollars, paymentOf, type Payment } from "../lib/chain";
import { friendlyError } from "../lib/api";
import { decodePackage, type ClaimPackage } from "../lib/link";
import { claimWithCode, FlowError, requestCode } from "../lib/flows";
import { loadAccount, type Account } from "../lib/mera";

type Phase = "loading" | "incomplete" | "unavailable" | "account" | "request" | "code" | "claiming" | "done";

export function ClaimFlow({ paymentId }: { paymentId: Hex }) {
  // The link secret lives only in this ref (ephemeral app state) — never in storage, logs or requests to our servers.
  const pkg = useRef<ClaimPackage | null>(null);
  const [phase, setPhase] = useState<Phase>("loading");
  const [payment, setPayment] = useState<Payment | null>(null);
  const [account, setAccount] = useState<Account | null>(null);
  const [masked, setMasked] = useState("");
  const [simulated, setSimulated] = useState(false);
  const [code, setCode] = useState("");
  const [error, setError] = useState("");
  const [progress, setProgress] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    // Fragment hygiene (master §2.5): parse, validate version, copy to memory, then remove it from the URL/history.
    if (!pkg.current) pkg.current = decodePackage(window.location.hash);
    if (window.location.hash) history.replaceState(null, "", window.location.pathname);
    if (!pkg.current) {
      setPhase("incomplete");
      return;
    }
    (async () => {
      const [p, now] = await Promise.all([paymentOf(paymentId), chainTime()]);
      setPayment(p);
      if (Number(p.status) !== PaymentStatus.ACTIVE || now >= p.expiresAt) {
        setPhase("unavailable");
        return;
      }
      const a = loadAccount();
      setAccount(a);
      setPhase(a ? "request" : "account");
    })().catch(() => setPhase("unavailable"));
  }, [paymentId]);

  async function sendCode() {
    if (!account || !pkg.current) return;
    setBusy(true);
    setError("");
    try {
      const r = await requestCode(paymentId, pkg.current, account.address);
      setMasked(r.maskedPhone);
      setSimulated(r.simulated);
      setPhase("code");
    } catch (e) {
      setError(friendlyError(e instanceof FlowError ? e.code : undefined));
    } finally {
      setBusy(false);
    }
  }

  async function claim() {
    if (!account || !pkg.current) return;
    setPhase("claiming");
    setError("");
    try {
      await claimWithCode(paymentId, pkg.current, account.address, code, (s) => setProgress(progressText(s, "Claiming your money")));
      pkg.current = null; // done with the secret
      setPhase("done");
    } catch (e) {
      const err = e as FlowError & { attemptsLeft?: number };
      const base = friendlyError(err instanceof FlowError ? err.code : undefined);
      setError(err.attemptsLeft !== undefined ? `${base} (${err.attemptsLeft} tries left)` : base);
      setPhase("code");
    } finally {
      setProgress("");
    }
  }

  const amount = payment ? formatDollars(BigInt(payment.amount)) : "";

  return (
    <div className="stack">
      <div className="brand">Everpiece</div>

      {phase === "loading" && <Progress text="Opening your payment…" />}

      {phase === "incomplete" && (
        <div className="stack">
          <h1>This link is incomplete</h1>
          <p className="muted">Open the original link from your message. If you opened it inside WhatsApp, tap the menu and choose &quot;Open in browser&quot;.</p>
        </div>
      )}

      {phase === "unavailable" && (
        <div className="stack">
          <h1>This payment can&apos;t be claimed</h1>
          <p className="muted">
            {payment && Number(payment.status) === PaymentStatus.CLAIMED
              ? "It has already been claimed."
              : "It was cancelled, returned to the sender, or has expired."}
          </p>
          <Link className="button secondary" href="/">Open Everpiece</Link>
        </div>
      )}

      {phase === "account" && (
        <div className="stack">
          <div className="card center">
            <div className="muted">Someone sent you</div>
            <div className="amount">{amount}</div>
            <div className="muted small">Free to claim</div>
          </div>
          <Welcome onReady={(a) => { setAccount(a); setPhase("request"); }} title="Create your account to receive it." />
        </div>
      )}

      {(phase === "request" || phase === "code" || phase === "claiming") && (
        <div className="stack">
          <div className="card center">
            <div className="muted">You&apos;ve been sent</div>
            <div className="amount">{amount}</div>
            <div className="muted small">Free to claim</div>
          </div>

          {phase === "request" && (
            <>
              <p className="muted">To make sure it&apos;s really you, we&apos;ll text a code to the phone number the sender entered.</p>
              <button disabled={busy} onClick={sendCode}>Text me the code</button>
            </>
          )}

          {(phase === "code" || phase === "claiming") && (
            <>
              <p className="muted">We texted a 6-digit code to {masked}. Never share it with anyone, including the sender.</p>
              {simulated && isDevStack && (
                <div className="dev">
                  Local test network: no real text is sent.{" "}
                  <a href={`${config.devFaucetUrl}/sms`} target="_blank" rel="noopener noreferrer">See the simulated text</a>
                </div>
              )}
              <input className="code" inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))} aria-label="Code" />
              <button disabled={code.length !== 6 || phase === "claiming"} onClick={claim}>Claim {amount}</button>
              <button className="ghost" disabled={busy || phase === "claiming"} onClick={sendCode}>Send a new code</button>
            </>
          )}
          <Progress text={progress} />
          {error && <div className="status bad">{error}</div>}
        </div>
      )}

      {phase === "done" && (
        <div className="stack">
          <div className="status ok">You received {amount} ✓</div>
          <h1>It&apos;s yours. What would you like to do?</h1>
          <div className="card stack">
            <div className="row"><strong>Keep Dollars</strong><span className="pill ok">Done</span></div>
            <div className="row"><span>Cash out to bank</span><span className="pill muted">Coming soon</span></div>
            <div className="row"><span>Own a Piece</span><span className="pill muted">Coming soon</span></div>
          </div>
          <Link className="button" href="/">Go to my Everpiece</Link>
        </div>
      )}
    </div>
  );
}
