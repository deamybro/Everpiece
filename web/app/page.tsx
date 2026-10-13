"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import type { Address, Hex } from "viem";
import { NO_METADATA, PaymentMode, PaymentStatus } from "@everpiece/shared";
import { AccountSummary } from "../components/AccountSummary";
import { SessionBar } from "../components/SessionBar";
import { assetBalances, payV2Available } from "../lib/payV2";
import { earnAvailable } from "../lib/earn";
import { fundingAvailable } from "../lib/funding";
import { privateAvailable } from "../lib/private";
import { EmptyState, LoadingSkeleton, TransactionRow } from "../components/DashboardUI";
import { MessageCard } from "../components/MessageCard";
import { day } from "../components/HowItWorks";
import { Progress, progressText } from "../components/status";
import { config, isDevStack } from "../lib/config";
import { chainTime, dollarsOf, formatDollars, paymentOf } from "../lib/chain";
import { cancelPayment, claimUsernamePayment, deliver, retryMessageBinds, returnExpired, FlowError } from "../lib/flows";
import { loadHistory, type HistoryItem, type HistoryState } from "../lib/history";
import { receiptPath } from "../lib/receipt";
import { friendlyPasskeyError, loadAccount, unlockMessages, type Account } from "../lib/mera";
import { loadUsernameMessage, type IncomingMessage } from "../lib/message";
import { friendlyError, type RelayStatus } from "../lib/api";
import { activeTopUps, type TopUp } from "../lib/funding";
import { payoutAvailable } from "../lib/payout";
import { HomePayouts } from "../components/HomePayouts";
import { Icon } from "../components/Icon";
import { balanceOfToken, payTokens } from "../lib/pay";
import { fromBaseUnits } from "@everpiece/shared";
import { readInbox, syncUsername, usernameOf } from "../lib/username";
import { LandingPage } from "../components/LandingPage";

/** message: decrypted and verified; locked: there is one, but this device needs one prompt to derive its message key. */
type Incoming = { paymentId: Hex; recipientSalt: Hex; amount: bigint; from: string; expiresAt: bigint; messageWrap?: Hex; message: IncomingMessage | undefined; locked: boolean };

const short = (a: Address) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const fromCache = new Map<Address, string>();

