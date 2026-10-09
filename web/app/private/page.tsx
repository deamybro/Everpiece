"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { formatEther } from "viem";
import { PRIVATE_SEND_DISCLOSURE, TACEO_MERCES_MONAD } from "@everpiece/shared";
import { Welcome } from "../../components/Welcome";
import { Progress } from "../../components/status";
import { formatDollars, parseDollars } from "../../lib/chain";
import { friendlyError } from "../../lib/api";
import { friendlyPasskeyError, loadAccount, type Account } from "../../lib/mera";
import { PayError } from "../../lib/pay";
import { UsernameError, findRecipient } from "../../lib/username";
import { depositPrivate, joinPrivate, privateAvailable, privateBalance, privateStatus, sendPrivate, withdrawPrivate, type PrivateStatus } from "../../lib/private";

const errText = (e: unknown) => (e instanceof PayError || e instanceof UsernameError ? friendlyError(e.code) : friendlyPasskeyError(e));

/** Private Balance and Private Send (TACEO Merces): optional, small, and honest about what is and isn't private. */
export default function PrivatePage() {
  const [account, setAccount] = useState<Account | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [status, setStatus] = useState<PrivateStatus | null>(null);
  const [balance, setBalance] = useState<bigint | null>(null);
  const [amountText, setAmountText] = useState("1.00");
  const [to, setTo] = useState("");
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [done, setDone] = useState("");

  const refresh = (a: Account) => privateStatus(a.address).then(setStatus).catch(() => setError(friendlyError("NETWORK_UNAVAILABLE")));
  useEffect(() => {
    const a = loadAccount();
    setAccount(a);
    setLoaded(true);
    if (a && privateAvailable()) void refresh(a);
  }, []);

  if (!loaded) return null;
  if (!account) return <Welcome onReady={setAccount} title="Create your account first." />;
  const header = (
    <div className="row">
      <Link href="/" className="brand">Everpiece</Link>
      <Link href="/" className="muted small">Done</Link>
    </div>
  );
  if (!privateAvailable()) {
    return <div className="stack">{header}<h1>Private payments</h1><div className="status warn">Private payments aren&apos;t switched on here yet.</div></div>;
  }

  const amount = parseDollars(amountText);
  const over = amount !== null && amount > TACEO_MERCES_MONAD.maxAmountPerTx;
  const needsMon = status !== null && status.mon === 0n;

  async function run(label: string, fn: () => Promise<unknown>, ok: string) {
    if (!account) return;
    setBusy(label);
    setError("");
    setDone("");
    try {
      await fn();
      setDone(ok);
      void refresh(account);
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy("");
    }
  }

  return (
    <div className="stack">
      {header}
      <h1>Private balance</h1>
      <p className="muted small">
        Powered by TACEO Merces on Monad. Still limited by the network: up to {formatDollars(TACEO_MERCES_MONAD.maxAmountPerTx)} USDC per action,
        {" "}{TACEO_MERCES_MONAD.maxTxsPerEpoch} actions per period and {TACEO_MERCES_MONAD.maxMembers} members.
      </p>
      <div className="card stack">
        <strong>What&apos;s private</strong>
        <span className="small">Hidden: {PRIVATE_SEND_DISCLOSURE.hidden.join(", ")} for a private send.</span>
        <span className="small muted">Still visible: {PRIVATE_SEND_DISCLOSURE.visible.join("; ")}.</span>
      </div>

      {status && (
        <div className="card review">
          <dl>
            <dt>Joined</dt>
            <dd>{status.registered ? "Yes" : "Not yet"}</dd>
            <dt>Public USDC</dt>
            <dd>{formatDollars(status.usdc)}</dd>
            <dt>Private USDC</dt>
            <dd>{balance === null ? <button className="ghost small" disabled={!status.registered || busy !== ""} onClick={() => run("balance", async () => setBalance(await privateBalance(account)), "")}>Show</button> : formatDollars(balance)}</dd>
            <dt>MON for network fees</dt>
            <dd>{formatEther(status.mon)} MON</dd>
          </dl>
        </div>
      )}
      {needsMon && (
        <div className="status warn small">
          Private payments are sent from your own account, so it needs a little MON for network fees (TACEO doesn&apos;t support
          gas-free actions yet). Send a small amount of MON on Monad to {account.address}.
        </div>
      )}

      {status && !status.registered && (
        <>
          <p className="muted small">Joining runs TACEO&apos;s compliance check on your account and registers it (one transaction).</p>
          <button disabled={busy !== "" || needsMon} onClick={() => run("join", () => joinPrivate(account), "You've joined private payments ✓")}>
            Join private payments
          </button>
        </>
      )}

      {status?.registered && (
        <>
          <div className="money">
            <span className="sign" aria-hidden="true">$</span>
            <input className="big" inputMode="decimal" value={amountText} onChange={(e) => setAmountText(e.target.value)} aria-label="Amount in USDC" />
          </div>
          {over && <div className="status warn">The private network allows at most {formatDollars(TACEO_MERCES_MONAD.maxAmountPerTx)} per action.</div>}
          <div className="row">
            <button className="secondary" disabled={busy !== "" || amount === null || over || needsMon} onClick={() => run("in", () => depositPrivate(account, amount!), "Moved into your private balance ✓")}>Move in</button>
            <button className="secondary" disabled={busy !== "" || amount === null || over || needsMon} onClick={() => run("out", () => withdrawPrivate(account, amount!), "Moved back to your public balance ✓")}>Move out</button>
          </div>
          <div>
            <label htmlFor="pto">Send privately to</label>
            <input id="pto" autoCapitalize="none" spellCheck={false} placeholder="@username" value={to} onChange={(e) => setTo(e.target.value)} />
          </div>
          <button
            disabled={busy !== "" || amount === null || over || needsMon || to.trim().length < 3}
            onClick={() => run("send", async () => { const f = await findRecipient(to); await sendPrivate(account, f.recipient.account, amount!); }, "Sent privately ✓")}
          >
            Send privately with fingerprint or screen lock
          </button>
          <p className="muted small">They must have joined private payments too.</p>
        </>
      )}
      <Progress text={busy ? "Working… (private actions take a little longer while the network processes them)" : ""} />
      {done && <div className="status ok">{done}</div>}
      {error && <div className="status bad">{error}</div>}
    </div>
  );
}
