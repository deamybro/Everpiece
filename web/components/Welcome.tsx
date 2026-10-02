"use client";

import { useState } from "react";
import { createAccount, friendlyPasskeyError, signIn, type Account } from "../lib/mera";
import { HowItWorks } from "./HowItWorks";

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
      <p className="muted">
        Your account opens with your phone&apos;s fingerprint, face or screen lock. No password to remember, no app to install.
        Free to use.
      </p>
      <div className="card stack">
        <div>
          <label htmlFor="name">Your first name</label>
          <input id="name" autoComplete="given-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Stella" aria-describedby="name-hint" />
          <div id="name-hint" className="muted small">So people know who the money is from.</div>
        </div>
        <button disabled={busy || name.trim().length === 0} onClick={() => run(() => createAccount(name.trim()))}>
          Create my account with fingerprint or screen lock
        </button>
        <button className="secondary" disabled={busy} onClick={() => run(signIn)}>
          I already have an account
        </button>
      </div>
      {error && <div className="status bad">{error}</div>}
      {!title && <HowItWorks />}
      <p className="muted small">
        Your account is saved as a passkey in your phone&apos;s password manager (Google Password Manager or iCloud Keychain), so
        it also works on your other devices. If you lose it everywhere, Everpiece can&apos;t restore your account.
      </p>
    </div>
  );
}
