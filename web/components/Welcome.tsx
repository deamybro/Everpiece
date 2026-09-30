"use client";

import { useState } from "react";
import { createAccount, friendlyPasskeyError, signIn, type Account } from "../lib/mera";

/** Onboarding: a passkey ("Fingerprint") is the account. No seed phrase, no MON, no wallet app. */
export function Welcome({ onReady, title }: { onReady: (a: Account) => void; title?: string }) {
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function run(fn: () => Promise<Account>) {
    setBusy(true);
    setError("");
    try {
      onReady(await fn());
    } catch (e) {
      setError(friendlyPasskeyError(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="stack">
      <div className="brand">Everpiece</div>
      <h1>{title ?? "Send money to the right person."}</h1>
      <p className="muted">Your account lives in a passkey on your phone, unlocked with your fingerprint, face or screen lock. No passwords, no app to install, free to use.</p>
      <div className="card stack">
        <div>
          <label htmlFor="name">Your first name</label>
          <input id="name" autoComplete="given-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Stella" />
        </div>
        <button disabled={busy || name.trim().length === 0} onClick={() => run(() => createAccount(name.trim()))}>
          Create my account with fingerprint or screen lock
        </button>
        <button className="secondary" disabled={busy} onClick={() => run(signIn)}>
          I already have an account
        </button>
      </div>
      {error && <div className="status bad">{error}</div>}
      <p className="muted small">
        If you lose access to your passkey on all your devices, Everpiece can&apos;t restore your account.
      </p>
    </div>
  );
}
