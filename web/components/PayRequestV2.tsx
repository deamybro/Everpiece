"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import type { Hex } from "viem";
import { fromBaseUnits, type SettlementAsset } from "@everpiece/shared";
import { Welcome } from "./Welcome";
import { Progress, progressText } from "./status";
import { config } from "../lib/config";
import { formatDollars } from "../lib/chain";
import { friendlyError } from "../lib/api";
import { friendlyPasskeyError, loadAccount, type Account } from "../lib/mera";
import { PayError, reportPaid, type LoadedRequest } from "../lib/pay";
import { assetBalances, assetSymbol, payV2, quoteV2, type PayV2Result, type QuoteV2 } from "../lib/payV2";
import { receiptPath } from "../lib/receipt";
import { externalPayAvailable, fundingAvailable } from "../lib/funding";
import { ExternalPay } from "./ExternalPay";

const errText = (e: unknown) => (e instanceof PayError ? friendlyError(e.code) : friendlyPasskeyError(e));

/**
 * Pay an INSTANT request in USDC or AUSD (EverpiecePayV2). The recipient chose the asset; the payer pays from either.
 * Same asset = direct. Other asset = converted on-chain with a live quote; if conversion is unavailable the payer may
 * explicitly send their own asset instead, and the outcome screen reports what was actually delivered.
 */
