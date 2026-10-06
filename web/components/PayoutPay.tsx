"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import type { Hex } from "viem";
import { formatNaira, fromBaseUnits, isFinalPayout, type PayoutState } from "@everpiece/shared";
import { Welcome } from "./Welcome";
import { Progress, progressText } from "./status";
import { PAYOUT_STATE_TEXT } from "./NairaRequest";
import { config } from "../lib/config";
import { dollarsOf, formatDollars } from "../lib/chain";
import { friendlyError } from "../lib/api";
import { fundingAvailable } from "../lib/funding";
import { friendlyPasskeyError, loadAccount, type Account } from "../lib/mera";
import { PayError } from "../lib/pay";
import { usernameOf } from "../lib/username";
import { bankLine as bankLineOf, loadPayoutRequest, payPayout, payoutOrder, payoutQuote, payoutSimulated, rememberPayout, type LoadedPayoutRequest, type PublicOrder } from "../lib/payout";
import { PayoutTimeline } from "./PayoutTimeline";

const errText = (e: unknown) => (e instanceof PayError ? friendlyError(e.code) : friendlyPasskeyError(e));

/** Pay a "₦ to my bank" request: verified first, live price, one prompt, then followed until the bank confirms. */
export function PayoutPay({ requestId }: { requestId: Hex }) {
  const [req, setReq] = useState<LoadedPayoutRequest | null>(null);
  const [who, setWho] = useState<string | null>(null);
  const [account, setAccount] = useState<Account | null>(null);
  const [balance, setBalance] = useState<bigint | null>(null);
  const [quote, setQuote] = useState<{ rate: string; stableAmount: bigint; bufferBps: number } | null>(null);
  const [state, setState] = useState<PayoutState | null>(null);
  const [orderId, setOrderId] = useState<string | null>(null);
  const [history, setHistory] = useState<PublicOrder["history"]>([]);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

  const refreshQuote = useCallback(() => payoutQuote(requestId).then(setQuote).catch((e) => setError(errText(e))), [requestId]);

  useEffect(() => {
    const a = loadAccount();
    setAccount(a);
    loadPayoutRequest(requestId)
      .then(async (r) => {
        setReq(r);
        setWho(await usernameOf(r.request.recipient).catch(() => null));
        if (r.order) {
          setOrderId(r.order.orderId);
          setState(r.order.state);
          setHistory(r.order.history ?? []);
        }
        if (!r.order || r.order.state === "AWAITING_PAYMENT" || r.order.state === "EXPIRED") await refreshQuote();
      })
      .catch((e) => setError(errText(e)))
      .finally(() => setLoading(false));
  }, [requestId, refreshQuote]);
  useEffect(() => {
    if (account) dollarsOf(account.address).then(setBalance).catch(() => {});
  }, [account]);
  // follow the payout until the provider confirms (or refunds)
  useEffect(() => {
    if (!orderId || (state && isFinalPayout(state)) || state === "AWAITING_PAYMENT") return;
    const t = setInterval(() => !document.hidden && payoutOrder(orderId).then((o) => { setState(o.state); setHistory(o.history ?? []); }).catch(() => {}), 3000);
    return () => clearInterval(t);
  }, [orderId, state]);

  async function pay() {
    if (!account) return;
    setBusy(true);
    setError("");
    try {
      if (!quote) return;
      const o = await payPayout(account, requestId, quote.stableAmount, (s) => setProgress(s === "ORDERING" ? "Getting the bank transfer ready…" : progressText(s, "Paying")));
      setOrderId(o.orderId);
      setState("PAYOUT_FUNDED");
      setHistory([...(o.history ?? []), { state: "PAYOUT_FUNDED", at: Date.now() }]);
      if (req) rememberPayout({ key: o.orderId, role: "sent", orderId: o.orderId, requestId, kobo: req.request.fiatAmount.toString(), to: bankLineOf(req.account), who: who ? `@${who}` : undefined, at: Date.now() });
    } catch (e) {
      setError(errText(e));
      void refreshQuote();
    } finally {
      setBusy(false);
      setProgress("");
    }
  }

  const header = (
    <div className="row">
      <Link href="/" className="brand">Everpiece</Link>
      <span className="muted small">Pay to a bank</span>
    </div>
  );
  if (loading) return <div className="stack">{header}<Progress text="Checking the payment request…" /></div>;
  if (!req) return <div className="stack">{header}<div className="status bad">{error || friendlyError("UNKNOWN_REQUEST")}</div></div>;

  const { request, account: dest } = req;
  const bankLine = `${dest.institutionName ?? dest.record.institution} ••${dest.record.last4}`;
  const name = who ? `@${who}` : "They";
  const card = (
    <div className="card center stack" aria-label="Payout summary">
      <div className="muted">{name} receives at least</div>
      <div className="amount">{formatNaira(request.fiatAmount)}</div>
      <div className="muted small">to {bankLine} · verified name: {dest.record.accountName}</div>
    </div>
  );
  const sim = payoutSimulated() && <div className="dev">Simulated bank payout: this test site never pays a real bank.</div>;

  if (state && state !== "AWAITING_PAYMENT" && state !== "EXPIRED") {
    const final = isFinalPayout(state);
    return (
      <div className="stack">
        {header}
        {sim}
        {card}
        <PayoutTimeline state={state} history={history} />
        {state === "DELIVERED" && <div className="status ok">{PAYOUT_STATE_TEXT.DELIVERED}</div>}
        {state === "REFUNDED" && <div className="status bad">{PAYOUT_STATE_TEXT.REFUNDED} Refunds go to your own account.</div>}
        {!final && <p className="muted small">We only say &quot;Delivered&quot; when the payout provider confirms the bank transfer.</p>}
        <Link className="button ghost" href="/">Back to Everpiece</Link>
      </div>
    );
  }
  if (!account) return <div className="stack">{header}{card}<Welcome onReady={setAccount} title="Create your account to pay." /></div>;

  const enough = quote && balance !== null ? balance >= quote.stableAmount : true;
  return (
    <div className="stack">
      {header}
      {sim}
      {card}
      {quote && (
        <div className="card review">
          <dl aria-label="Payment summary">
            <dt>You pay</dt>
            <dd>about {formatDollars(quote.stableAmount)}</dd>
            <dt>Rate</dt>
            <dd>₦{Number(quote.rate).toLocaleString("en-NG")} / $1</dd>
            <dt>Includes</dt>
            <dd>{(quote.bufferBps / 100).toFixed(1)}% buffer + provider fee</dd>
            <dt>Network fee</dt>
            <dd>Free</dd>
            <dt>If it fails</dt>
            <dd>Full refund</dd>
          </dl>
        </div>
      )}
      {!enough && (
        <div className="status warn">
          You don&apos;t have enough Dollars for this.{" "}
          {fundingAvailable() && quote && balance !== null && (
            <Link href={`/add?amount=${fromBaseUnits(quote.stableAmount - balance + 1_000_000n, 6)}&return=/payout/${requestId}`}>Add money from another chain</Link>
          )}
        </div>
      )}
      {state === "EXPIRED" && <div className="status warn">{PAYOUT_STATE_TEXT.EXPIRED} You can pay again below.</div>}
      <Progress text={progress} />
      {error && <div className="status bad">{error}</div>}
      <button disabled={busy || !quote || !enough || !config.pay} onClick={pay}>Pay with fingerprint or screen lock</button>
    </div>
  );
}
