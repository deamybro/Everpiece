"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import type { Address, Hex } from "viem";
import { NO_METADATA, PaymentMode, PaymentStatus } from "@everpiece/shared";
import { Welcome } from "../components/Welcome";
import { UsernameSetup } from "../components/UsernameSetup";
import { MessageCard } from "../components/MessageCard";
import { Progress, progressText } from "../components/status";
import { config, isDevStack } from "../lib/config";
import { chainTime, dollarsOf, formatDollars, paymentOf } from "../lib/chain";
import { cancelPayment, claimUsernamePayment, deliver, returnExpired, FlowError } from "../lib/flows";
import { loadHistory, type HistoryItem } from "../lib/history";
import { forgetAccount, friendlyPasskeyError, loadAccount, unlockMessages, type Account } from "../lib/mera";
import { loadUsernameMessage, messagesAvailable, type IncomingMessage } from "../lib/message";
import { friendlyError, type RelayStatus } from "../lib/api";
import { enableMessages, messageKeyPublished, readInbox, syncUsername, usernameOf } from "../lib/username";

/** message: decrypted and verified; locked: there is one, but this device needs one prompt to derive its message key. */
type Incoming = { paymentId: Hex; recipientSalt: Hex; amount: bigint; from: string; expiresAt: bigint; messageWrap?: Hex; message: IncomingMessage | undefined; locked: boolean };

const short = (a: Address) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const fromCache = new Map<Address, string>();

