"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { isHarvestRef, type EarnOpportunity } from "@everpiece/shared";
import { Welcome } from "../../components/Welcome";
import { Progress, progressText } from "../../components/status";
import { friendlyError } from "../../lib/api";
import { formatDollars, parseDollars } from "../../lib/chain";
import { config, isDevStack } from "../../lib/config";
import { currentRate, deposit, earnAvailable, opportunities, readPosition, withdraw, type EarnView } from "../../lib/earn";
import { assetSymbol } from "../../lib/payV2";
import { friendlyPasskeyError, loadAccount, type Account } from "../../lib/mera";
import { PayError, balanceOfToken } from "../../lib/pay";

const errText = (e: unknown) => (e instanceof PayError ? friendlyError(e.code) : friendlyPasskeyError(e));
/** Earnings are often fractions of a cent: show 4 decimals below $1 (display only; amounts stay bigint). */
const small = (u: bigint) => (u > 0n && u < 1_000_000n ? `$0.${(u / 100n).toString().padStart(4, "0")}` : formatDollars(u));
const pct = (bps: number) => `${(bps / 100).toFixed(2)}%`;

/** Earn (docs/EARN.md): put Dollars to work in one verified vault; take them back, or take just the earnings. */
export default function EarnPage() {
  const [account, setAccount] = useState<Account | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [opp, setOpp] = useState<EarnOpportunity | null>(null);
  const [opps] = useState<EarnOpportunity[]>(() => opportunities());
  const [rate, setRate] = useState<{ aprBps: number; apyBps: number } | null>(null);
  const [view, setView] = useState<EarnView | null>(null);
  const [balance, setBalance] = useState<bigint | null>(null);
  const [mode, setMode] = useState<"in" | "out">("in");
  const [amountText, setAmountText] = useState("");
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState("");
  const [error, setError] = useState("");
  const [done, setDone] = useState("");

  const refresh = useCallback(async (a: Account, o: EarnOpportunity) => {
    // the balance in the vault's own asset (USDC for USDC Earn, AUSD for AUSD Earn)
    const [v, b] = await Promise.all([readPosition(o, a.address), balanceOfToken(o.asset, a.address)]);
    setView(v);
    setBalance(b);
  }, []);

  useEffect(() => {
    const a = loadAccount();
    setAccount(a);
    setLoaded(true);
    const o = opportunities()[0] ?? null;
    setOpp(o);
    if (!o) return;
    currentRate(o).then(setRate).catch(() => setRate(null));
    if (a) refresh(a, o).catch((e) => setError(errText(e)));
  }, [refresh]);

  function choose(o: EarnOpportunity) {
    setOpp(o);
    setView(null);
    setRate(null);
    setDone("");
    currentRate(o).then(setRate).catch(() => setRate(null));
    if (account) refresh(account, o).catch((e) => setError(errText(e)));
  }

  if (!loaded) return null;
  if (!account) return <Welcome onReady={setAccount} title="Create your account first." />;

  const amount = parseDollars(amountText);
  const p = view?.position;

  async function run(kind: "deposit" | "withdraw" | "harvest") {
    if (!account || !opp) return;
    setBusy(true);
    setError("");
    setDone("");
    try {
      const status = (s: Parameters<typeof progressText>[0]) => setProgress(progressText(s, kind === "deposit" ? "Moving it into Earn" : "Moving it to your balance"));
      if (kind === "deposit") {
        await deposit(account, opp, amount!, status);
        setDone(`${formatDollars(amount!)} is now earning ✓`);
      } else if (kind === "withdraw") {
        await withdraw(account, opp, amount!, { harvest: false }, status);
        setDone(`${formatDollars(amount!)} is back in your balance ✓`);
      } else {
        const y = p!.harvestableYield;
        await withdraw(account, opp, y, { harvest: true }, status);
        setDone(`Your earnings (${small(y)}) are in your balance ✓ Your deposit is untouched.`);
      }
      setAmountText("");
      await refresh(account, opp);
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
      setProgress("");
    }
  }

  /** Test site only: $1 of test Dollars added to the SIMULATED vault (shared by all depositors, like interest). */
  async function simulateEarnings() {
    if (!account || !opp) return;
    setBusy(true);
    setError("");
    try {
      const r = await fetch(`${config.devFaucetUrl}/faucet/earnings`, { method: "POST" });
      if (!r.ok) throw new PayError("PROVIDER_UNAVAILABLE");
      await refresh(account, opp);
      setDone("Simulated earnings added to the test vault.");
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="stack">
      <div className="row">
        <Link href="/" className="brand">Everpiece</Link>
        <Link href="/" className="muted small">Done</Link>
      </div>
      <h1>Earn</h1>
      {!opp && <div className="status warn">Earn isn&apos;t available here yet. Your Dollars stay in your balance.</div>}
      {opps.length > 1 && (
        <div className="row" role="group" aria-label="Earn in">
          {opps.map((o) => (
            <button key={o.id} className={opp?.id === o.id ? "" : "secondary"} aria-pressed={opp?.id === o.id} onClick={() => choose(o)} disabled={busy}>
              {assetSymbol(o.asset)} · {o.provider}
            </button>
          ))}
        </div>
      )}
      {opp && (
        <>
          {opp.simulated && <div className="dev">Simulated yield: this test vault&apos;s earnings are test Dollars added by the test site, not real interest.</div>}
          <section className="card stack" aria-label="Where your money goes">
            <div className="row">
              <strong>{opp.name}</strong>
              <span className="muted small">{opp.provider}</span>
            </div>
            <div className="muted small" aria-label="Current rate">
              {rate ? <>Current rate: <strong>{pct(rate.apyBps)} a year</strong> ({pct(rate.aprBps)} APR). It changes all the time.</> : opp.simulated ? "Rate: simulated (test site)." : "Current rate unavailable right now."}
            </div>
            <details>
              <summary className="small">Risks and how it works</summary>
              <ul className="small muted">{opp.risks.map((r) => <li key={r}>{r}</li>)}</ul>
              <p className="small muted">Your Dollars go into the vault in your own name: only you can take them out. Everpiece pays the network fee.</p>
            </details>
          </section>

          <section className="card stack" aria-label="Your Earn position">
            <dl>
              <dt>Deposited</dt>
              <dd>{p ? formatDollars(p.netPrincipal) : "…"}</dd>
              <dt>Worth now</dt>
              <dd>{p ? small(p.currentRedeemableValue) : "…"}</dd>
              <dt>Earnings you can take</dt>
              <dd aria-label="Harvestable earnings">{p ? small(p.harvestableYield) : "…"}</dd>
              {p && p.yieldAlreadyHarvested > 0n && (<><dt>Earnings taken so far</dt><dd>{small(p.yieldAlreadyHarvested)}</dd></>)}
            </dl>
            {opp.simulated && isDevStack && (
              <button className="ghost" disabled={busy} onClick={simulateEarnings}>Add simulated earnings (test only)</button>
            )}
            {p && p.harvestableYield > 0n && (
              <button className="secondary" disabled={busy} onClick={() => run("harvest")}>Take my earnings ({small(p.harvestableYield)}) — deposit stays</button>
            )}
          </section>

          <div className="row" role="group" aria-label="Earn action">
            <button aria-pressed={mode === "in"} onClick={() => { setMode("in"); setError(""); }}>Put in</button>
            <button aria-pressed={mode === "out"} onClick={() => { setMode("out"); setError(""); }}>Take out</button>
          </div>
          <div>
            <label htmlFor="earn-amount">{mode === "in" ? "Dollars to put in" : "Dollars to take out"}</label>
            <div className="money"><span className="sign">$</span>
              <input id="earn-amount" inputMode="decimal" placeholder="0.00" value={amountText} onChange={(e) => { setAmountText(e.target.value); setError(""); setDone(""); }} />
            </div>
            <p className="muted small">
              {mode === "in" ? <>In your balance: {balance === null ? "…" : formatDollars(balance)}</> : <>You can take out up to {view ? small(view.maxWithdraw) : "…"}</>}
            </p>
          </div>
          {mode === "in" ? (
            <button disabled={busy || !amount || balance === null || amount > balance} onClick={() => run("deposit")}>
              Put {amount ? formatDollars(amount) : "it"} in with fingerprint or screen lock
            </button>
          ) : (
            <button disabled={busy || !amount || !view || amount > view.maxWithdraw} onClick={() => run("withdraw")}>
              Take out {amount ? formatDollars(amount) : "it"} with fingerprint or screen lock
            </button>
          )}
          <Progress text={progress} />
          {done && <div className="status ok">{done}</div>}
          {error && <div className="status bad">{error}</div>}
          {view && view.history.length > 0 && (
            <section aria-label="Earn activity">
              <h2>Activity</h2>
              <ul className="stack">
                {[...view.history].reverse().map((h) => (
                  <li key={h.id} className="row small">
                    <span>{h.kind === "DEPOSIT" ? "Put in" : isHarvestRef(h.ref) ? "Earnings taken" : "Taken out"}</span>
                    <a href={`${config.explorerUrl}/tx/${h.txHash}`} target="_blank" rel="noopener noreferrer">{small(BigInt(h.assets))}</a>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </>
      )}
    </div>
  );
}
