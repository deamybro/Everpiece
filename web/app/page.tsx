"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import type { Address, Hex } from "viem";
import { PaymentMode, PaymentStatus } from "@everpiece/shared";
import { Welcome } from "../components/Welcome";
import { UsernameSetup } from "../components/UsernameSetup";
import { Progress, progressText } from "../components/status";
import { config, isDevStack } from "../lib/config";
import { chainTime, dollarsOf, formatDollars, paymentOf } from "../lib/chain";
import { cancelPayment, claimUsernamePayment, deliver, loadSent, returnExpired, FlowError, type SentPayment } from "../lib/flows";
import { forgetAccount, friendlyPasskeyError, loadAccount, type Account } from "../lib/mera";
import { friendlyError, type RelayStatus } from "../lib/api";
import { readInbox, syncUsername, usernameOf } from "../lib/username";

type Row = SentPayment & { status: number; expired: boolean };
type Incoming = { paymentId: Hex; recipientSalt: Hex; amount: bigint; from: string; expiresAt: bigint };

const short = (a: Address) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const fromCache = new Map<Address, string>();

export default function Home() {
  const [account, setAccount] = useState<Account | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [balance, setBalance] = useState<bigint | null>(null);
  const [rows, setRows] = useState<Row[]>([]);
  const [incoming, setIncoming] = useState<Incoming[]>([]);
  const [busyId, setBusyId] = useState<Hex | null>(null);
  const [progress, setProgress] = useState("");
  const [message, setMessage] = useState<{ kind: "ok" | "bad"; text: string } | null>(null);

  useEffect(() => {
    const a = loadAccount();
    setAccount(a);
    setLoaded(true);
    if (a && !a.username) syncUsername(a).then(setAccount).catch(() => {});
  }, []);

  const refresh = useCallback(async (a: Account) => {
    setBalance(await dollarsOf(a.address).catch(() => null));
    const now = await chainTime().catch(() => BigInt(Math.floor(Date.now() / 1000)));
    const sent = loadSent();
    const withStatus = await Promise.all(
      sent.map(async (s) => {
        const p = await paymentOf(s.paymentId).catch(() => null);
        return { ...s, status: p ? Number(p.status) : 0, expired: p ? now >= p.expiresAt : false };
      }),
    );
    setRows(withStatus);
    // Username payments whose inbox entry didn't reach the directory yet: keep retrying (idempotent).
    for (const r of withStatus) if (r.status === PaymentStatus.ACTIVE && r.delivery && !r.delivery.delivered) deliver(r).catch(() => {});

    const inbox = await readInbox(a);
    const waiting = await Promise.all(
      inbox.map(async (i) => {
        const p = await paymentOf(i.paymentId).catch(() => null);
        if (!p || Number(p.status) !== PaymentStatus.ACTIVE || Number(p.mode) !== PaymentMode.USERNAME || now >= p.expiresAt) return null;
        if (!fromCache.has(p.sender)) fromCache.set(p.sender, (await usernameOf(p.sender)) ?? "");
        const name = fromCache.get(p.sender);
        return { ...i, amount: p.amount, from: name ? `@${name}` : short(p.sender), expiresAt: p.expiresAt };
      }),
    );
    setIncoming(waiting.filter((x): x is Incoming => x !== null));
  }, []);

  useEffect(() => {
    if (!account) return;
    refresh(account);
    const t = setInterval(() => refresh(account), 5000);
    return () => clearInterval(t);
  }, [account, refresh]);

  async function onCancel(r: Row) {
    if (!account) return;
    setBusyId(r.paymentId);
    setMessage(null);
    try {
      if (r.expired) await returnExpired(r.paymentId, (s: RelayStatus) => setProgress(progressText(s, "Returning your money")));
      else await cancelPayment(account, r.paymentId, (s) => setProgress(progressText(s, "Returning your money")));
      setMessage({ kind: "ok", text: `Money returned: ${formatDollars(BigInt(r.amount))}.` });
    } catch (e) {
      setMessage({ kind: "bad", text: e instanceof FlowError ? friendlyError(e.code) : friendlyPasskeyError(e) });
    } finally {
      setBusyId(null);
      setProgress("");
      refresh(account);
    }
  }

  async function onClaim(i: Incoming) {
    if (!account) return;
    setBusyId(i.paymentId);
    setMessage(null);
    try {
      await claimUsernamePayment(account, i.paymentId, i.recipientSalt, (s) => setProgress(progressText(s, "Moving the money to your account")));
      setMessage({ kind: "ok", text: `You received ${formatDollars(i.amount)} from ${i.from} ✓` });
    } catch (e) {
      setMessage({ kind: "bad", text: e instanceof FlowError ? friendlyError(e.code) : friendlyPasskeyError(e) });
    } finally {
      setBusyId(null);
      setProgress("");
      refresh(account);
    }
  }

  async function devFund() {
    if (!account) return;
    await fetch(`${config.devFaucetUrl}/faucet`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ address: account.address }) });
    refresh(account);
  }

  if (!loaded) return null;
  if (!account) return <Welcome onReady={setAccount} />;

  return (
    <div className="stack">
      <div className="row">
        <div className="brand">Everpiece</div>
        <button className="ghost small" onClick={() => { forgetAccount(); setAccount(null); }}>Sign out</button>
      </div>

      <div className="card">
        <div className="muted">{account.name ? `Hi ${account.name}, your Dollars` : "Your Dollars"}</div>
        {account.username && <div className="muted small">Your username: <strong>@{account.username}</strong></div>}
        <div className="balance">{balance === null ? "…" : formatDollars(balance)}</div>
        <Link className="button" href="/send">Send money</Link>
      </div>

      {isDevStack && (
        <div className="dev stack">
          <strong>Local test network</strong>
          <span>Test Dollars only — not real money.</span>
          <button className="secondary" onClick={devFund}>Get 100 test Dollars</button>
        </div>
      )}

      {!account.username && <UsernameSetup account={account} onDone={setAccount} />}

      <Progress text={progress} />
      {message && <div className={`status ${message.kind}`}>{message.text}</div>}

      {incoming.length > 0 && (
        <>
          <h2>Money for you</h2>
          <ul className="list">
            {incoming.map((i) => (
              <li key={i.paymentId} className="stack">
                <div className="row">
                  <div>
                    <strong>{formatDollars(i.amount)}</strong> <span className="muted">from {i.from}</span>
                  </div>
                  <span className="pill">Waiting for you</span>
                </div>
                <button disabled={busyId !== null} onClick={() => onClaim(i)}>Claim with fingerprint</button>
              </li>
            ))}
          </ul>
        </>
      )}

      <h2>Sent</h2>
      {rows.length === 0 && <p className="muted">Payments you send will show here.</p>}
      <ul className="list">
        {rows.map((r) => (
          <li key={r.paymentId} className="stack">
            <div className="row">
              <div>
                <strong>{formatDollars(BigInt(r.amount))}</strong> <span className="muted">to {r.to}</span>
              </div>
              <StatusPill status={r.status} expired={r.expired} />
            </div>
            {r.status === PaymentStatus.ACTIVE && r.delivery && !r.delivery.delivered && (
              <p className="muted small">Your money is protected. We&apos;re still letting {r.to} know; this retries automatically.</p>
            )}
            {r.status === PaymentStatus.ACTIVE && (
              <button className="danger" disabled={busyId !== null} onClick={() => onCancel(r)}>
                {r.expired ? "Return my money" : "Cancel and get my money back"}
              </button>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

function StatusPill({ status, expired }: { status: number; expired: boolean }) {
  if (status === PaymentStatus.CLAIMED) return <span className="pill ok">Claimed</span>;
  if (status === PaymentStatus.CANCELLED || status === PaymentStatus.REFUNDED) return <span className="pill muted">Money returned</span>;
  if (status === PaymentStatus.ACTIVE) return <span className="pill">{expired ? "Expired" : "Waiting to be claimed"}</span>;
  return <span className="pill muted">Checking…</span>;
}
