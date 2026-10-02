"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { E164, normalizeEmail } from "@everpiece/shared";
import { Welcome } from "../../components/Welcome";
import { Progress, progressText } from "../../components/status";
import { MessageComposer, type Draft } from "../../components/MessageComposer";
import { messagesAvailable, seconds } from "../../lib/message";
import { dollarsOf, formatDollars, parseDollars } from "../../lib/chain";
import { friendlyError } from "../../lib/api";
import { claimLink } from "../../lib/link";
import { FlowError, sendByLink, sendToUsername } from "../../lib/flows";
import { friendlyPasskeyError, loadAccount, type Account } from "../../lib/mera";
import { UsernameError, findRecipient, type Pinning, type Recipient } from "../../lib/username";

type Step = "amount" | "who" | "review" | "sending" | "done" | "protectedNoInvite";
type Method = "phone" | "email" | "username";

export default function Send() {
  const [account, setAccount] = useState<Account | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [step, setStep] = useState<Step>("amount");
  const [amountText, setAmountText] = useState("");
  const [phone, setPhone] = useState("");
  const [emailInput, setEmailInput] = useState("");
  const [method, setMethod] = useState<Method>("phone");
  const [usernameInput, setUsernameInput] = useState("");
  const [found, setFound] = useState<{ recipient: Recipient; pinning: Pinning } | null>(null);
  const [confirmedNew, setConfirmedNew] = useState(false);
  const [lookupError, setLookupError] = useState("");
  const [looking, setLooking] = useState(false);
  const [delivered, setDelivered] = useState(true);
  const [balance, setBalance] = useState<bigint | null>(null);
  const [progress, setProgress] = useState("");
  const [error, setError] = useState("");
  const [link, setLink] = useState("");
  const [copied, setCopied] = useState(false);
  const [draft, setDraft] = useState<Draft>({ note: "", voice: null });

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
  const email = normalizeEmail(emailInput);
  const note = draft.note.trim();
  const withMessage = method !== "username" && messagesAvailable() && (note !== "" || draft.voice !== null);

  async function lookUp() {
    setLooking(true);
    setLookupError("");
    setFound(null);
    setConfirmedNew(false);
    try {
      setFound(await findRecipient(usernameInput));
    } catch (e) {
      setLookupError(friendlyError(e instanceof UsernameError ? e.code : undefined));
    } finally {
      setLooking(false);
    }
  }

  async function send() {
    if (!account || amount === null) return;
    setStep("sending");
    setError("");
    if (method === "username") {
      if (!found) return;
      try {
        const r = await sendToUsername(account, amount, found.recipient, (s) => setProgress(progressText(s, "Sending")));
        setDelivered(r.delivered);
        setStep("done");
      } catch (e) {
        setError(e instanceof FlowError ? friendlyError(e.code) : friendlyPasskeyError(e));
        setStep("review");
      } finally {
        setProgress("");
      }
      return;
    }
    try {
      const to = method === "email" && email ? { channel: "email" as const, email } : { channel: "sms" as const, phone: cleanPhone };
      const message = withMessage
        ? { note, audio: draft.voice ? { bytes: draft.voice.bytes, type: draft.voice.type, durationMs: draft.voice.durationMs } : undefined }
        : undefined;
      const { paymentId, pkg } = await sendByLink(account, amount, to, (s) => setProgress(progressText(s, "Protecting your payment")), message);
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

  const shareText = `I sent you ${amount !== null ? formatDollars(amount) : "money"}${withMessage ? " and a message" : ""} on Everpiece. Tap to claim it (free): ${link}`;
  // Email payments have no phone number: WhatsApp opens its contact picker instead.
  const waHref = `https://wa.me/${method === "phone" ? cleanPhone.replace(/^\+/, "") : ""}?text=${encodeURIComponent(shareText)}`;

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
          <div className="row" role="group" aria-label="Send to">
            <button className={method === "phone" ? "" : "secondary"} aria-pressed={method === "phone"} onClick={() => setMethod("phone")}>Phone</button>
            <button className={method === "email" ? "" : "secondary"} aria-pressed={method === "email"} onClick={() => setMethod("email")}>Email</button>
            <button className={method === "username" ? "" : "secondary"} aria-pressed={method === "username"} onClick={() => setMethod("username")}>@username</button>
          </div>
          {method === "email" && (
            <>
              <p className="muted">We&apos;ll email them a code so only they can claim it. You&apos;ll share the link with them yourself, but not by email.</p>
              <div>
                <label htmlFor="email">Their email address</label>
                <input
                  id="email" type="email" inputMode="email" autoComplete="off" autoCapitalize="none" spellCheck={false}
                  placeholder="name@example.com" value={emailInput} onChange={(e) => setEmailInput(e.target.value)}
                />
              </div>
              {emailInput.trim().length > 3 && !email && <p className="muted small">That doesn&apos;t look like an email address.</p>}
              <button disabled={!email} onClick={() => setStep("review")}>Continue</button>
            </>
          )}
          {method === "phone" && (
            <>
              <p className="muted">We&apos;ll text them a code so only they can claim it. You&apos;ll share the link with them yourself.</p>
              <div>
                <label htmlFor="phone">Their phone number (with country code)</label>
                <input id="phone" type="tel" autoComplete="off" placeholder="+234 800 000 0000" value={phone} onChange={(e) => setPhone(e.target.value)} />
              </div>
              {phone.length > 3 && !phoneOk && <p className="muted small">Start with + and the country code, e.g. +234 or +44.</p>}
              <button disabled={!phoneOk} onClick={() => setStep("review")}>Continue</button>
            </>
          )}
          {method === "username" && (
            <>
              <p className="muted">For people who already have Everpiece. Only their account can claim it — no link or code needed.</p>
              <div>
                <label htmlFor="to-username">Their Everpiece username</label>
                <input
                  id="to-username" autoCapitalize="none" autoCorrect="off" spellCheck={false} placeholder="@username" value={usernameInput}
                  onChange={(e) => { setUsernameInput(e.target.value); setFound(null); setLookupError(""); }}
                />
              </div>
              {!found && <button className="secondary" disabled={looking || usernameInput.trim().length < 3} onClick={lookUp}>Find</button>}
              {lookupError && <div className="status bad">{lookupError}</div>}
              {found && (
                <div className="card stack">
                  <div>
                    <strong>{found.recipient.displayName}</strong> <span className="muted">@{found.recipient.username}</span>
                  </div>
                  <div className="muted small">Account {found.recipient.account.slice(0, 6)}…{found.recipient.account.slice(-4)}</div>
                  {found.pinning === "pinned" ? (
                    <div className="pill ok">You&apos;ve paid them before ✓</div>
                  ) : (
                    <label className="small">
                      <input type="checkbox" checked={confirmedNew} onChange={(e) => setConfirmedNew(e.target.checked)} />{" "}
                      This is the person I mean. I&apos;ve checked the username with them.
                    </label>
                  )}
                </div>
              )}
              <button disabled={!found || (found.pinning === "new" && !confirmedNew)} onClick={() => setStep("review")}>Continue</button>
            </>
          )}
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
              <dd>{method === "username" && found ? `@${found.recipient.username} (${found.recipient.displayName})` : method === "email" ? email : cleanPhone}</dd>
              <dt>Expires</dt>
              <dd>in 30 days</dd>
              {withMessage && (
                <>
                  <dt>Message</dt>
                  <dd>{[draft.voice && `Voice note ${seconds(draft.voice.durationMs)}`, note && "Written note"].filter(Boolean).join(" + ")}</dd>
                </>
              )}
            </dl>
          </div>
          {method !== "username" && messagesAvailable() && <MessageComposer value={draft} onChange={setDraft} disabled={step === "sending"} />}
          <p className="muted small">
            {method === "username" && found ? `Only @${found.recipient.username}'s account can claim it. ` : ""}
            Your money stays protected until they claim it. You can cancel any time before they do. If they never claim it,
            the money comes back to you after 30 days. Free to claim.
          </p>
          <Progress text={progress} />
          {error && <div className="status bad">{error}</div>}
          <button disabled={step === "sending"} onClick={send}>Confirm with fingerprint or screen lock</button>
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

      {step === "done" && amount !== null && method === "username" && found && (
        <div className="stack">
          <div className="status ok">Sent to @{found.recipient.username} ✓</div>
          <p className="muted">
            {formatDollars(amount)} is waiting for {found.recipient.displayName}. They&apos;ll see it on their Everpiece Home and claim it
            with their fingerprint or screen lock. You can cancel from Home until they do.
          </p>
          {!delivered && (
            <p className="muted small">We&apos;re still letting them know. Your money is protected and this retries automatically from Home.</p>
          )}
          <Link className="button" href="/">Done</Link>
        </div>
      )}

      {step === "done" && amount !== null && method !== "username" && (
        <div className="stack">
          <div className="status ok">Payment protected ✓</div>
          <h1>Now send them the link</h1>
          {method === "email" ? (
            <>
              <p className="muted">
                Send this link only to them. They&apos;ll also get a code by email at {email} — you won&apos;t see it.
              </p>
              <div className="status warn">
                Don&apos;t email this link. Send it by WhatsApp, text or in person. The link and the code must travel separately,
                so someone who gets into their inbox can&apos;t claim the money.
              </div>
            </>
          ) : (
            <p className="muted">
              Send this link only to them. They&apos;ll also get a code by text to {cleanPhone} — you won&apos;t see it.
            </p>
          )}
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