export function PayRequestV2({ loaded, requestId }: { loaded: LoadedRequest; requestId: Hex }) {
  const { request, recipient } = loaded;
  const [account, setAccount] = useState<Account | null>(() => loadAccount());
  const [assets, setAssets] = useState<{ asset: SettlementAsset; balance: bigint }[]>([]);
  const [src, setSrc] = useState<SettlementAsset | null>(null);
  const [quote, setQuote] = useState<QuoteV2 | null>(null);
  const [quoting, setQuoting] = useState(false);
  const [allowFallback, setAllowFallback] = useState(false);
  const [paying, setPaying] = useState(false);
  const [progress, setProgress] = useState("");
  const [error, setError] = useState("");
  const [result, setResult] = useState<PayV2Result | null>(null);
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  const want = assetSymbol(request.asset);
  /** Pay from any wallet on another chain, no Everpiece account (Aurora delivers USDC to the requester). */
  const [external, setExternal] = useState(false);

  useEffect(() => {
    if (!account) return;
    assetBalances(account.address).then((list) => {
      setAssets(list);
      // default: pay in the asked asset if the payer has enough, else whatever covers it
      const same = list.find((x) => x.asset.address === request.asset);
      const enough = list.find((x) => x.balance >= request.amount);
      setSrc((same && same.balance >= request.amount ? same : enough ?? same ?? list[0])?.asset ?? null);
    }).catch(() => {});
  }, [account, request.asset, request.amount]);

  const refresh = useCallback(async (s: SettlementAsset) => {
    setQuote(null);
    setError("");
    if (s.address === request.asset) return;
    setQuoting(true);
    try {
      setQuote(await quoteV2(s.address, request.asset, request.amount));
    } catch (e) {
      setError(errText(e));
    } finally {
      setQuoting(false);
    }
  }, [request.asset, request.amount]);

  useEffect(() => {
    if (src) void refresh(src);
  }, [src, refresh]);
  useEffect(() => {
    const t = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000);
    return () => clearInterval(t);
  }, []);
  useEffect(() => {
    if (quote && src && !paying && quote.expiresAt - now <= 5) void refresh(src);
  }, [now, quote, src, paying, refresh]);

  const header = (
    <div className="row">
      <Link href="/" className="brand">Everpiece</Link>
      <span className="muted small">Pay a request</span>
    </div>
  );
  const card = (
    <div className="card center stack">
      <div className="muted">Pay @{recipient.username} ({recipient.displayName})</div>
      <div className="amount">{formatDollars(request.amount)} {want}</div>
      <div className="muted small">{recipient.displayName} asked for exactly {formatDollars(request.amount)} {want}</div>
    </div>
  );

  if (external) {
    return (
      <div className="stack">
        {header}
        {card}
        <ExternalPay loaded={loaded} />
        <button className="ghost" onClick={() => setExternal(false)}>Back</button>
      </div>
    );
  }
  if (!account) {
    return (
      <div className="stack">
        {header}
        {card}
        {externalPayAvailable() && (
          <button className="secondary" onClick={() => setExternal(true)}>Pay from any wallet, no account needed</button>
        )}
        <Welcome onReady={setAccount} title="Or create your account to pay." />
      </div>
    );
  }

  if (result) {
    const got = assetSymbol(result.deliveredAsset);
    return (
      <div className="stack">
        {header}
        <div className={`status ${result.fellBack ? "warn" : "ok"}`}>
          {result.fellBack
            ? `Paid in ${got}: converting to ${want} wasn't available, so ${recipient.displayName} received exactly ${formatDollars(request.amount)} ${got}, as you allowed.`
            : `Paid ✓ ${recipient.displayName} received exactly ${formatDollars(request.amount)} ${got}.`}
        </div>
        <p className="muted small">
          Instant payments are final.{" "}
          {result.payment.sourceToken !== result.deliveredAsset && `You paid ${formatDollars(result.sourceSpent)} ${assetSymbol(result.payment.sourceToken)}, converted on-chain.`}
        </p>
        {result.txHash && <a className="button secondary" href={`${config.explorerUrl}/tx/${result.txHash}`} target="_blank" rel="noopener noreferrer">See it on Monad</a>}
        <Link className="button secondary" href={receiptPath(result.paymentId)}>View receipt</Link>
        <Link className="button ghost" href="/">Done</Link>
      </div>
    );
  }

  const converted = src !== null && src.address !== request.asset;
  const bal = src ? assets.find((x) => x.asset.address === src.address)?.balance ?? 0n : 0n;
  const need = !src ? null : !converted ? request.amount : quote?.available ? quote.maxSourceAmount : allowFallback ? request.amount : null;
  const enough = need !== null && bal >= need;
  const blocked = !src || paying || quoting || (converted && (!quote || (!quote.available && !allowFallback))) || !enough;

  async function pay() {
    if (!account || !src) return;
    setPaying(true);
    setError("");
    try {
      const q = converted ? await quoteV2(src.address, request.asset, request.amount) : undefined;
      if (converted && q && !q.available && !allowFallback) {
        setQuote(q);
        throw new PayError("NO_ROUTE");
      }
      const r = await payV2(
        account,
        { recipient: request.recipient, asset: request.asset, amount: request.amount, sourceToken: src.address, quote: q, allowFallback, ref: request.requestId },
        (s) => setProgress(progressText(s, converted ? "Converting and paying" : "Paying")),
      );
      setResult(r);
      void reportPaid({ requestId: request.requestId, kind: "instantV2", payment: r.payment });
    } catch (e) {
      setError(errText(e));
      if (src) void refresh(src);
    } finally {
      setPaying(false);
      setProgress("");
    }
  }

  return (
    <div className="stack">
      {header}
      {card}
      <h2>Pay from</h2>
      <div className="stack" role="radiogroup" aria-label="Pay from">
        {assets.map(({ asset, balance }) => (
          <label key={asset.address} className={`choice${src?.address === asset.address ? " selected" : ""}`}>
            <input type="radio" name="asset" checked={src?.address === asset.address} onChange={() => { setSrc(asset); setAllowFallback(false); }} disabled={paying} />
            <span>
              <strong>{asset.symbol}</strong>
              <span className="muted small"> · you have {formatDollars(balance)}</span>
            </span>
          </label>
        ))}
        {externalPayAvailable() && (
          <button className="choice" onClick={() => setExternal(true)} aria-label="Pay from a wallet on another chain">
            <span className="settings-icon" aria-hidden="true">⇄</span>
            <span><strong>From a wallet on another chain</strong><span className="muted small"> · arrives as USDC</span></span>
          </button>
        )}
        {fundingAvailable() && !externalPayAvailable() && (
          <Link className="choice" href={`/add?amount=${fromBaseUnits(request.amount, 6)}&return=/pay/${requestId}&then=pay`} aria-label="Pay from another chain">
            <span className="settings-icon" aria-hidden="true">⇄</span>
            <span><strong>From another chain</strong><span className="muted small"> · USDC on Base, Ethereum, Arbitrum…</span></span>
          </Link>
        )}
      </div>

      {src && (
        <div className="card review">
          <dl aria-label="Payment summary">
            <dt>You pay</dt>
            <dd>
              {!converted
                ? `${formatDollars(request.amount)} ${src.symbol}`
                : quoting ? "Getting a price…" : quote?.available && quote.sourceAmount !== null
                  ? `about ${formatDollars(quote.sourceAmount)} ${src.symbol} (at most ${formatDollars(quote.maxSourceAmount!)})`
                  : allowFallback ? `${formatDollars(request.amount)} ${src.symbol}` : "—"}
            </dd>
            <dt>{recipient.displayName} receives</dt>
            <dd>{converted && quote && !quote.available ? (allowFallback ? `${formatDollars(request.amount)} ${src.symbol} (not ${want})` : "—") : `exactly ${formatDollars(request.amount)} ${want}`}</dd>
            <dt>Settlement</dt>
            <dd>{!converted ? `Direct, in ${want}` : quote?.available ? `${src.symbol} → ${want} on-chain via ${quote.provider === "AGORA" ? "Agora" : "Uniswap v4"}` : "Conversion unavailable"}</dd>
            <dt>Network fee</dt>
            <dd>$0.00 (paid by Everpiece)</dd>
            <dt>How it arrives</dt>
            <dd>Instant · final</dd>
            {quote && converted && <><dt>Price valid for</dt><dd>{Math.max(0, quote.expiresAt - now)}s</dd></>}
          </dl>
          {converted && quote?.available && <p className="muted small">Any {src.symbol} the conversion doesn&apos;t need comes back to you in the same transaction.</p>}
        </div>
      )}
      {converted && quote && !quote.available && (
        <div className="status warn stack">
          <span>Converting {src!.symbol} to {want} isn&apos;t available right now. You can pay from {want}, or send {src!.symbol} instead.</span>
          <label className="small"><input type="checkbox" checked={allowFallback} onChange={(e) => setAllowFallback(e.target.checked)} /> Send {formatDollars(request.amount)} {src!.symbol} instead</label>
        </div>
      )}
      {converted && quote?.available && (
        <label className="small">
          <input type="checkbox" checked={allowFallback} onChange={(e) => setAllowFallback(e.target.checked)} /> If the conversion fails at the last moment, pay in {src!.symbol} instead of cancelling
        </label>
      )}
      {src && need !== null && !enough && <div className="status warn">You don&apos;t have enough {src.symbol} for this.</div>}
      <Progress text={progress} />
      {error && <div className="status bad">{error}</div>}
      <button disabled={blocked} onClick={pay}>Pay with fingerprint or screen lock</button>
    </div>
  );
}
