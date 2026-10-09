"use client";

import { useEffect, useState } from "react";
import { getAddress, isAddress, type Address, type Hex } from "viem";
import { fromBaseUnits, type FundingPhase, type FundingSource } from "@everpiece/shared";
import { QrCode } from "./QrCode";
import { Progress } from "./status";
import { config } from "../lib/config";
import { formatDollars } from "../lib/chain";
import { friendlyError } from "../lib/api";
import { PayError, reportPaid, type LoadedRequest } from "../lib/pay";
import { externalStatus, loadExternalSources, quoteTopUp, type TopUpQuote } from "../lib/funding";
import { assetSymbol } from "../lib/payV2";

type Phase = "pick" | "quoting" | "deposit" | "done" | "refunded" | "failed";

/**
 * Pay a request from ANY wallet on a supported chain, without an Everpiece account (Aurora Intents). The payer picks
 * the chain and asset, gives a refund address on that chain, and sends exactly the quoted amount to Aurora's deposit
 * address from their own wallet. Aurora delivers USDC to the requester on Monad; we track it to the delivery
 * transaction, which is the proof the directory checks. Nothing is simulated here unless the site says so.
 */
export function ExternalPay({ loaded }: { loaded: LoadedRequest }) {
  const { request, recipient } = loaded;
  const [sources, setSources] = useState<FundingSource[]>([]);
  const [source, setSource] = useState<FundingSource | null>(null);
  const [refundTo, setRefundTo] = useState("");
  const [quote, setQuote] = useState<TopUpQuote | null>(null);
  const [phase, setPhase] = useState<Phase>("pick");
  const [moving, setMoving] = useState<FundingPhase | null>(null);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState("");
  const asked = assetSymbol(request.asset);

  useEffect(() => {
    loadExternalSources()
      .then((s) => setSources(s.sources))
      .catch((e) => setError(friendlyError(e instanceof PayError ? e.code : "PROVIDER_UNAVAILABLE")));
  }, []);

  // track the deposit until Aurora delivers (or refunds) on Monad
  useEffect(() => {
    if (phase !== "deposit" || !quote) return;
    let stop = false;
    const tick = async () => {
      try {
        const s = await externalStatus(quote.depositAddress);
        if (stop) return;
        setMoving(s.phase);
        if (s.phase === "ARRIVED" && s.deliveredTxHash) {
          setPhase("done");
          void reportPaid({ requestId: request.requestId, kind: "crossChain", txHash: s.deliveredTxHash as Hex });
        } else if (s.phase === "REFUNDED") setPhase("refunded");
        else if (s.phase === "FAILED") setPhase("failed");
      } catch {
        /* keep polling: the deposit address stays valid until its deadline */
      }
    };
    void tick();
    const t = setInterval(tick, 5000);
    return () => {
      stop = true;
      clearInterval(t);
    };
  }, [phase, quote, request.requestId]);

  async function getDepositAddress() {
    if (!source || !isAddress(refundTo)) return;
    setPhase("quoting");
    setError("");
    try {
      setQuote(await quoteTopUp(source, request.amount, request.recipient, getAddress(refundTo) as Address));
      setPhase("deposit");
    } catch (e) {
      setError(friendlyError(e instanceof PayError ? e.code : "PROVIDER_UNAVAILABLE"));
      setPhase("pick");
    }
  }

  const copy = (what: string, v: string) => navigator.clipboard.writeText(v).then(() => setCopied(what)).catch(() => {});

  if (phase === "done") {
    return (
      <div className="stack">
        <div className="status ok">
          Paid ✓ {recipient.displayName} received {formatDollars(request.amount)} USDC on Monad{asked !== "USDC" ? ` (they asked for ${asked}; it arrives as USDC from another chain)` : ""}.
        </div>
        <p className="muted small">You don&apos;t need an Everpiece account for this. Keep your wallet&apos;s transaction as your receipt.</p>
      </div>
    );
  }
  if (phase === "refunded" || phase === "failed") {
    return (
      <div className="status warn">
        {phase === "refunded" ? `The transfer couldn't be completed and was refunded to ${refundTo} on ${source?.chainLabel}.` : "The transfer failed. Nothing was delivered; check your wallet for a refund."}
      </div>
    );
  }

  if (phase === "deposit" && quote && source) {
    const exact = fromBaseUnits(quote.amountIn, source.decimals);
    return (
      <div className="stack">
        <h2>Send from your wallet on {source.chainLabel}</h2>
        <div className="card stack">
          <dl className="review">
            <dt>Send exactly</dt>
            <dd>{exact} {source.symbol} on {source.chainLabel}</dd>
            <dt>To this address</dt>
            <dd className="mono small">{quote.depositAddress}</dd>
            <dt>{recipient.displayName} receives</dt>
            <dd>{formatDollars(quote.amountOut)} USDC on Monad</dd>
            <dt>Provider fee</dt>
            <dd>{quote.amountInUsd && quote.amountOutUsd ? `about $${(Number(quote.amountInUsd) - Number(quote.amountOutUsd)).toFixed(2)} (Aurora)` : "included in the amount"}</dd>
            <dt>Send before</dt>
            <dd>{new Date(quote.deadline).toLocaleString()}</dd>
          </dl>
          <QrCode value={quote.depositAddress} label="Deposit address QR code" />
          <div className="row">
            <button className="secondary" onClick={() => copy("address", quote.depositAddress)}>{copied === "address" ? "Address copied ✓" : "Copy address"}</button>
            <button className="secondary" onClick={() => copy("amount", exact)}>{copied === "amount" ? "Amount copied ✓" : "Copy amount"}</button>
          </div>
        </div>
        <div className="status warn small">
          Only send {source.symbol} on {source.chainLabel}. Another token or network can&apos;t be delivered. If less than the amount arrives,
          or it arrives late, it&apos;s refunded to {refundTo.slice(0, 6)}…{refundTo.slice(-4)}.
        </div>
        <Progress text={moving === "MOVING" ? "Received: moving it to Monad…" : moving === "DEPOSIT_TOO_SMALL" ? "Less than the amount arrived: it will be refunded." : "Waiting for your transfer…"} />
        {source.simulated && <p className="muted small">Test site: this route is simulated and nothing crosses a chain.</p>}
      </div>
    );
  }

  return (
    <div className="stack">
      <h2>Pay from any wallet</h2>
      <p className="muted small">
        No Everpiece account needed. Pay with USDC from another chain; {recipient.displayName} receives {formatDollars(request.amount)} USDC on Monad.
        {asked !== "USDC" && ` They asked for ${asked}: cross-chain payments arrive as USDC.`}
      </p>
      <div className="stack" role="radiogroup" aria-label="Pay from chain">
        {sources.map((s) => (
          <label key={s.assetId} className={`choice${source?.assetId === s.assetId ? " selected" : ""}`}>
            <input type="radio" name="source" checked={source?.assetId === s.assetId} onChange={() => setSource(s)} />
            <span><strong>{s.symbol}</strong><span className="muted small"> on {s.chainLabel}</span></span>
          </label>
        ))}
      </div>
      {source && (
        <div>
          <label htmlFor="refund">Your wallet address on {source.chainLabel} (for refunds)</label>
          <input id="refund" autoCapitalize="none" spellCheck={false} placeholder="0x…" value={refundTo} onChange={(e) => setRefundTo(e.target.value.trim())} />
          {refundTo.length > 3 && !isAddress(refundTo) && <p className="muted small">That isn&apos;t a valid address.</p>}
        </div>
      )}
      {error && <div className="status bad">{error}</div>}
      <button disabled={!source || !isAddress(refundTo) || phase === "quoting"} onClick={getDepositAddress}>
        {phase === "quoting" ? "Getting the deposit address…" : "Get deposit address"}
      </button>
      <p className="muted small">Cross-chain by Aurora Intents{config.funding === "simulated" ? " (simulated on this test site)" : ""}.</p>
    </div>
  );
}
