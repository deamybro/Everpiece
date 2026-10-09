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
import { assetSymbol, defaultAsset, enabledAssets, payV2, payV2Available, quoteV2 } from "../../lib/payV2";
import { progressText } from "../../components/status";
import { USDC_MAINNET_ADDRESS } from "@everpiece/shared";
import type { SettlementAsset } from "@everpiece/shared";

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
  /** USDC (default) or AUSD: what the requester receives on an instant request (EverpiecePayV2). */
  const [asset, setAsset] = useState<SettlementAsset | null>(null);
  const [converting, setConverting] = useState("");
  const [converted, setConverted] = useState(false);

  useEffect(() => {
    const a = loadAccount();
    setAccount(a);
    setLoaded(true);
    if (!instantAvailable() && !payV2Available()) setMode(RequestMode.PROTECTED);
    if (payV2Available()) setAsset(defaultAsset() ?? null);
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
      setRequestId(await createRequest(account, amount, mode, 24, mode === RequestMode.INSTANT && asset ? asset.address : undefined));
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
            {paid.kind === "crossChain" && (
              <div className="status ok">Paid ✓ You received {formatDollars(amount ?? 0n)} USDC, sent from a wallet on another chain.</div>
            )}
            {paid.kind === "crossChainUsdc" && (
              <div className="stack">
                <div className="status warn">
                  Paid ✓ You received {formatDollars(amount ?? 0n)} in USDC (it came from another chain, where AUSD isn&apos;t available).
                </div>
                {converted ? (
                  <div className="status ok">Converted ✓ it&apos;s now {formatDollars(amount ?? 0n)} AUSD.</div>
                ) : (
                  <button
                    disabled={converting !== ""}
                    onClick={async () => {
                      if (!account || amount === null || !status) return;
                      setError("");
                      try {
                        // the requester's own signature, on-chain route, exact AUSD to themselves; nothing custodial
                        const q = await quoteV2(USDC_MAINNET_ADDRESS, status.request.asset, amount);
                        if (!q.available) throw new PayError("NO_ROUTE");
                        await payV2(account, { recipient: account.address, asset: status.request.asset, amount, sourceToken: USDC_MAINNET_ADDRESS, quote: q }, (st) => setConverting(progressText(st, "Converting")));
                        setConverted(true);
                      } catch (e) {
                        setError(e instanceof PayError ? friendlyError(e.code) : friendlyPasskeyError(e));
                      } finally {
                        setConverting("");
                      }
                    }}
                  >
                    {converting || `Convert to ${assetSymbol(status!.request.asset)} with fingerprint or screen lock`}
                  </button>
                )}
                {error && <div className="status bad">{error}</div>}
              </div>
            )}
            {paid.kind === "crossChain" || paid.kind === "crossChainUsdc" ? null : paid.kind === "instantV2Fallback" ? (
              <div className="status warn">
                Paid ✓ You received {formatDollars(amount ?? 0n)} in {assetSymbol(enabledAssets().find((a) => a.address !== status?.request.asset)?.address ?? "")}, not{" "}
                {assetSymbol(status!.request.asset)}: the conversion wasn&apos;t available and the payer chose to send their own.
              </div>
            ) : (
              <div className="status ok">
                Paid ✓ You received {formatDollars(amount ?? 0n)}{status ? ` ${assetSymbol(status.request.asset)}` : ""}{paid.kind === "protected" ? " (protected: claim it on Home)" : ""}.
              </div>
            )}
            <Link className="button" href={receiptPath(paid.paymentId)}>View receipt</Link>
            <Link className="button ghost" href="/">Back to Everpiece</Link>
          </>
        ) : (
          <>
            <h1>Show this to the person paying</h1>
            <div className="card center stack">
              <div className="muted">You&apos;ll receive exactly</div>
              <div className="amount">{formatDollars(amount ?? 0n)}{mode === RequestMode.INSTANT && asset ? ` ${asset.symbol}` : ""}</div>
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
            <p className="muted small">
              {mode === RequestMode.INSTANT && asset
                ? `They can pay from USDC or AUSD. You receive exactly this amount in ${asset.symbol}; if they pay from the other one it's converted on-chain first.`
                : "They can pay with Dollars or another supported currency. Either way, you receive exactly this amount in Dollars."}
            </p>
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
      <div className="money">
        <span className="sign" aria-hidden="true">$</span>
        <input className="big" inputMode="decimal" placeholder="0.00" value={amountText} onChange={(e) => setAmountText(e.target.value)} aria-label="Amount to request" />
      </div>
      <div className="row" role="group" aria-label="How it arrives">
        {(instantAvailable() || payV2Available()) && (
          <button className={mode === RequestMode.INSTANT ? "" : "secondary"} aria-pressed={mode === RequestMode.INSTANT} onClick={() => setMode(RequestMode.INSTANT)}>Instant</button>
        )}
        <button className={mode === RequestMode.PROTECTED ? "" : "secondary"} aria-pressed={mode === RequestMode.PROTECTED} onClick={() => setMode(RequestMode.PROTECTED)}>Protected</button>
      </div>
      {mode === RequestMode.INSTANT && payV2Available() && enabledAssets().length > 0 && (
        <div>
          <span className="small muted">Receive in</span>
          <div className="row" role="group" aria-label="Receive in">
            {enabledAssets().map((a) => (
              <button key={a.address} className={asset?.address === a.address ? "" : "secondary"} aria-pressed={asset?.address === a.address} onClick={() => setAsset(a)}>{a.symbol}</button>
            ))}
          </div>
        </div>
      )}
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
