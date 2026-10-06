"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { formatNaira, fromBaseUnits, isFinalPayout, parseNaira, type PayoutState } from "@everpiece/shared";
import { Welcome } from "../../components/Welcome";
import { Progress, progressText } from "../../components/status";
import { PayoutTimeline } from "../../components/PayoutTimeline";
import { StepHint } from "../../components/HowItWorks";
import { dollarsOf, formatDollars } from "../../lib/chain";
import { friendlyError } from "../../lib/api";
import { fundingAvailable } from "../../lib/funding";
import { friendlyPasskeyError, loadAccount, type Account } from "../../lib/mera";
import { PayError } from "../../lib/pay";
import { UsernameError, findRecipient, type Recipient } from "../../lib/username";
import {
  bankAccountOf, bankLine, myBankAccount, nairaEstimate, payoutAvailable, payoutOrder, payoutSimulated, rememberPayout, sendToBank,
  type PublicOrder, type SignedAccount,
} from "../../lib/payout";

const CHIPS = [5_000, 10_000, 20_000, 50_000];
const errText = (e: unknown) => (e instanceof PayError || e instanceof UsernameError ? friendlyError(e.code) : friendlyPasskeyError(e));
type Step = "who" | "amount" | "review" | "paying" | "done";

/** Send naira to a bank account: your own ("cash out") or someone's @username (only to the account THEY signed). */
export default function BankPage() {
  const [account, setAccount] = useState<Account | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [step, setStep] = useState<Step>("who");
  const [mine, setMine] = useState<SignedAccount | null | undefined>(undefined);
  const [target, setTarget] = useState<"me" | "them">("me");
  const [username, setUsername] = useState("");
  const [them, setThem] = useState<{ recipient: Recipient; bank: SignedAccount | null } | null>(null);
  const [amountText, setAmountText] = useState("");
  const [estimate, setEstimate] = useState<{ rate: string; stableAmount: bigint } | null>(null);
  const [balance, setBalance] = useState<bigint | null>(null);
  const [order, setOrder] = useState<PublicOrder | null>(null);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    const a = loadAccount();
    setAccount(a);
    setLoaded(true);
    if (new URLSearchParams(window.location.search).get("to") === "them") setTarget("them");
    if (!a || !payoutAvailable()) return;
    myBankAccount(a).then(setMine).catch(() => setMine(null));
    dollarsOf(a.address).then(setBalance).catch(() => {});
  }, []);

  const kobo = parseNaira(amountText);
  // live "≈ $" while typing (debounced)
  useEffect(() => {
    setEstimate(null);
    if (kobo === null || kobo < 200_000n) return;
    const t = setTimeout(() => nairaEstimate(kobo).then(setEstimate).catch(() => {}), 350);
    return () => clearTimeout(t);
  }, [kobo]);
  // follow the payout to the end
  useEffect(() => {
    if (!order || isFinalPayout(order.state)) return;
    const t = setInterval(() => !document.hidden && payoutOrder(order.orderId).then(setOrder).catch(() => {}), 3000);
    return () => clearInterval(t);
  }, [order]);

  if (!loaded) return null;
  if (!account) return <Welcome onReady={setAccount} title="Create your account first." />;

  const dest = target === "me" ? mine : them?.bank;
  const destName = target === "me" ? "You" : them ? `@${them.recipient.username}` : "";
  const enough = estimate && balance !== null ? balance >= estimate.stableAmount : true;

  async function find() {
    setBusy(true);
    setError("");
    setThem(null);
    try {
      const { recipient } = await findRecipient(username);
      if (recipient.account === account!.address) throw new PayError("CannotPaySelf");
      setThem({ recipient, bank: await bankAccountOf(recipient.account) });
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  }
  async function pay() {
    if (!account || !dest || kobo === null) return;
    setBusy(true);
    setError("");
    setStep("paying");
    try {
      const o = await sendToBank(account, dest.record.account, kobo, (s) => setProgress(s === "ORDERING" ? "Getting the bank transfer ready…" : progressText(s, "Paying")));
      rememberPayout({ key: o.orderId, role: target === "me" ? "cashout" : "sent", orderId: o.orderId, kobo: kobo.toString(), to: bankLine(dest), who: target === "me" ? undefined : destName, at: Date.now() });
      setOrder({ ...o, state: "PAYOUT_FUNDED", history: [...(o.history ?? []), { state: "PAYOUT_FUNDED" as PayoutState, at: Date.now() }] });
      setStep("done");
    } catch (e) {
      setError(errText(e));
      setStep("review");
    } finally {
      setBusy(false);
      setProgress("");
    }
  }

  const header = (
    <div className="row">
      <Link href="/" className="brand">Everpiece</Link>
      <Link href="/" className="muted small">{step === "done" ? "Done" : "Cancel"}</Link>
    </div>
  );
  if (!payoutAvailable()) return <div className="stack">{header}<div className="status warn">Bank payouts aren&apos;t available here yet.</div></div>;
  const sim = payoutSimulated() && <div className="dev">Simulated bank payout: this test site never pays a real bank.</div>;
  const bankCard = dest && (
    <div className="bank-card" aria-label="Destination">
      <span className="muted small">{target === "me" ? "Your bank account" : `${destName}'s bank account`}</span>
      <strong>{bankLine(dest)}</strong>
      <span className="muted small">Verified name: {dest.record.accountName}</span>
    </div>
  );

  if (step === "done" && order && kobo !== null) {
    const delivered = order.state === "DELIVERED";
    return (
      <div className="stack">
        {header}
        {sim}
        <div className="card center stack">
          <div className="muted">{target === "me" ? "Cashing out" : `Sending to ${destName}`}</div>
          <div className="amount">{formatNaira(kobo)}</div>
          <div className="muted small">at least, to {dest ? bankLine(dest) : "the bank"}</div>
        </div>
        <PayoutTimeline state={order.state} history={order.history} />
        {!isFinalPayout(order.state) && <p className="muted small">We only say &quot;Delivered&quot; when the payout provider confirms the bank transfer. You can leave this page; it&apos;s on Home too.</p>}
        {order.state === "REFUNDED" && <div className="status bad">The bank transfer failed, so you were refunded.</div>}
        <Link className={`button${delivered ? "" : " secondary"}`} href="/">Back to Everpiece</Link>
      </div>
    );
  }

  if ((step === "review" || step === "paying") && dest && kobo !== null) {
    return (
      <div className="stack">
        {header}
        {sim}
        <StepHint step={3} of={3} />
        <h1>Check and pay</h1>
        <div className="card center stack">
          <div className="muted">{destName} {target === "me" ? "receive" : "receives"} at least</div>
          <div className="amount">{formatNaira(kobo)}</div>
        </div>
        {bankCard}
        <div className="card review">
          <dl aria-label="Payment summary">
            <dt>You pay</dt>
            <dd>{estimate ? `about ${formatDollars(estimate.stableAmount)}` : "…"}</dd>
            <dt>Rate</dt>
            <dd>{estimate ? `₦${Number(estimate.rate).toLocaleString("en-NG")} per Dollar` : "…"}</dd>
            <dt>Network fee</dt>
            <dd>$0.00 (paid by Everpiece)</dd>
            <dt>If the bank transfer fails</dt>
            <dd>you&apos;re refunded</dd>
          </dl>
          <p className="muted small">The price includes a small buffer and the payout provider&apos;s fee, so the bank receives at least {formatNaira(kobo)}.</p>
        </div>
        <Progress text={progress} />
        {error && <div className="status bad">{error}</div>}
        <button disabled={busy || !estimate || !enough} onClick={pay}>Pay with fingerprint or screen lock</button>
        <button className="ghost" disabled={busy} onClick={() => setStep("amount")}>Change amount</button>
      </div>
    );
  }

  if (step === "amount" && dest) {
    return (
      <div className="stack">
        {header}
        {sim}
        <StepHint step={2} of={3} />
        <h1>How much should arrive?</h1>
        {bankCard}
        <div className="money">
          <span className="sign" aria-hidden="true">₦</span>
          <input className="big" inputMode="decimal" placeholder="0" value={amountText} onChange={(e) => setAmountText(e.target.value)}
            onBlur={() => setAmountText((t) => { const k = parseNaira(t); return k === null ? t : formatNaira(k).slice(1); })} aria-label="Naira to send" />
        </div>
        <div className="chips" role="group" aria-label="Quick amounts">
          {CHIPS.map((n) => (
            <button key={n} className="secondary" onClick={() => setAmountText(n.toLocaleString("en-NG"))}>{formatNaira(BigInt(n) * 100n)}</button>
          ))}
        </div>
        <div className="estimate" aria-live="polite">
          {estimate ? `≈ ${formatDollars(estimate.stableAmount)} from your Dollars` : kobo !== null && kobo >= 200_000n ? "Getting the rate…" : ""}
        </div>
        {balance !== null && <p className="muted small center">You have {formatDollars(balance)}</p>}
        {!enough && estimate && balance !== null && (
          <div className="status warn">
            You don&apos;t have enough Dollars for this.{" "}
            {fundingAvailable() && <Link href={`/add?amount=${fromBaseUnits(estimate.stableAmount - balance + 1_000_000n, 6)}`}>Add money</Link>}
          </div>
        )}
        <button disabled={kobo === null || kobo < 200_000n || !estimate || !enough} onClick={() => setStep("review")}>Continue</button>
        {kobo !== null && kobo < 200_000n && <p className="muted small center">The minimum is ₦2,000.</p>}
      </div>
    );
  }

  return (
    <div className="stack">
      {header}
      {sim}
      <StepHint step={1} of={3} />
      <h1>Send naira to a bank</h1>
      <div className="stack" role="radiogroup" aria-label="Whose bank">
        <label className={`choice${target === "me" ? " selected" : ""}`}>
          <input type="radio" name="target" checked={target === "me"} onChange={() => setTarget("me")} />
          <span><strong>My bank account</strong><span className="muted small"> · cash out your Dollars</span></span>
        </label>
        <label className={`choice${target === "them" ? " selected" : ""}`}>
          <input type="radio" name="target" checked={target === "them"} onChange={() => setTarget("them")} />
          <span><strong>Someone&apos;s bank account</strong><span className="muted small"> · by their @username</span></span>
        </label>
      </div>

      {target === "me" && mine === undefined && <Progress text="Checking your bank account…" />}
      {target === "me" && mine === null && (
        <div className="stack">
          <p className="muted">Add your Nigerian bank account first. It&apos;s verified with your bank and saved with your fingerprint.</p>
          <Link className="button" href="/receive">Add my bank account</Link>
        </div>
      )}
      {target === "me" && mine && (
        <>
          {bankCard}
          <button onClick={() => setStep("amount")}>Continue</button>
        </>
      )}

      {target === "them" && (
        <div className="stack">
          <div className="row">
            <input aria-label="Their Everpiece username" placeholder="@username" autoCapitalize="none" spellCheck={false} value={username}
              onChange={(e) => { setUsername(e.target.value); setThem(null); }} />
            <button className="secondary fit" disabled={busy || !username.trim()} onClick={find}>Find</button>
          </div>
          {them && !them.bank && (
            <div className="status warn">@{them.recipient.username} hasn&apos;t added a bank account. You can <Link href="/send">send them Dollars</Link> instead.</div>
          )}
          {them?.bank && (
            <>
              {bankCard}
              <button onClick={() => setStep("amount")}>Continue</button>
            </>
          )}
        </div>
      )}
      {error && <div className="status bad">{error}</div>}
    </div>
  );
}
