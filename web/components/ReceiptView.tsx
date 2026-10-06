"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import type { Address, Hex } from "viem";
import { config, isDevStack } from "../lib/config";
import { formatDollars } from "../lib/chain";
import { loadAccount } from "../lib/mera";
import { kindLabel, loadReceipt, type Receipt, type ReceiptStep } from "../lib/receipt";

const when = (unix: number | bigint) => new Date(Number(unix) * 1000).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const who = (name: string | null, a: Address) => (name ? `@${name}` : short(a));

const STEP: Record<ReceiptStep["kind"], string> = {
  CREATED: "Sent and protected",
  CLAIMED: "Claimed by the recipient",
  CANCELLED: "Cancelled, money returned to the sender",
  REFUNDED: "Not claimed in time, money returned to the sender",
  PAID: "Paid instantly",
};

function headline(r: Receipt): string {
  const last = r.steps[r.steps.length - 1];
  switch (r.state) {
    case "claimed":
      return `Claimed by ${r.recipient ? who(r.recipientName, r.recipient) : "the recipient"}${last ? ` on ${when(last.at)}` : ""}`;
    case "cancelled":
      return `Cancelled${last ? ` on ${when(last.at)}` : ""}. The money went back to the sender.`;
    case "refunded":
      return `Returned to the sender${last ? ` on ${when(last.at)}` : ""}. It wasn't claimed in time.`;
    case "expired":
      return "Not claimed in time. The sender can get it back now.";
    case "paid":
      return `Paid to ${r.recipient ? who(r.recipientName, r.recipient) : "the recipient"}${last ? ` on ${when(last.at)}` : ""}. Instant payments are final.`;
    default:
      return `Protected, waiting to be claimed. If it isn't claimed by ${when(r.expiresAt)}, it goes back to the sender.`;
  }
}

export function ReceiptView({ paymentId }: { paymentId: Hex }) {
  const [receipt, setReceipt] = useState<Receipt | null | undefined>(undefined);
  const [failed, setFailed] = useState(false);
  const [copied, setCopied] = useState(false);
  const pending = useRef(false);
  pending.current = Boolean(receipt?.pending);

  useEffect(() => {
    const load = () => loadReceipt(paymentId, loadAccount() ?? undefined).then(setReceipt, () => setFailed(true));
    load();
    // the indexer can be a few seconds behind the chain right after a payment changes: refresh until it has caught up
    const t = setInterval(() => pending.current && load(), 4000);
    return () => clearInterval(t);
  }, [paymentId]);

  async function share() {
    const url = window.location.href;
    if (typeof navigator.share === "function") return navigator.share({ title: "Everpiece receipt", url }).catch(() => {});
    await navigator.clipboard.writeText(url).then(() => setCopied(true)).catch(() => {});
  }

  return (
    <div className="stack receipt">
      <div className="row">
        <Link href="/" className="brand">Everpiece</Link>
        <span className="muted small">Payment receipt</span>
      </div>

      {receipt === undefined && !failed && <p className="muted">Loading the receipt…</p>}
      {failed && <div className="status warn">The receipt can&apos;t be loaded right now. Please try again in a moment.</div>}
      {receipt === null && <div className="status warn">There&apos;s no Everpiece payment with this reference.</div>}

      {receipt && (
        <>
          <div className="card center stack">
            <div className="muted">{isDevStack ? "Test Dollars" : "Dollars"}</div>
            <div className="amount">{formatDollars(receipt.amount)}</div>
            <div className={`status ${receipt.state === "claimed" || receipt.state === "paid" ? "ok" : receipt.state === "protected" ? "" : "warn"}`} aria-label="Receipt status">
              {headline(receipt)}
            </div>
          </div>

          <div className="card review">
            <dl aria-label="Receipt details">
              <dt>Amount</dt>
              <dd>{formatDollars(receipt.amount)}</dd>
              <dt>Everpiece fee</dt>
              <dd>$0.00</dd>
              <dt>Network fee</dt>
              <dd>$0.00 (paid by Everpiece)</dd>
              <dt>From</dt>
              <dd>{who(receipt.senderName, receipt.sender)}</dd>
              <dt>To</dt>
              <dd>
                {receipt.recipient
                  ? who(receipt.recipientName, receipt.recipient)
                  : receipt.senderLabel ?? "Private until claimed"}
              </dd>
              <dt>How</dt>
              <dd>{kindLabel(receipt.mode)}</dd>
              {receipt.instant ? (
                <>
                  <dt>Paid in</dt>
                  <dd>{receipt.instant.viaAgora ? "Another currency, converted by Agora" : "Dollars"}</dd>
                </>
              ) : (
                <>
                  <dt>Expires</dt>
                  <dd>{when(receipt.expiresAt)}</dd>
                </>
              )}
            </dl>
          </div>

          <h2>Timeline</h2>
          <ol className="list" aria-label="Timeline">
            {receipt.steps.map((s) => (
              <li key={s.tx + s.kind} className="row">
                <div>
                  <strong>{STEP[s.kind]}</strong>
                  <div className="muted small">{when(s.at)}</div>
                </div>
                <a className="small" href={`${config.explorerUrl}/tx/${s.tx}`} target="_blank" rel="noopener noreferrer">Proof on Monad</a>
              </li>
            ))}
            {receipt.pending && <li className="muted small">Updating… the latest step is recorded on Monad and will show here in a few seconds.</li>}
          </ol>

          <div className="muted small stack">
            <div>
              Reference <span className="mono">{receipt.paymentId}</span>
            </div>
            <div>
              {receipt.instant ? "Settled by the Everpiece Pay contract" : "Held by the Everpiece contract"}{" "}
              <a className="mono" href={`${config.explorerUrl}/address/${receipt.instant ? config.pay : config.escrow}`} target="_blank" rel="noopener noreferrer">{receipt.instant ? config.pay : config.escrow}</a>{" "}
              on {isDevStack ? config.networkLabel : "Monad"}.
            </div>
            <div>
              This receipt is built from the public blockchain, so anyone can check it: each &quot;Proof on Monad&quot; link opens the
              transaction itself.{receipt.recipient ? "" : " The recipient isn't shown until they claim, so who it's for stays private."}
              {isDevStack ? " Test Dollars only, not real money." : ""}
            </div>
          </div>

          <div className="row no-print" role="group">
            <button onClick={() => window.print()}>Save as PDF / Print</button>
            <button className="secondary" onClick={share}>{copied ? "Link copied ✓" : "Share receipt"}</button>
          </div>
          <Link className="button ghost no-print" href="/">Back to Everpiece</Link>
        </>
      )}
    </div>
  );
}
