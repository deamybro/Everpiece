"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import type { Hex } from "viem";
import { fromBaseUnits, type RouteQuote, type TokenInfo } from "@everpiece/shared";
import { Welcome } from "./Welcome";
import { Progress, progressText } from "./status";
import { config } from "../lib/config";
import { formatDollars } from "../lib/chain";
import { friendlyError } from "../lib/api";
import { FlowError, sendToUsername } from "../lib/flows";
import { friendlyPasskeyError, loadAccount, type Account } from "../lib/mera";
import { PayError, RequestMode, balanceOfToken, getQuote, loadRequest, payInstant, payTokens, reportPaid, type LoadedRequest } from "../lib/pay";
import { receiptPath } from "../lib/receipt";
import { fundingAvailable } from "../lib/funding";

const tokenLabel = (t: TokenInfo) => (t.route === "DIRECT_AUSD" ? "Dollars (AUSD)" : `Test ${t.symbol}`);
const amountOf = (t: TokenInfo, v: bigint) => (t.route === "DIRECT_AUSD" ? formatDollars(v) : `${fromBaseUnits(v, t.decimals)} ${t.symbol}`);
const errText = (e: unknown) => (e instanceof PayError || e instanceof FlowError ? friendlyError(e.code) : friendlyPasskeyError(e));

type Phase = "loading" | "error" | "account" | "choose" | "paying" | "done";