export default function Home() {
  const path = usePathname();
  const [account, setAccount] = useState<Account | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [balance, setBalance] = useState<bigint | null>(null);
  /** USDC and AUSD (EverpiecePayV2): what the account holds in each; the headline is their sum. */
  const [assetRows, setAssetRows] = useState<{ symbol: string; balance: bigint }[]>([]);
  const [balanceLoading, setBalanceLoading] = useState(true);
  const [balanceStale, setBalanceStale] = useState(false);
  const [openTopUps, setOpenTopUps] = useState<TopUp[]>([]);
  const [hideBalance, setHideBalance] = useState(false);
  const [holdings, setHoldings] = useState<{ symbol: string; label: string; note: string; amount: string }[]>([]);
  useEffect(() => {
    try {
      setHideBalance(localStorage.getItem("everpiece.hideBalance.v1") === "1");
    } catch {
      /* storage unavailable */
    }
  }, []);
  const toggleHide = () =>
    setHideBalance((h) => {
      try {
        localStorage.setItem("everpiece.hideBalance.v1", h ? "0" : "1");
      } catch {
        /* storage unavailable */
      }
      return !h;
    });
  const [history, setHistory] = useState<HistoryItem[]>([]);
  const [historySource, setHistorySource] = useState<"indexer" | "device" | null>(null);
  const [historyError, setHistoryError] = useState(false);
  const [incoming, setIncoming] = useState<Incoming[]>([]);
  const [busyId, setBusyId] = useState<Hex | null>(null);
  const [progress, setProgress] = useState("");
  const [message, setMessage] = useState<{ kind: "ok" | "bad"; text: string } | null>(null);
  // Cancels/returns this page saw CONFIRMED (final on-chain) that the indexer may not show yet: never offer them again.
  const settled = useRef(new Map<string, HistoryState>());

  useEffect(() => {
    const a = loadAccount();
    setAccount(a);
    setLoaded(true);
    if (a && !a.username) syncUsername(a).then(setAccount).catch(() => {});
    if (a) retryMessageBinds().catch(() => {}); // once per visit: messages sent while offline
  }, []);

  const refresh = useCallback(async (a: Account, inboxToo = true) => {
    try {
      if (payV2Available()) {
        const rows = (await assetBalances(a.address)).map((x) => ({ symbol: x.asset.symbol, balance: x.balance }));
        setAssetRows(rows);
        setBalance(rows.reduce((n, r) => n + r.balance, 0n));
      } else setBalance(await dollarsOf(a.address));
      setBalanceStale(false);
    } catch { setBalanceStale(true); }
    finally { setBalanceLoading(false); }
    setOpenTopUps(activeTopUps());
    // other tokens this account holds (e.g. USDC that arrived from another chain, waiting to become Dollars)
    void Promise.all(
      payTokens()
        .filter((t) => t.route !== "DIRECT_AUSD")
        .map(async (t) => ({ t, v: await balanceOfToken(t.address, a.address).catch(() => 0n) })),
    ).then((r) =>
      setHoldings(
        r.filter((x) => x.v > 0n).map(({ t, v }) => ({
          symbol: t.symbol, label: t.testnet ? `Test ${t.symbol}` : t.symbol, note: "Turns into Dollars when you pay or add money",
          amount: `${fromBaseUnits(v, t.decimals, 2).replace(/(\.\d{2})\d+$/, "$1")} ${t.symbol}`,
        })),
      ),
    );
    const now = await chainTime().catch(() => BigInt(Math.floor(Date.now() / 1000)));
    // History from the indexer (source of truth); this browser's sent list only adds labels / not-yet-indexed sends.
    const h = await loadHistory(a).catch(() => null);
    setHistoryError(h === null);
    if (h) {
      setHistory(
        h.items.map((i) => {
          const s = settled.current.get(i.paymentId.toLowerCase());
          if (!s) return i;
          if (i.state !== "protected" && i.state !== "expired") settled.current.delete(i.paymentId.toLowerCase()); // indexer caught up
          return i.state === "protected" || i.state === "expired" ? { ...i, state: s } : i;
        }),
      );
      setHistorySource(h.source);
      // Username payments whose inbox entry didn't reach the directory yet: keep retrying (idempotent).
      for (const i of h.items) {
        if (i.direction === "sent" && i.state === "protected" && i.delivery && !i.delivery.delivered) {
          deliver({ paymentId: i.paymentId, amount: i.amount.toString(), to: i.counterparty, createdAt: i.at * 1000, expiresAt: i.expiresAt.toString(), delivery: i.delivery }).catch(() => {});
        }
      }
    }

    if (!inboxToo) return;
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

  useEffect(() => {
    if (!account) return;
    // Every 5 s for balance and history; the directory inbox every 10 s (its per-IP limit is shared by everyone behind
    // one address, e.g. a phone carrier's NAT). Nothing while the tab is hidden; at once when it's shown again.
    refresh(account);
    let tick = 0;
    const t = setInterval(() => {
      if (document.hidden) return;
      void refresh(account, ++tick % 2 === 0);
    }, 5000);
    const onShow = () => {
      if (!document.hidden) void refresh(account);
    };
    document.addEventListener("visibilitychange", onShow);
    return () => {
      clearInterval(t);
      document.removeEventListener("visibilitychange", onShow);
    };
  }, [account, refresh]);

  async function onCancel(r: HistoryItem) {
    if (!account) return;
    setBusyId(r.paymentId);
    setMessage(null);
    try {
      if (r.state === "expired") await returnExpired(r.paymentId, (s: RelayStatus) => setProgress(progressText(s, "Returning your money")));
      else await cancelPayment(account, r.paymentId, (s) => setProgress(progressText(s, "Returning your money")));
      settled.current.set(r.paymentId.toLowerCase(), r.state === "expired" ? "refunded" : "cancelled");
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

  if (!loaded) return <LoadingSkeleton label="Loading your account" />;
  if (!account && path === "/") return <LandingPage />;

  return (
    <div className="stack dashboard dashboard-new">
      <AccountSummary account={account} balance={balance} assetRows={assetRows} balanceLoading={balanceLoading} balanceStale={balanceStale} hideBalance={hideBalance} toggleHide={toggleHide} />
      {account && payV2Available() && <SessionBar account={account} />}
      {account && (
        <section className="stack" aria-label="More">
          <Link href="/get-paid" className="card settings-row"><span className="settings-icon"><Icon name="add" size={20} /></span><span className="grow"><strong>Get paid from any chain</strong><span className="muted small">Your pay link and address</span></span><Icon name="chevron" size={18} /></Link>
          {privateAvailable() && <Link href="/private" className="card settings-row"><span className="settings-icon"><Icon name="scan" size={20} /></span><span className="grow"><strong>Private balance</strong><span className="muted small">private balance and send</span></span><Icon name="chevron" size={18} /></Link>}
          {fundingAvailable() && <Link href="/add" className="card settings-row"><span className="settings-icon"><Icon name="add" size={20} /></span><span className="grow"><strong>Add money from another chain</strong><span className="muted small">fund your own account</span></span><Icon name="chevron" size={18} /></Link>}
        </section>
      )}
      {holdings.filter(h => h.symbol !== "USDC").length > 0 && <details className="card"><summary>Other supported assets</summary><ul className="assets">{holdings.filter(h => h.symbol !== "USDC").map(h => <li key={h.symbol}><strong>{h.label}</strong><span>{hideBalance ? "••••" : h.amount}</span></li>)}</ul></details>}
      {payoutAvailable() && <HomePayouts />}

      {openTopUps.map((t) => (
        <Link key={t.depositAddress} href="/add" className="card stack" aria-label="Top-up in progress">
          <strong>Adding {formatDollars(BigInt(t.dollars))} from {t.origin.chainLabel}</strong>
          <span className="muted small">{t.phase === "ARRIVED" ? "It's arrived. Tap to turn it into Dollars." : "In progress. Tap to see where it is."}</span>
        </Link>
      ))}

      {isDevStack && (
        <div className="dev stack">
          <span>{config.networkLabel}: test Dollars only, not real money.</span>
          <button className="secondary small" onClick={devFund}>Get 100 test Dollars</button>
        </div>
      )}

      {account && !account.username && <Link href="/profile" className="card settings-row"><Icon name="user" /><span className="grow"><strong>Choose your @username</strong><span className="muted small">Make it easier for people to pay you.</span></span><Icon name="chevron" size={16} /></Link>}

      <Progress text={progress} />
      {message && <div className={`status ${message.kind}`}>{message.text}</div>}

      {incoming.length > 0 && (
        <>
          <h2>Money for you</h2>
          <p className="muted small">Sent to your @username. Claim it to move it into your balance. It&apos;s free.</p>
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

      {history.some(r => r.direction === "sent" && (r.state === "protected" || r.state === "expired")) && <section className="stack protected-payments"><h2>Protected payments</h2><p className="muted small">You can cancel payments awaiting claim, or return expired payments.</p><ul className="list card">{history.filter(r => r.direction === "sent" && (r.state === "protected" || r.state === "expired")).map(r => <li key={r.paymentId} className="stack" data-payment-id={r.paymentId}><div className="row"><strong>{formatDollars(r.amount)} to {r.counterparty}</strong><StatusPill item={r} /></div><p className="muted small">{explain(r)}</p>{r.delivery && !r.delivery.delivered && <p className="muted small">Your money is protected. We’re still letting {r.counterparty} know; this retries automatically.</p>}<Link href={receiptPath(r.paymentId)}>View receipt</Link><button className="danger" disabled={busyId !== null} onClick={() => onCancel(r)}>{r.state === "expired" ? "Return my money" : "Cancel and get my money back"}</button></li>)}</ul></section>}
      <section className="recent-activity" aria-labelledby="activity"><div className="section-title"><h2 id="activity">Recent Activity</h2><Link href="/activity">See all</Link></div>
      {historySource === "device" && <p className="muted small">{config.indexerUrl ? "Full history is temporarily unavailable. Showing verified payments from this device." : "Showing verified payments from this device."}</p>}
      {historyError && <p className="status warn" role="status">Couldn’t refresh your history. {historySource ? "Showing the last loaded payments." : "Try Activity to reload it."}</p>}
      {historySource === null ? historyError ? null : <LoadingSkeleton label="Loading payment history" /> : history.length === 0 ? <EmptyState title="Your story starts here" description="Payments you send and receive will appear here." /> : <ul className="transaction-list" aria-label="Activity">{history.slice(0, 5).map(r => <TransactionRow key={r.direction + r.paymentId} item={r} />)}</ul>}
      </section>
      <p className="muted small center"><Link href="/proof">Everpiece in numbers</Link></p>
    </div>
  );
}

/** One plain sentence: where the money is now and what happens next. (Avoids the status words used in the pills.) */
function explain(r: HistoryItem): string {
  if (r.direction === "received") return r.state === "paid" ? "Instant payment. It's in your balance." : "It's in your balance.";
  if (r.state === "paid") return "Instant payment. It arrived at once and is final.";
  switch (r.state) {
    case "claimed":
      return `It's in their account now.`;
    case "cancelled":
      return "You stopped this payment. The money is back in your balance.";
    case "refunded":
      return "Nobody took it in time, so it came back to your balance.";
    case "expired":
      return "Nobody took it in time. Tap below to get it back now.";
    default:
      return `Protected until they take it. You can cancel until then. If it isn't taken by ${day(r.expiresAt)}, it comes back to you.`;
  }
}

function StatusPill({ item }: { item: HistoryItem }) {
  if (item.direction === "received") return <span className="pill ok">Received</span>;
  if (item.state === "paid") return <span className="pill ok">Paid</span>;
  if (item.state === "claimed") return <span className="pill ok">Claimed</span>;
  if (item.state === "cancelled") return <span className="pill muted">Cancelled</span>;
  if (item.state === "refunded") return <span className="pill muted">Refunded</span>;
  if (item.state === "expired") return <span className="pill">Expired</span>;
  return <span className="pill">Waiting to be claimed</span>;
}
