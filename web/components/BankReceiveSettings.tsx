"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import type { PayoutAccount } from "@everpiece/shared";
import { Welcome } from "./Welcome";
import { friendlyError } from "../lib/api";
import { friendlyPasskeyError, loadAccount, type Account } from "../lib/mera";
import { PayError } from "../lib/pay";
import { checkBankAccount, institutions, myBankAccount, payoutAvailable, payoutSimulated, saveBankAccount, type Institution, type SignedAccount } from "../lib/payout";

// Shown first: matched by NAME in the provider's own list (no hard-coded bank codes).
const POPULAR = /guaranty|access|zenith|first bank|united bank|opay|kuda|moniepoint|palmpay|fidelity|stanbic/i;
const errText = (e: unknown) => (e instanceof PayError ? friendlyError(e.code) : friendlyPasskeyError(e));

/** "How do you want to receive money?" — Dollars in Everpiece, or a verified Nigerian bank account (docs/PAYOUT.md). */
export function BankReceiveSettings() {
  const [account, setAccount] = useState<Account | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [mode, setMode] = useState<"dollars" | "bank">("dollars");
  const [banks, setBanks] = useState<Institution[]>([]);
  const [saved, setSaved] = useState<SignedAccount | null>(null);
  const [bank, setBank] = useState("");
  const [number, setNumber] = useState("");
  const [checked, setChecked] = useState<{ prepareId: string; record: PayoutAccount; institutionName: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState(false);
  const [search, setSearch] = useState("");

  useEffect(() => {
    const a = loadAccount();
    setAccount(a);
    setLoaded(true);
    if (!a || !payoutAvailable()) return;
    institutions().then(setBanks).catch((e) => setError(errText(e)));
    myBankAccount(a)
      .then((s) => {
        setSaved(s);
        if (s) setMode("bank");
      })
      .catch(() => {});
  }, []);

  // check automatically once a bank is chosen and all 10 digits are typed
  useEffect(() => {
    if (account && bank && number.length === 10 && !checked && !busy && !error) void check();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bank, number]);

  if (!loaded) return null;
  if (!account) return <Welcome onReady={setAccount} title="Create your account first." />;

  async function check() {
    if (!account) return;
    setBusy(true);
    setError("");
    setChecked(null);
    try {
      setChecked(await checkBankAccount(account, bank, number));
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  }
  async function save() {
    if (!account || !checked) return;
    setBusy(true);
    setError("");
    try {
      const s = await saveBankAccount(account, checked.prepareId, checked.record);
      setSaved({ ...s, institutionName: checked.institutionName });
      setChecked(null);
      setNumber("");
      setDone(true);
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  }

  const bankName = (code: string) => banks.find((b) => b.code === code)?.name ?? code;
  return (
    <div className="stack">
      <div className="row">
        <Link href="/" className="brand">Everpiece</Link>
        <Link href="/" className="muted small">Done</Link>
      </div>
      <h1>How do you want to receive money?</h1>
      {!payoutAvailable() && <div className="status warn">Bank payouts aren&apos;t available here yet. You receive Dollars in Everpiece.</div>}
      {payoutAvailable() && (
        <>
          {payoutSimulated() && <div className="dev">Simulated bank payouts: this test site never pays a real bank. Account names are test names.</div>}
          <div className="stack" role="radiogroup" aria-label="Receive as">
            <label className={`choice${mode === "dollars" ? " selected" : ""}`}>
              <input type="radio" name="mode" checked={mode === "dollars"} onChange={() => setMode("dollars")} />
              <span><strong>Dollars in Everpiece</strong><span className="muted small"> · keep, send or cash out later</span></span>
            </label>
            <label className={`choice${mode === "bank" ? " selected" : ""}`}>
              <input type="radio" name="mode" checked={mode === "bank"} onChange={() => setMode("bank")} />
              <span><strong>Nigerian bank account</strong><span className="muted small"> · people can pay you in naira, straight to your bank</span></span>
            </label>
          </div>

          {mode === "bank" && saved && !checked && (
            <div className="card stack" aria-label="Your bank account">
              <strong>{saved.institutionName ?? bankName(saved.record.institution)} ••{saved.record.last4}</strong>
              <span className="muted small">Verified name: {saved.record.accountName}</span>
              {done && <div className="status ok">Saved ✓ You can now request money in naira.</div>}
              <Link className="button" href="/request">Request money in naira</Link>
              <button className="ghost" onClick={() => setSaved(null)}>Use a different account</button>
            </div>
          )}

          {mode === "bank" && !saved && (
            <div className="stack">
              <div>
                <label htmlFor="bank">Bank</label>
                <input aria-label="Search banks" placeholder="Search banks" value={search} onChange={(e) => setSearch(e.target.value)} />
                <select id="bank" value={bank} onChange={(e) => { setBank(e.target.value); setChecked(null); setError(""); }}>
                  <option value="">Choose your bank</option>
                  {[...banks]
                    .filter((b) => b.name.toLowerCase().includes(search.trim().toLowerCase()) || b.code === bank)
                    .sort((a, b) => Number(POPULAR.test(b.name)) - Number(POPULAR.test(a.name)) || a.name.localeCompare(b.name))
                    .map((b) => <option key={b.code} value={b.code}>{b.name}</option>)}
                </select>
              </div>
              <div>
                <label htmlFor="acct">Account number</label>
                <input id="acct" inputMode="numeric" maxLength={10} placeholder="10 digits" value={number}
                  onChange={(e) => { setNumber(e.target.value.replace(/\D/g, "")); setChecked(null); setError(""); }} />
              </div>
              {!checked && (
                <button className="secondary" disabled={busy || !bank || number.length !== 10} onClick={check}>{busy ? "Checking with your bank…" : "Check account"}</button>
              )}
              {checked && (
                <div className="card stack" aria-label="Account check">
                  <span className="muted small">The bank says this account belongs to</span>
                  <strong>{checked.record.accountName}</strong>
                  <span className="muted small">{checked.institutionName} ••{checked.record.last4}</span>
                  <button disabled={busy} onClick={save}>That&apos;s me — save with fingerprint or screen lock</button>
                  <button className="ghost" onClick={() => setChecked(null)}>That&apos;s not right</button>
                </div>
              )}
              <p className="muted small">Your account number is stored encrypted. People paying you only see your bank, the last 4 digits and the verified name.</p>
            </div>
          )}
          {error && <div className="status bad">{error}</div>}
        </>
      )}
    </div>
  );
}
