"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { getAddress, isAddress, type Address } from "viem";
import { fromBaseUnits, isFinalFunding, type FundingPhase, type FundingSource, type TokenInfo } from "@everpiece/shared";
import { Welcome } from "../../components/Welcome";
import { QrCode } from "../../components/QrCode";
import { StepHint } from "../../components/HowItWorks";
import { Progress, progressText } from "../../components/status";
import { formatDollars, parseDollars } from "../../lib/chain";
import { friendlyError } from "../../lib/api";
import { friendlyPasskeyError, loadAccount, type Account } from "../../lib/mera";
import { PayError, balanceOfToken } from "../../lib/pay";
import {
  activeTopUps, convertToDollars, fundingAvailable, fundingMode, loadSources, plan, quoteTopUp, reportDeposit, saveTopUp,
  simulatedDepositHash, topUpStatus, type TopUp, type TopUpQuote,
} from "../../lib/funding";

const errText = (e: unknown) => (e instanceof PayError ? friendlyError(e.code) : friendlyPasskeyError(e));
const units = (v: bigint, s: FundingSource) => `${fromBaseUnits(v, s.decimals)} ${s.symbol}`;
const PHASE_TEXT: Record<FundingPhase, string> = {
  WAITING_FOR_DEPOSIT: "Waiting for your deposit…",
  DEPOSIT_TOO_SMALL: "The deposit was less than needed. Send the rest before the deadline, or it will be refunded to your wallet.",
  MOVING: "Deposit received. Moving it to Monad…",
  ARRIVED: "It's arrived in your Everpiece account.",
  REFUNDED: "This top-up was refunded to your wallet on the other chain.",
  FAILED: "This top-up failed. Anything you sent will be refunded to your wallet on the other chain.",
};

type Step = "amount" | "quote" | "deposit" | "convert" | "done";

