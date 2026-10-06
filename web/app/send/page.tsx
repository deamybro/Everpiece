"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { E164, fromBaseUnits, normalizeEmail } from "@everpiece/shared";
import { fundingAvailable } from "../../lib/funding";
import { Welcome } from "../../components/Welcome";
import { Progress, progressText } from "../../components/status";
import { MessageComposer, type Draft } from "../../components/MessageComposer";
import { messagesAvailable, seconds } from "../../lib/message";
import { StepHint, day } from "../../components/HowItWorks";
import { receiptPath } from "../../lib/receipt";
import type { Hex } from "viem";
import { dollarsOf, formatDollars, parseDollars } from "../../lib/chain";
import { friendlyError } from "../../lib/api";
import { claimLink } from "../../lib/link";
import { FlowError, sendByLink, sendToUsername } from "../../lib/flows";
import { friendlyPasskeyError, loadAccount, type Account } from "../../lib/mera";
import { UsernameError, findRecipient, pin, type Pinning, type Recipient } from "../../lib/username";
import { PayError, instantAvailable, payInstant, payTokens } from "../../lib/pay";

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
  const [sentId, setSentId] = useState<Hex | null>(null);
  /** @username sends: instant by default (owner, 2026-10-06: "it's supposed to send asap"); protected on request. */
  const [speed, setSpeed] = useState<"instant" | "protected">("instant");
  const [sentInstant, setSentInstant] = useState(false);

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
  // @username recipients can get messages once they've published a (self-signed) message key.
  const canMessage = messagesAvailable() && (method !== "username" || !!found?.recipient.messageKey);
  const withMessage = canMessage && (note !== "" || draft.voice !== null);
  // a message travels with the escrow's on-chain commitment, so a payment with one is always protected
  const isInstant = method === "username" && speed === "instant" && instantAvailable() && !withMessage;

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
    const message = withMessage
      ? { note, audio: draft.voice ? { bytes: draft.voice.bytes, type: draft.voice.type, durationMs: draft.voice.durationMs } : undefined }
      : undefined;
    if (method === "username") {
      if (!found) return;
      if (isInstant) {
        try {
          const dollars = payTokens().find((t) => t.route === "DIRECT_AUSD");
          if (!dollars) throw new PayError("InstantPaymentsUnavailable");
          const r = await payInstant(account, { recipient: found.recipient.account, amount, token: dollars }, (s) => setProgress(progressText(s, "Sending")));
          pin(found.recipient); // same "you've paid them before" protection as protected sends
          setSentId(r.paymentId);
          setSentInstant(true);
          setStep("done");
        } catch (e) {
          setError(e instanceof PayError || e instanceof FlowError ? friendlyError(e.code) : friendlyPasskeyError(e));
          setStep("review");
        } finally {
          setProgress("");
        }
        return;
      }
      try {
        const r = await sendToUsername(account, amount, found.recipient, (s) => setProgress(progressText(s, "Sending")), message);
        setDelivered(r.delivered);
        setSentId(r.paymentId);
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
      const { paymentId, pkg } = await sendByLink(account, amount, to, (s) => setProgress(progressText(s, "Protecting your payment")), message);
      setLink(claimLink(paymentId, pkg));
      setSentId(paymentId);
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
          <StepHint step={1} of={3} />
          <h1>How much?</h1>
          <div className="money">
            <span className="sign" aria-hidden="true">$</span>
            <input className="big" inputMode="decimal" placeholder="0.00" value={amountText} onChange={(e) => setAmountText(e.target.value)} aria-label="Amount in Dollars" />
          </div>
          {balance !== null && <p className="muted center">You have {formatDollars(balance)}</p>}
          {amount !== null && balance !== null && amount > balance && (
            <div className="status bad">
              You don&apos;t have enough Dollars for this.{" "}
              {fundingAvailable() && <Link href={`/add?amount=${fromBaseUnits(amount - balance, 6)}&return=/send`}>Add money from another chain</Link>}
            </div>
          )}
          <button disabled={amount === null || amount < 1_000_000n || (balance !== null && amount > balance)} onClick={() => setStep("who")}>
            Continue
          </button>
          {amount !== null && amount < 1_000_000n && <p className="muted small center">The minimum is $1.00.</p>}
        </div>
      )}

      {step === "who" && (
        <div className="stack">
          <StepHint step={2} of={3} />
          <h1>Who is it for?</h1>
          <div className="row" role="group" aria-label="Send to">
            <button className={method === "phone" ? "" : "secondary"} aria-pressed={method === "phone"} onClick={() => setMethod("phone")}>Phone</button>
            <button className={method === "email" ? "" : "secondary"} aria-pressed={method === "email"} onClick={() => setMethod("email")}>Email</button>
            <button className={method === "username" ? "" : "secondary"} aria-pressed={method === "username"} onClick={() => setMethod("username")}>@username</button>
          </div>
          {method === "email" && (
            <>
              <p className="muted">
                You&apos;ll get a link to send them (by WhatsApp or text, <strong>not</strong> by email). We&apos;ll email them a code. They
                need both to claim it, so it can&apos;t end up with the wrong person.
              </p>
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
              <p className="muted">
                You&apos;ll get a link to send them (by WhatsApp or text). We&apos;ll text them a code. They need both to claim it, so it
                can&apos;t end up with the wrong person, even if the link is forwarded.
              </p>
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
              <p className="muted">For people who already use Everpiece. It goes straight to their account: no link, no code. Only they can claim it.</p>
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
          <StepHint step={3} of={3} />
          <h1>Check and send</h1>
          {method === "username" && found && instantAvailable() && (
            <>
              <div className="row" role="group" aria-label="How it arrives">
                <button className={speed === "instant" ? "" : "secondary"} aria-pressed={speed === "instant"} onClick={() => setSpeed("instant")} disabled={step === "sending"}>Instant</button>
                <button className={speed === "protected" ? "" : "secondary"} aria-pressed={speed === "protected"} onClick={() => setSpeed("protected")} disabled={step === "sending"}>Protected</button>
              </div>
              <p className="muted small">
                {withMessage && speed === "instant"
                  ? "Payments with a message are protected: they claim it, and you can cancel until then."
                  : speed === "instant"
                    ? "Instant: it's in their balance straight away. Final, like handing over cash."
                    : "Protected: they claim it with their fingerprint, and you can cancel until then."}
              </p>
            </>
          )}
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
              {isInstant ? (
                <>
                  <dt>Arrives</dt>
                  <dd>Instantly · final</dd>
                </>
              ) : (
                <>
                  <dt>Expires</dt>
                  <dd>in 30 days ({day(Math.floor(Date.now() / 1000) + 30 * 86_400)})</dd>
                </>
              )}
              {withMessage && (
                <>
                  <dt>Message</dt>
                  <dd>{[draft.voice && `Voice note ${seconds(draft.voice.durationMs)}`, note && "Written note"].filter(Boolean).join(" + ")}</dd>
                </>
              )}
            </dl>
          </div>
          {canMessage && (
            <MessageComposer
              value={draft} onChange={setDraft} disabled={step === "sending"}
              audience={method === "username" && found ? `Only @${found.recipient.username}'s account can open it.` : "Only someone with the link can open it."}
            />
          )}
          {method === "username" && found && messagesAvailable() && !found.recipient.messageKey && (
            <p className="muted small">@{found.recipient.username} hasn&apos;t turned on voice messages yet, so this payment can&apos;t carry one.</p>
          )}
          <div className="card stack" aria-label="What happens next">
            <strong>What happens next</strong>
            {isInstant && found ? (
              <ol className="steps">
                <li>The money goes straight into @{found.recipient.username}&apos;s balance. Only their account receives it.</li>
                <li>It&apos;s final: you can&apos;t cancel an instant payment, so check the name above.</li>
              </ol>
            ) : (
            <ol className="steps">
              <li>The money leaves your balance and is held safely. It isn&apos;t theirs yet.</li>
              {method === "username" && found ? (
                <li>@{found.recipient.username} sees it on their Everpiece Home and claims it with their fingerprint or screen lock. Only their account can.</li>
              ) : (
                <>
                  <li>You send them the link we give you on the next screen.</li>
                  <li>They open it and enter the code we {method === "email" ? "email" : "text"} them. Then it&apos;s theirs. Free to claim.</li>
                </>
              )}
              <li>Until they claim it, you can cancel from Home and get every cent back. If it isn&apos;t claimed in 30 days, it comes back by itself.</li>
            </ol>
            )}
          </div>
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

      {step === "done" && amount !== null && method === "username" && found && sentInstant && (
        <div className="stack">
          <div className="status ok">Sent to @{found.recipient.username} ✓</div>
          <p className="muted">{formatDollars(amount)} is in {found.recipient.displayName}&apos;s balance now. Instant payments are final.</p>
          <Link className="button" href="/">Done</Link>
          {sentId && <Link className="button ghost" href={receiptPath(sentId)}>View receipt</Link>}
        </div>
      )}

      {step === "done" && amount !== null && method === "username" && found && !sentInstant && (
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
          {sentId && <Link className="button ghost" href={receiptPath(sentId)}>View receipt</Link>}
        </div>
      )}

      {step === "done" && amount !== null && method !== "username" && (
        <div className="stack">
          <div className="status ok">Payment protected ✓</div>
          <h1>Now send them the link</h1>
          <ol className="steps" aria-label="How they get it">
            <li><strong>Send them this link</strong> with one of the buttons below. Only to them.</li>
            <li>
              When they open it, we {method === "email" ? <>email a code to {email}</> : <>text a code to {cleanPhone}</>}. You won&apos;t
              see the code.
            </li>
            <li>They enter the code and the money is theirs. Until then, you can still cancel from Home.</li>
          </ol>
          {method === "email" && (
            <div className="status warn">
              Don&apos;t email this link. Send it by WhatsApp, text or in person. The link and the code must travel separately,
              so someone who gets into their inbox can&apos;t claim the money.
            </div>
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
          {sentId && <Link className="button secondary" href={receiptPath(sentId)}>View receipt</Link>}
          <Link className="button ghost" href="/">Done</Link>
        </div>
      )}
    </div>
  );
}
