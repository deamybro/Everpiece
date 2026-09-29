"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { E164 } from "@everpiece/shared";
import { Welcome } from "../../components/Welcome";
import { Progress, progressText } from "../../components/status";
import { dollarsOf, formatDollars, parseDollars } from "../../lib/chain";
import { friendlyError } from "../../lib/api";
import { claimLink } from "../../lib/link";
import { FlowError, sendByLink } from "../../lib/flows";
import { friendlyPasskeyError, loadAccount, type Account } from "../../lib/mera";

type Step = "amount" | "who" | "review" | "sending" | "done" | "protectedNoInvite";

export default function Send() {
  const [account, setAccount] = useState<Account | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [step, setStep] = useState<Step>("amount");
  const [amountText, setAmountText] = useState("");
  const [phone, setPhone] = useState("");
  const [balance, setBalance] = useState<bigint | null>(null);
  const [progress, setProgress] = useState("");
  const [error, setError] = useState("");
  const [link, setLink] = useState("");
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    const a = loadAccount();
    setAccount(a);
    setLoaded(true);
    if (a) dollarsOf(a.address).then(setBalance).catch(() => {});
  }, []);

  if (!loaded) return null;
  if (!account) return <Welcome onReady={setAccount} title="Create your account to send money." />;

  const amount = parseDollars(amountText);
  const phoneOk = E164.test(phone.replace(/\s+/g, ""));
  const cleanPhone = phone.replace(/\s+/g, "");

  async function send() {
    if (!account || amount === null) return;
    setStep("sending");
    setError("");
    try {
      const { paymentId, pkg } = await sendByLink(account, amount, cleanPhone, (s) => setProgress(progressText(s, "Protecting your payment")));
      setLink(claimLink(paymentId, pkg));
      setStep("done");
    } catch (e) {
      if (e instanceof FlowError && e.code.startsWith("InviteFailedAfterPayment")) {
        // Money is protected on-chain but the recipient can't verify yet: never offer a second send.
        setStep("protectedNoInvite");
      } else {
        setError(e instanceof FlowError ? friendlyError(e.code) : friendlyPasskeyError(e));
        setStep("review");
      }
    } finally {
      setProgress("");
    }
  }

  const shareText = `I sent you ${amount !== null ? formatDollars(amount) : "money"} on Everpiece. Tap to claim it (free): ${link}`;
  const waHref = `https://wa.me/${cleanPhone.replace(/^\+/, "")}?text=${encodeURIComponent(shareText)}`;

  return (
    <div className="stack">
      <div className="row">
        <Link href="/" className="brand">Everpiece</Link>
        {step !== "done" && <Link href="/" className="muted small">Cancel</Link>}
      </div>

      {step === "amount" && (
        <div className="stack">
          <h1>How much?</h1>
          <input className="big" inputMode="decimal" placeholder="$0.00" value={amountText} onChange={(e) => setAmountText(e.target.value)} aria-label="Amount in Dollars" />
          {balance !== null && <p className="muted center">You have {formatDollars(balance)}</p>}
          {amount !== null && balance !== null && amount > balance && <div className="status bad">You don&apos;t have enough Dollars for this.</div>}
          <button disabled={amount === null || amount < 1_000_000n || (balance !== null && amount > balance)} onClick={() => setStep("who")}>
            Continue
          </button>
          {amount !== null && amount < 1_000_000n && <p className="muted small center">The minimum is $1.00.</p>}
        </div>
      )}

      {step === "who" && (
        <div className="stack">
          <h1>Who is it for?</h1>
          <p className="muted">We&apos;ll text them a code so only they can claim it. You&apos;ll share the link with them yourself.</p>
          <div>
            <label htmlFor="phone">Their phone number (with country code)</label>
            <input id="phone" type="tel" autoComplete="off" placeholder="+234 800 000 0000" value={phone} onChange={(e) => setPhone(e.target.value)} />
          </div>
          {phone.length > 3 && !phoneOk && <p className="muted small">Start with + and the country code, e.g. +234 or +44.</p>}
          <button disabled={!phoneOk} onClick={() => setStep("review")}>Continue</button>
          <button className="ghost" onClick={() => setStep("amount")}>Back</button>
        </div>
      )}

      {(step === "review" || step === "sending") && amount !== null && (
        <div className="stack">
          <h1>Review</h1>
          <div className="card review">
            <dl>
              <dt>You send</dt>
              <dd>{formatDollars(amount)}</dd>
              <dt>Funding/provider fee</dt>
              <dd>$0.00</dd>
              <dt>Everpiece fee</dt>
              <dd>$0.00</dd>
              <dt>They receive</dt>
              <dd>{formatDollars(amount)}</dd>
              <dt>Recipient</dt>
              <dd>{cleanPhone}</dd>
              <dt>Expires</dt>
              <dd>in 30 days</dd>
            </dl>
          </div>
          <p className="muted small">
            Your money stays protected until they claim it. You can cancel any time before they do. If they never claim it,
            the money comes back to you after 30 days. Free to claim.
          </p>
          <Progress text={progress} />
          {error && <div className="status bad">{error}</div>}
          <button disabled={step === "sending"} onClick={send}>Confirm with fingerprint</button>
          {step === "review" && <button className="ghost" onClick={() => setStep("who")}>Back</button>}
        </div>
      )}

      {step === "protectedNoInvite" && (
        <div className="stack">
          <div className="status warn">Your money is protected, but we couldn&apos;t finish setting up the recipient.</div>
          <p className="muted">
            Nothing was lost and you were not charged twice. Go to Home and cancel this payment to get your money back
            straight away, then try sending again.
          </p>
          <Link className="button" href="/">Go to Home</Link>
        </div>
      )}

      {step === "done" && amount !== null && (
        <div className="stack">
          <div className="status ok">Payment protected ✓</div>
          <h1>Now send them the link</h1>
          <p className="muted">
            Send this link only to them. They&apos;ll also get a code by text to {cleanPhone} — you won&apos;t see it.
          </p>
          <a className="button" href={waHref} target="_blank" rel="noopener noreferrer">Send on WhatsApp</a>
          {typeof navigator !== "undefined" && "share" in navigator && (
            <button className="secondary" onClick={() => navigator.share({ title: "Everpiece", text: shareText }).catch(() => {})}>
              Share another way
            </button>
          )}
          <button
            className="secondary"
            onClick={() => navigator.clipboard.writeText(link).then(() => setCopied(true)).catch(() => {})}
          >
            {copied ? "Link copied ✓" : "Copy link"}
          </button>
          <p className="muted small">This link is shown only once. If you lose it, cancel the payment from Home and send again.</p>
          <Link className="button ghost" href="/">Done</Link>
        </div>
      )}
    </div>
  );
}