/** "Add Dollars from another chain": USDC elsewhere → Aurora → USDC in my Everpiece account → exact Dollars (one prompt). */
export default function AddPage() {
  const [account, setAccount] = useState<Account | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [sources, setSources] = useState<FundingSource[]>([]);
  const [destination, setDestination] = useState<TokenInfo | null>(null);
  const [origin, setOrigin] = useState<FundingSource | null>(null);
  const [amountText, setAmountText] = useState("");
  const [refundTo, setRefundTo] = useState("");
  const [returnTo, setReturnTo] = useState<string | undefined>();
  const [step, setStep] = useState<Step>("amount");
  const [quote, setQuote] = useState<TopUpQuote | null>(null);
  const [topUp, setTopUp] = useState<TopUp | null>(null);
  const [phase, setPhase] = useState<FundingPhase>("WAITING_FOR_DEPOSIT");
  const [txHash, setTxHash] = useState("");
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState("");
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);
  /** Aurora delivered but Agora settlement failed: the intermediate asset sitting safely in this account (never reversed). */
  const [heldAfterFailure, setHeldAfterFailure] = useState<bigint | null>(null);
  const simulated = fundingMode() === "simulated";

  useEffect(() => {
    setAccount(loadAccount());
    setLoaded(true);
    const q = new URLSearchParams(window.location.search);
    const a = q.get("amount");
    if (a && parseDollars(a) !== null) setAmountText(a);
    const r = q.get("return");
    if (r && /^\/(pay|payout)\/0x[0-9a-f]{64}$|^\/send$/.test(r)) setReturnTo(r); // only our own pages
    if (!fundingAvailable()) return;
    loadSources()
      .then((s) => {
        setSources(s.sources);
        setDestination(s.destination);
        setOrigin(s.sources[0] ?? null);
      })
      .catch((e) => setError(errText(e)));
    // an unfinished top-up on this device resumes where it was
    const open = activeTopUps()[0];
    if (open) {
      setTopUp(open);
      setReturnTo(open.returnTo);
      setPhase(open.phase ?? "WAITING_FOR_DEPOSIT");
      setStep(open.phase === "ARRIVED" ? "convert" : "deposit");
    }
  }, []);

  const dollars = parseDollars(amountText);

  async function getPrice() {
    if (!account || !origin || !destination || dollars === null) return;
    if (!isAddress(refundTo.trim())) return setError("Enter your wallet address on " + origin.chainLabel + " (it starts with 0x).");
    setBusy(true);
    setError("");
    try {
      const p = await plan(account, dollars, destination);
      if (p.needed === 0n) {
        // already enough in the account (e.g. an earlier top-up): straight to converting
        const t: TopUp = { depositAddress: "0x0000000000000000000000000000000000000000", dollars: dollars.toString(), origin, amountIn: "0", deadline: "", createdAt: Date.now(), returnTo, phase: "ARRIVED" };
        setTopUp(t);
        setPhase("ARRIVED");
        setStep("convert");
        return;
      }
      setQuote(await quoteTopUp(origin, p.needed, account.address, getAddress(refundTo.trim()) as Address));
      setStep("quote");
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  }

  function accept() {
    if (!quote || !origin || dollars === null) return;
    const t: TopUp = {
      depositAddress: quote.depositAddress, dollars: dollars.toString(), origin, amountIn: quote.amountIn.toString(), deadline: quote.deadline,
      createdAt: Date.now(), returnTo, phase: "WAITING_FOR_DEPOSIT",
    };
    saveTopUp(t);
    setTopUp(t);
    setPhase("WAITING_FOR_DEPOSIT");
    setStep("deposit");
  }

  const track = useCallback((t: TopUp, p: FundingPhase) => {
    setPhase(p);
    saveTopUp({ ...t, phase: p, done: p === "REFUNDED" || p === "FAILED" ? true : t.done });
    if (p === "ARRIVED") setStep("convert");
  }, []);

  // follow the deposit until it arrives, is refunded or fails
  useEffect(() => {
    if (step !== "deposit" || !topUp || isFinalFunding(phase)) return;
    const tick = () => topUpStatus(topUp.depositAddress).then((p) => track(topUp, p)).catch(() => {});
    tick();
    const t = setInterval(tick, 5000);
    return () => clearInterval(t);
  }, [step, topUp, phase, track]);

  async function sendTxHash(hash: string) {
    if (!topUp) return;
    setError("");
    try {
      track(topUp, await reportDeposit(topUp.depositAddress, hash));
    } catch (e) {
      setError(errText(e));
    }
  }

  async function convert() {
    if (!account || !destination || !topUp) return;
    setBusy(true);
    setError("");
    try {
      await convertToDollars(account, BigInt(topUp.dollars), destination, (s) => setProgress(progressText(s, "Converting to Dollars with Agora")));
      saveTopUp({ ...topUp, done: true });
      setHeldAfterFailure(null);
      setStep("done");
    } catch (e) {
      // docs/ROUTING.md §5: the delivered asset stays in the payer's own account; nothing is sent back automatically.
      setError(errText(e));
      setHeldAfterFailure(await balanceOfToken(destination.address, account.address).catch(() => null));
    } finally {
      setBusy(false);
      setProgress("");
    }
  }

  if (!loaded) return null;
  if (!account) return <Welcome onReady={setAccount} title="Create your account to add money." />;

  const header = (
    <div className="row">
      <Link href="/" className="brand">Everpiece</Link>
      <Link href="/" className="muted small">{step === "done" ? "Done" : "Cancel"}</Link>
    </div>
  );
  if (!fundingAvailable()) {
    return <div className="stack">{header}<div className="status warn">{friendlyError("FUNDING_UNAVAILABLE")}</div></div>;
  }
  const simBanner = simulated && (
    <div className="dev">Simulated cross-chain transfer: this test site doesn&apos;t receive real USDC. You&apos;ll get test tokens instead.</div>
  );

  if (step === "done" && topUp) {
    return (
      <div className="stack">
        {header}
        <div className="status ok">Added {formatDollars(BigInt(topUp.dollars))} ✓ It&apos;s in your Dollars now.</div>
        {topUp.returnTo ? (
          <Link className="button" href={topUp.returnTo}>Continue to your payment</Link>
        ) : (
          <Link className="button" href="/">Back to Everpiece</Link>
        )}
      </div>
    );
  }

  if (step === "convert" && topUp) {
    return (
      <div className="stack">
        {header}
        {simBanner}
        <StepHint step={3} of={3} />
        <h1>Turn it into Dollars</h1>
        <div className="status ok">{PHASE_TEXT.ARRIVED}</div>
        <p className="muted">One fingerprint converts it to exactly <strong>{formatDollars(BigInt(topUp.dollars))}</strong> through Agora. If anything goes wrong, it simply stays in your account and you can try again.</p>
        <Progress text={progress} />
        {error && <div className="status bad">{error}</div>}
        {error && (
          <div className="status warn" aria-label="Where your money is">
            The conversion to Dollars didn&apos;t go through, but your money is safe:{" "}
            {heldAfterFailure !== null ? <strong>{fromBaseUnits(heldAfterFailure, destination!.decimals)} {destination!.symbol}</strong> : `your ${destination?.symbol ?? "funds"}`}{" "}
            is in your own Everpiece account. Nothing is sent back automatically. Try converting again later; it also counts toward your next top-up.
          </div>
        )}
        <button disabled={busy} onClick={convert}>Convert to {formatDollars(BigInt(topUp.dollars))} with fingerprint or screen lock</button>
      </div>
    );
  }

  if (step === "deposit" && topUp) {
    const final = isFinalFunding(phase);
    return (
      <div className="stack">
        {header}
        {simBanner}
        <StepHint step={2} of={3} />
        <h1>Send {fromBaseUnits(BigInt(topUp.amountIn), topUp.origin.decimals)} {topUp.origin.symbol} on {topUp.origin.chainLabel}</h1>
        <div className="card center stack">
          <QrCode value={topUp.depositAddress} label="Deposit address QR code" />
          <code className="small" aria-label="Deposit address">{topUp.depositAddress}</code>
          <button className="secondary" onClick={() => navigator.clipboard.writeText(topUp.depositAddress).then(() => setCopied(true)).catch(() => {})}>
            {copied ? "Address copied ✓" : "Copy address"}
          </button>
        </div>
        <ul className="muted small">
          <li>Send <strong>only {topUp.origin.symbol} on {topUp.origin.chainLabel.replace(" (simulated)", "")}</strong>, from your own wallet. Another token or network may be lost.</li>
          <li>Send at least the amount shown before {topUp.deadline ? new Date(topUp.deadline).toLocaleTimeString() : "the deadline"}. Too little, or too late, is refunded to your wallet.</li>
          <li>Anything more than needed is refunded to your wallet after the transfer.</li>
        </ul>
        {final ? <div className="status bad">{PHASE_TEXT[phase]}</div> : <Progress text={PHASE_TEXT[phase]} />}
        {phase === "DEPOSIT_TOO_SMALL" && <div className="status warn">{PHASE_TEXT.DEPOSIT_TOO_SMALL}</div>}
        {error && <div className="status bad">{error}</div>}
        {!final && simulated && phase === "WAITING_FOR_DEPOSIT" && (
          <button onClick={() => sendTxHash(simulatedDepositHash())}>Simulate the deposit (test only)</button>
        )}
        {!final && !simulated && phase === "WAITING_FOR_DEPOSIT" && (
          <div>
            <label htmlFor="tx">Sent it? Paste the transaction hash to speed things up (optional)</label>
            <input id="tx" autoCapitalize="none" spellCheck={false} placeholder="0x…" value={txHash} onChange={(e) => setTxHash(e.target.value.trim())} />
            <button className="secondary" disabled={!/^0x[0-9a-fA-F]{64}$/.test(txHash)} onClick={() => sendTxHash(txHash)}>I&apos;ve sent it</button>
          </div>
        )}
        {final && <Link className="button secondary" href="/add" onClick={() => saveTopUp({ ...topUp, done: true })}>Start again</Link>}
      </div>
    );
  }

  if (step === "quote" && quote && origin && dollars !== null) {
    const fee = quote.amountInUsd && quote.amountOutUsd ? Math.max(0, Number(quote.amountInUsd) - Number(quote.amountOutUsd)) : null;
    return (
      <div className="stack">
        {header}
        {simBanner}
        <StepHint step={1} of={3} />
        <h1>Check the price</h1>
        <div className="card review">
          <dl aria-label="Top-up summary">
            <dt>You send</dt>
            <dd>{units(quote.amountIn, origin)} on {origin.chainLabel}</dd>
            <dt>You get</dt>
            <dd>{formatDollars(dollars)} in Dollars</dd>
            <dt>Moved by</dt>
            <dd>Aurora Intents, then converted by Agora</dd>
            <dt>Fees</dt>
            <dd>{fee !== null ? `about $${fee.toFixed(2)} (Aurora; Everpiece adds nothing)` : "included in the amount you send"}</dd>
            <dt>Refunds go to</dt>
            <dd><code className="small">{getAddress(refundTo.trim())}</code></dd>
            <dt>Takes about</dt>
            <dd>{quote.timeEstimateSec > 0 ? `${Math.ceil(quote.timeEstimateSec / 60)} min` : "a few minutes"}</dd>
          </dl>
          <p className="muted small">The amount you send includes a small buffer; anything not used is refunded to your wallet.</p>
        </div>
        <button onClick={accept}>Show me where to send it</button>
        <button className="ghost" onClick={() => setStep("amount")}>Change</button>
      </div>
    );
  }

  return (
    <div className="stack">
      {header}
      {simBanner}
      <StepHint step={1} of={3} />
      <h1>Add Dollars from another chain</h1>
      <p className="muted">Pay with USDC you hold on another network. It arrives as Dollars in your Everpiece account.</p>
      <div className="money">
        <span className="sign" aria-hidden="true">$</span>
        <input className="big" inputMode="decimal" placeholder="0.00" value={amountText} onChange={(e) => setAmountText(e.target.value)} aria-label="Dollars to add" />
      </div>
      <h2>Pay from</h2>
      <div className="stack" role="radiogroup" aria-label="Pay from">
        {sources.map((s) => (
          <label key={s.assetId} className={`choice${origin?.assetId === s.assetId ? " selected" : ""}`}>
            <input type="radio" name="origin" checked={origin?.assetId === s.assetId} onChange={() => setOrigin(s)} />
            <span><strong>{s.symbol} on {s.chainLabel}</strong></span>
          </label>
        ))}
      </div>
      <div>
        <label htmlFor="refund">Your wallet address on {origin?.chainLabel.replace(" (simulated)", "") ?? "that network"}</label>
        <input id="refund" autoCapitalize="none" spellCheck={false} placeholder="0x…" value={refundTo} onChange={(e) => setRefundTo(e.target.value)} />
        <p className="muted small">The wallet you&apos;ll send from. If anything goes wrong, the money is refunded there.</p>
      </div>
      {error && <div className="status bad">{error}</div>}
      <button disabled={busy || !origin || dollars === null || dollars < 1_000_000n || !refundTo.trim()} onClick={getPrice}>
        {busy ? "Getting a price…" : "See the price"}
      </button>
      {dollars !== null && dollars < 1_000_000n && <p className="muted small center">The minimum is $1.00.</p>}
    </div>
  );
}
