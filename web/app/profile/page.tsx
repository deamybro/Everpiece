"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useAccountView } from "../../components/AccountView";
import { signOut } from "../../components/AppShell";
import { CopyButton, LoadingSkeleton, PageHeader, ProfileSection } from "../../components/DashboardUI";
import { Welcome } from "../../components/Welcome";
import { UsernameSetup } from "../../components/UsernameSetup";
import { Icon } from "../../components/Icon";
import { HowItWorks } from "../../components/HowItWorks";
import { BankReceiveSettings } from "../../components/BankReceiveSettings";
import { payoutAvailable } from "../../lib/payout";
import { BackupCard } from "../../components/BackupCard";
import { vaultAvailable } from "../../lib/vault";
import { messagesAvailable } from "../../lib/message";
import { enableMessages, messageKeyPublished } from "../../lib/username";
import { friendlyPasskeyError } from "../../lib/mera";

export default function ProfilePage() {
  const { account, loaded, onReady } = useAccountView();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [messagesOn, setMessagesOn] = useState<boolean | null>(null);
  useEffect(() => {
    let live = true;
    setMessagesOn(null);
    if (account?.username && messagesAvailable()) void messageKeyPublished(account).then(value => { if (live) setMessagesOn(value); }).catch(() => {});
    return () => { live = false; };
  }, [account]);
  async function turnOnMessages() {
    if (!account) return;
    setBusy(true); setMessage("");
    try { onReady(await enableMessages(account)); setMessagesOn(true); setMessage("Voice messages are on."); }
    catch (e) { setMessage(friendlyPasskeyError(e)); }
    finally { setBusy(false); }
  }
  if (!loaded) return <LoadingSkeleton label="Loading your profile" />;
  return <div className="stack profile-page">
    <PageHeader title="Your profile" description="A little about you. Everything for your account." />
    {!account ? <><div className="profile-identity card"><span className="profile-avatar"><Icon name="user" size={28} /></span><div><h2>Your Everpiece account</h2><p className="muted small">Sign in with your existing passkey to view your profile.</p></div></div><Welcome title="Make yourself at home." onReady={onReady} /></> : <>
      <div className="profile-identity card"><span className="profile-avatar">{(account.name || account.username || "E").slice(0, 1).toUpperCase()}</span><div><h2>{account.name || "Your account"}</h2><p className="muted">{account.username ? `@${account.username}` : "No username yet"}</p></div><span className="pill ok">Passkey account</span></div>
      <ProfileSection title="Personal details"><div className="detail-row"><span>Display name</span><strong>{account.name || "Not set"}</strong></div>{account.username ? <><div className="detail-row"><span>Username</span><strong>@{account.username}</strong></div><p className="muted small">Your registered username is permanent.</p></> : <UsernameSetup account={account} onDone={onReady} />}<div className="address-block"><label>Wallet address</label><code className="mono">{account.address}</code><CopyButton value={account.address} label="Copy address" /></div></ProfileSection>
      <ProfileSection title="Account security" id="security"><div className="settings-row security-row"><span className="settings-icon"><Icon name="shield" /></span><span className="grow"><strong>Mera passkey</strong><span className="muted small">Every payment requires fingerprint, face or screen lock.</span></span><span className="pill ok">Protected</span></div><div className="security-note"><strong>Quick Payments</strong><p className="muted small">Temporary unlocks and spending caps are not supported by this deployment. Every financial action asks for your passkey.</p></div><div className="security-note"><strong>Recovery & backup</strong><p className="muted small">Use the passkey saved in your device’s password manager to sign in on another device. An encrypted backup or restore tool is not available here. If your passkey is lost everywhere, Everpiece cannot restore the account.</p></div></ProfileSection>
      {account.username && messagesAvailable() && <ProfileSection title="Private messages"><p className="muted small">Only your account can open messages attached to payments.</p>{messagesOn === true ? <span className="pill ok">Voice messages enabled</span> : <button className="secondary" disabled={busy} onClick={turnOnMessages}>{busy ? "Waiting for your passkey…" : "Turn on with fingerprint or screen lock"}</button>}<p className="muted small" role="status">{message}</p></ProfileSection>}
      {vaultAvailable() && <BackupCard account={account} />}
      <Link href="/settings" className="card settings-row"><span className="settings-icon"><Icon name="settings" /></span><span className="grow"><strong>Preferences</strong><span className="muted small">Balance visibility and display</span></span><Icon name="chevron" size={17} /></Link>
      <ProfileSection title="Account actions"><button className="secondary" onClick={signOut}>Sign out</button><p className="muted small">Removes this account from this browser. Use your passkey to sign in again.</p></ProfileSection>
    </>}
    <Link href="/activity" className="card settings-row"><span className="settings-icon"><Icon name="activity" /></span><span className="grow"><strong>Activity</strong><span className="muted small">Payments you’ve sent and received</span></span><Icon name="chevron" size={17} /></Link>
    <ProfileSection title="Help"><HowItWorks /><Link href="/proof" className="text-link">See Everpiece’s on-chain proof<Icon name="chevron" size={15} /></Link></ProfileSection>
    <div className="coming-soon-row"><Icon name="bank" size={19} /><span>Local banking & Naira conversion</span><span className="pill muted">Coming soon</span></div>
    {account && payoutAvailable() && <details className="card legacy-tools"><summary>Existing bank tools · provider availability applies</summary><p className="muted small">Local fiat banking is coming soon. These existing tools retain this deployment’s provider and simulation checks.</p><Link href="/bank">Open bank tools</Link><BankReceiveSettings /></details>}
  </div>;
}