export default function Home() {
  const [account, setAccount] = useState<Account | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [balance, setBalance] = useState<bigint | null>(null);
  const [history, setHistory] = useState<HistoryItem[]>([]);
  const [historySource, setHistorySource] = useState<"indexer" | "device" | null>(null);
  const [incoming, setIncoming] = useState<Incoming[]>([]);
  const [busyId, setBusyId] = useState<Hex | null>(null);
  const [progress, setProgress] = useState("");
  const [message, setMessage] = useState<{ kind: "ok" | "bad"; text: string } | null>(null);
  const [messagesOn, setMessagesOn] = useState<boolean | null>(null);

  useEffect(() => {
    const a = loadAccount();
    setAccount(a);
    setLoaded(true);
    if (a && !a.username) syncUsername(a).then(setAccount).catch(() => {});
  }, []);

  const refresh = useCallback(async (a: Account) => {
    setBalance(await dollarsOf(a.address).catch(() => null));
    const now = await chainTime().catch(() => BigInt(Math.floor(Date.now() / 1000)));
    // History from the indexer (source of truth); this browser's sent list only adds labels / not-yet-indexed sends.
    const h = await loadHistory(a).catch(() => null);
    if (h) {
      setHistory(h.items);
      setHistorySource(h.source);
      // Username payments whose inbox entry didn't reach the directory yet: keep retrying (idempotent).
      for (const i of h.items) {
        if (i.direction === "sent" && i.state === "protected" && i.delivery && !i.delivery.delivered) {
          deliver({ paymentId: i.paymentId, amount: i.amount.toString(), to: i.counterparty, createdAt: i.at * 1000, expiresAt: i.expiresAt.toString(), delivery: i.delivery }).catch(() => {});
        }
      }
    }

    const inbox = await readInbox(a);
    const waiting = await Promise.all(
      inbox.map(async (i) => {
        const p = await paymentOf(i.paymentId).catch(() => null);
        if (!p || Number(p.status) !== PaymentStatus.ACTIVE || Number(p.mode) !== PaymentMode.USERNAME || now >= p.expiresAt) return null;
        if (!fromCache.has(p.sender)) fromCache.set(p.sender, (await usernameOf(p.sender)) ?? "");
        const name = fromCache.get(p.sender);
        // An attached message opens without a prompt (this device's message key); it never holds up the money.
        const hasMessage = p.metadataCommitment !== NO_METADATA && !!i.messageWrap;
        const msg = hasMessage && a.messageSeed
          ? await Promise.race([
              loadUsernameMessage(a.messageSeed, i.paymentId, i.messageWrap!, p.metadataCommitment),
              new Promise<IncomingMessage>((r) => setTimeout(() => r({ status: "loading" }), 4000)),
            ])
          : undefined;
        return { ...i, amount: p.amount, from: name ? `@${name}` : short(p.sender), expiresAt: p.expiresAt, message: msg, locked: hasMessage && !a.messageSeed };
      }),
    );
    setIncoming(waiting.filter((x): x is Incoming => x !== null));
  }, []);

  // Can others send this account messages? (Accounts from before messages publish their key with one prompt.)
  useEffect(() => {
    if (account?.username && messagesAvailable()) messageKeyPublished(account).then(setMessagesOn).catch(() => {});
  }, [account]);

  useEffect(() => {
    if (!account) return;
    refresh(account);
    const t = setInterval(() => refresh(account), 5000);
    return () => clearInterval(t);
  }, [account, refresh]);

  async function onCancel(r: HistoryItem) {
    if (!account) return;
    setBusyId(r.paymentId);
    setMessage(null);
    try {
      if (r.state === "expired") await returnExpired(r.paymentId, (s: RelayStatus) => setProgress(progressText(s, "Returning your money")));
      else await cancelPayment(account, r.paymentId, (s) => setProgress(progressText(s, "Returning your money")));
      setMessage({ kind: "ok", text: `Money returned: ${formatDollars(r.amount)}.` });
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

  async function onEnableMessages() {
    if (!account) return;
    setMessage(null);
    try {
      setAccount(await enableMessages(account));
      setMessagesOn(true);
      setMessage({ kind: "ok", text: "Voice messages are on ✓" });
    } catch (e) {
      setMessage({ kind: "bad", text: friendlyPasskeyError(e) });
    }
  }

  async function onUnlock() {
    if (!account) return;
    try {
      const a = await unlockMessages(account);
      setAccount(a);
    } catch (e) {
      setMessage({ kind: "bad", text: friendlyPasskeyError(e) });
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
          <strong>{config.networkLabel}</strong>
          <span>Test Dollars only — not real money.</span>
          <button className="secondary" onClick={devFund}>Get 100 test Dollars</button>
        </div>
      )}

      {!account.username && <UsernameSetup account={account} onDone={setAccount} />}

      {account.username && messagesOn === false && (
        <div className="card stack">
          <strong>Get voice messages</strong>
          <p className="muted small">Let people who pay you @{account.username} attach a voice note or a message. Only your account can open them.</p>
          <button className="secondary" disabled={busyId !== null} onClick={onEnableMessages}>Turn on with fingerprint or screen lock</button>
        </div>
      )}

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
                {i.message && <MessageCard message={i.message} from={i.from} onlyYou />}
                {i.locked && (
                  <button className="secondary" disabled={busyId !== null} onClick={onUnlock}>Open the message with fingerprint or screen lock</button>
                )}
                <button disabled={busyId !== null} onClick={() => onClaim(i)}>Claim with fingerprint or screen lock</button>
              </li>
            ))}
          </ul>
        </>
      )}

      <h2>Activity</h2>
      {historySource === "device" && config.indexerUrl && (
        <p className="muted small">Payment history is temporarily unavailable. Showing payments sent from this device.</p>
      )}
      {historySource !== null && history.length === 0 && <p className="muted">Payments you send and receive will show here.</p>}
      <ul className="list" aria-label="Activity">
        {history.map((r) => (
          <li key={`${r.direction}-${r.paymentId}`} className="stack" data-payment-id={r.paymentId}>
            <div className="row">
              <div>
                <strong>{r.direction === "received" ? "+" : ""}{formatDollars(r.amount)}</strong>{" "}
                <span className="muted">{r.direction === "received" ? "from" : "to"} {r.counterparty}</span>
                <div className="muted small">
                  {when(r.at)}
                  {r.tx && <> · <a href={`${config.explorerUrl}/tx/${r.tx}`} target="_blank" rel="noopener noreferrer">See it on Monad</a></>}
                </div>
              </div>
              <StatusPill item={r} />
            </div>
            {r.direction === "sent" && r.state === "protected" && r.delivery && !r.delivery.delivered && (
              <p className="muted small">Your money is protected. We&apos;re still letting {r.counterparty} know; this retries automatically.</p>
            )}
            {r.direction === "sent" && (r.state === "protected" || r.state === "expired") && (
              <button className="danger" disabled={busyId !== null} onClick={() => onCancel(r)}>
                {r.state === "expired" ? "Return my money" : "Cancel and get my money back"}
              </button>
            )}
          </li>
        ))}
      </ul>

      <p className="muted small center"><Link href="/proof">Everpiece in numbers</Link></p>
    </div>
  );
}

const when = (unix: number) => new Date(unix * 1000).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });

function StatusPill({ item }: { item: HistoryItem }) {
  if (item.direction === "received") return <span className="pill ok">Received</span>;
  if (item.state === "claimed") return <span className="pill ok">Claimed</span>;
  if (item.state === "cancelled") return <span className="pill muted">Cancelled</span>;
  if (item.state === "refunded") return <span className="pill muted">Refunded</span>;
  if (item.state === "expired") return <span className="pill">Expired</span>;
  return <span className="pill">Waiting to be claimed</span>;
}
