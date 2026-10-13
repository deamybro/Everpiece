"use client";

import { useState } from "react";
import { createAccount, friendlyPasskeyError, signIn, type Account } from "../lib/mera";
import { HowItWorks } from "./HowItWorks";
import { Icon } from "./Icon";

/** Onboarding: a passkey ("Fingerprint") is the account. No seed phrase, no MON, no wallet app. */
/** With a 	itle it is embedded in another page (the claim page): no brand, no sender-oriented hints. */
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
    <div className={title ? "stack welcome-embedded" : "welcome"}>
      {!title && (
        <header className="welcome-header">
          <div className="brand">Everpiece<span className="brand-dot">.</span></div>
          <span className="welcome-header-note">A little closer, wherever you are.</span>
        </header>
      )}
      <div className={title ? "stack" : "welcome-intro"}>
      {!title && <span className="eyebrow">MONEY, MADE PERSONAL</span>}
      <h1>{title ?? "Send money to the right person."}</h1>
      <p className="muted">
        Your account opens with your phone&apos;s fingerprint, face or screen lock. No password to remember, no app to install.
        Free to use.
      </p>
      {!title && (
        <div className="welcome-art" aria-hidden="true">
          <div className="orbit orbit-one" /><div className="orbit orbit-two" />
          <div className="piece-mark"><span /><span /><span /></div>
          <span className="art-note art-note-send"><Icon name="send" size={18} /> Send a little love</span>
          <span className="art-note art-note-shield"><Icon name="shield" size={18} /> With peace of mind</span>
          <span className="art-spark">✦</span>
        </div>
      )}
      </div>
      <div className="card stack welcome-panel">
        {!title && (
          <div className="welcome-panel-heading">
            <span className="welcome-key"><Icon name="user" size={24} /></span>
            <h2>Make yourself at home.</h2>
            <p className="muted small">Your people. Your Dollars. One simple account.</p>
          </div>
        )}
        <div>
          <label htmlFor="name">Your first name</label>
          <input id="name" autoComplete="given-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Stella" aria-describedby="name-hint" />
          {!title && <div id="name-hint" className="muted small">So people know who the money is from.</div>}
        </div>
        <button disabled={busy || name.trim().length === 0} onClick={() => run(() => createAccount(name.trim()))}>
          Create my account with fingerprint or screen lock
        </button>
        <div className="welcome-divider"><span>Already part of Everpiece?</span></div>
        <button className="secondary" disabled={busy} onClick={() => run(signIn)}>
          I already have an account
        </button>
        {error && <div className="status bad">{error}</div>}
        <p className="muted small welcome-recovery">
          Your account is saved as a passkey in your phone&apos;s password manager (Google Password Manager or iCloud Keychain), so
          it also works on your other devices. If you lose it everywhere, Everpiece can&apos;t restore your account.
        </p>
      </div>
      {!title && <div className="welcome-how"><HowItWorks /></div>}
    </div>
  );
}