/** Pay a scanned/opened payment request: verified first, exact AUSD to the recipient, real quotes, real confirmation. */
export function PayRequest({ requestId }: { requestId: Hex }) {
  const [phase, setPhase] = useState<Phase>("loading");
  const [req, setReq] = useState<LoadedRequest | null>(null);
  const [account, setAccount] = useState<Account | null>(null);
  const [tokens] = useState<TokenInfo[]>(() => payTokens());
  const [token, setToken] = useState<TokenInfo | null>(null);
  const [balances, setBalances] = useState<Record<string, bigint>>({});
  const [quote, setQuote] = useState<RouteQuote | null>(null);
  const [quoting, setQuoting] = useState(false);
  const [error, setError] = useState("");
  const [progress, setProgress] = useState("");
  const [result, setResult] = useState<{ paymentId: Hex; txHash: Hex | null; mode: RequestMode } | null>(null);
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));

  useEffect(() => {
    loadRequest(requestId)
      .then((r) => {
        setReq(r);
        const a = loadAccount();
        setAccount(a);
        setPhase(r.paid || r.problem ? "error" : a ? "choose" : "account");
      })
      .catch((e) => {
        setError(errText(e));
        setPhase("error");
      });
  }, [requestId]);

  useEffect(() => {
    if (!account) return;
    Promise.all(tokens.map(async (t) => [t.address, await balanceOfToken(t.address, account.address).catch(() => 0n)] as const)).then((pairs) =>
      setBalances(Object.fromEntries(pairs)),
    );
  }, [account, tokens]);

  const refreshQuote = useCallback(async (t: TokenInfo) => {
    if (!req || !account || t.route === "DIRECT_AUSD") return setQuote(null);
    setQuoting(true);
    setError("");
    try {
      setQuote(await getQuote(t, req.request.amount, req.request.recipient, account.address));
    } catch (e) {
      setQuote(null);
      setError(errText(e));
    } finally {
      setQuoting(false);
    }
  }, [req, account]);

  useEffect(() => {
    if (token) void refreshQuote(token);
  }, [token, refreshQuote]);
  // quotes expire: count down and refresh just before
  useEffect(() => {
    const t = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000);
    return () => clearInterval(t);
  }, []);
  useEffect(() => {
    if (quote && token && phase === "choose" && quote.expiresAt - now <= 5) void refreshQuote(token);
  }, [now, quote, token, phase, refreshQuote]);

  async function pay() {
    if (!req || !account || !token) return;
    setPhase("paying");
    setError("");
    const { request, recipient } = req;
    try {
      if (request.mode === RequestMode.INSTANT) {
        const r = await payInstant(account, { recipient: request.recipient, amount: request.amount, token, ref: request.requestId, quote: quote ?? undefined },
          (s) => setProgress(progressText(s, token.route === "DIRECT_AUSD" ? "Paying" : "Converting with Agora and paying")));
        setResult({ paymentId: r.paymentId, txHash: r.txHash, mode: request.mode });
        void reportPaid({ requestId: request.requestId, kind: "instant", payment: r.payment });
      } else {
        // Protected: the recipient must claim, the payer can cancel until then. A token is converted to the payer's
        // own AUSD first (refunds therefore come back in AUSD), then the AUSD is protected for the recipient.
        if (token.route !== "DIRECT_AUSD") {
          await payInstant(account, { recipient: account.address, amount: request.amount, token, quote: quote ?? undefined },
            (s) => setProgress(progressText(s, "Converting to Dollars with Agora")));
        }
        const r = await sendToUsername(account, request.amount, recipient, (s) => setProgress(progressText(s, "Protecting your payment")), undefined, { salt: request.requestId });
        setResult({ paymentId: r.paymentId, txHash: null, mode: request.mode });
        void reportPaid({ requestId: request.requestId, kind: "protected", intent: r.intent, recipientSalt: r.recipientSalt });
      }
      setPhase("done");
    } catch (e) {
      setError(errText(e));
      setPhase("choose");
      if (token) void refreshQuote(token);
    } finally {
      setProgress("");
    }
  }

  const header = (
    <div className="row">
      <Link href="/" className="brand">Everpiece</Link>
      <span className="muted small">Pay a request</span>
    </div>
  );

  if (phase === "loading") return <div className="stack">{header}<Progress text="Checking the payment request…" /></div>;
  if (phase === "error") {
    return (
      <div className="stack">
        {header}
        {req?.paid ? (
          <>
            <div className="status ok">This request has already been paid.</div>
            <Link className="button secondary" href={receiptPath(req.paid.paymentId)}>View receipt</Link>
          </>
        ) : (
          <div className="status bad">{req?.problem ? friendlyError(req.problem) : error || friendlyError("UNKNOWN_REQUEST")}</div>
        )}
        <Link className="button ghost" href="/">Back to Everpiece</Link>
      </div>
    );
  }
  if (!req) return null;
  const { request, recipient } = req;
  const who = `@${recipient.username}`;
  const card = (
    <div className="card center stack">
      <div className="muted">Pay {who} ({recipient.displayName})</div>
      <div className="amount">{formatDollars(request.amount)}</div>
      <div className="muted small">{recipient.displayName} receives exactly {fromBaseUnits(request.amount, 6)} AUSD</div>
    </div>
  );

  if (phase === "account") return <div className="stack">{header}{card}<Welcome onReady={(a) => { setAccount(a); setPhase("choose"); }} title="Create your account to pay." /></div>;

  if (phase === "done" && result) {
    return (
      <div className="stack">
        {header}
        <div className="status ok">
          {result.mode === RequestMode.INSTANT ? `Paid ✓ ${recipient.displayName} received exactly ${formatDollars(request.amount)}.` : `Sent ✓ ${formatDollars(request.amount)} is protected for ${who} until they claim it.`}
        </div>
        <p className="muted small">
          {result.mode === RequestMode.INSTANT ? "Instant payments are final." : "You can cancel from Home until they claim it."} {token?.route !== "DIRECT_AUSD" ? `Paid with ${tokenLabel(token!)} via Agora Instant Settlement.` : ""}
        </p>
        {result.txHash && <a className="button secondary" href={`${config.explorerUrl}/tx/${result.txHash}`} target="_blank" rel="noopener noreferrer">See it on Monad</a>}
        <Link className="button secondary" href={receiptPath(result.paymentId)}>View receipt</Link>
        <Link className="button ghost" href="/">Done</Link>
      </div>
    );
  }

  const enough = (t: TokenInfo) => (balances[t.address] ?? 0n) >= (t.route === "DIRECT_AUSD" ? request.amount : quote && token?.address === t.address ? quote.maxSellAmount : 1n);
  return (
    <div className="stack">
      {header}
      {card}
      <h2>Pay with</h2>
      <div className="stack" role="radiogroup" aria-label="Pay with">
        {tokens.map((t) => (
          <label key={t.address} className={`choice${token?.address === t.address ? " selected" : ""}`}>
            <input type="radio" name="token" checked={token?.address === t.address} onChange={() => setToken(t)} disabled={phase === "paying"} />
            <span>
              <strong>{tokenLabel(t)}</strong>
              <span className="muted small"> · you have {amountOf(t, balances[t.address] ?? 0n)}</span>
            </span>
          </label>
        ))}
      </div>

      {token && (
        <div className="card review">
          <dl aria-label="Payment summary">
            <dt>You pay</dt>
            <dd>{token.route === "DIRECT_AUSD" ? formatDollars(request.amount) : quoting ? "…" : quote ? `${amountOf(token, quote.sellAmount)} (at most ${amountOf(token, quote.maxSellAmount)})` : "—"}</dd>
            <dt>{recipient.displayName} receives</dt>
            <dd>{fromBaseUnits(request.amount, 6)} AUSD</dd>
            <dt>Settlement</dt>
            <dd>{token.route === "DIRECT_AUSD" ? "Direct in AUSD" : "Agora Instant Settlement"}</dd>
            <dt>Provider fee</dt>
            <dd>{token.route === "DIRECT_AUSD" ? "None" : quote ? amountOf(token, quote.providerFee) : "—"}</dd>
            <dt>Network fee</dt>
            <dd>$0.00 (paid by Everpiece)</dd>
            <dt>How it arrives</dt>
            <dd>{request.mode === RequestMode.INSTANT ? "Instant · final" : "Protected · cancellable until claimed"}</dd>
            {quote && <><dt>Price valid for</dt><dd>{Math.max(0, quote.expiresAt - now)}s</dd></>}
          </dl>
          {token.route !== "DIRECT_AUSD" && <p className="muted small">Any {token.symbol} the conversion doesn&apos;t need is returned to you in the same transaction.</p>}
          {request.mode === RequestMode.PROTECTED && token.route !== "DIRECT_AUSD" && (
            <p className="muted small">Protected payment refunds are returned in AUSD after conversion.</p>
          )}
        </div>
      )}
      {token && !enough(token) && (
        <div className="status warn">
          You don&apos;t have enough {tokenLabel(token)} for this.{" "}
          {token.route === "DIRECT_AUSD" && fundingAvailable() && (
            <Link href={`/add?amount=${fromBaseUnits(request.amount - (balances[token.address] ?? 0n), 6)}&return=/pay/${requestId}`}>
              Add money from another chain
            </Link>
          )}
        </div>
      )}
      <Progress text={progress} />
      {error && <div className="status bad">{error}</div>}
      <button disabled={!token || phase === "paying" || !enough(token) || (token.route !== "DIRECT_AUSD" && !quote)} onClick={pay}>
        Pay {formatDollars(request.amount)} with fingerprint or screen lock
      </button>
    </div>
  );
}
