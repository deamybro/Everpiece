"use client";

import Link from "next/link";
import { useState } from "react";
import { useAccountView } from "../../components/AccountView";
import { CopyButton, EmptyState, LoadingSkeleton, PageHeader, ProfileSection } from "../../components/DashboardUI";
import { QrCode } from "../../components/QrCode";
import { UsernameSetup } from "../../components/UsernameSetup";
import { Icon } from "../../components/Icon";
import { config } from "../../lib/config";
import { payableTokens } from "@everpiece/shared";

export default function ReceivePage() {
  const { account, loaded, onReady } = useAccountView();
  const [shareError, setShareError] = useState("");
  const assets = payableTokens(config.chainId).filter(t => t.symbol === "AUSD" ? t.address.toLowerCase() === config.dollar.address.toLowerCase() : t.symbol === "USDC").map(t => t.testnet ? `Test ${t.symbol}` : t.symbol);
  if (!loaded) return <LoadingSkeleton label="Loading receive details" />;
  return <div className="stack receive-page"><PageHeader title="Receive money" description="Your people. One simple place to pay you." />
    {!account ? <div className="card"><EmptyState icon="request" title="Ready when you are" description="Sign in to see your personal address and receive QR code."><Link href="/profile" className="button">Sign in with your passkey</Link></EmptyState></div> : <>
      <section className="receive-card card"><span className="receive-label">YOUR EVERPIECE ACCOUNT</span><h2>{account.username ? `@${account.username}` : account.name || "Your account"}</h2><p className="muted small">{account.username ? "Share your username so people can find you on Everpiece." : "Create a username below so people can find you."}</p><div className="personal-qr"><QrCode value={account.address} label="Your Monad wallet address QR code" /></div><span className="pill muted">{config.networkLabel}</span><p className="muted small">Address QR · send supported assets on this network only.</p><code className="mono receive-address">{account.address}</code><div className="receive-copy-actions"><CopyButton value={account.address} label="Copy address" />{account.username && <CopyButton value={`@${account.username}`} label="Copy username" />}</div>{typeof navigator !== "undefined" && "share" in navigator && <button className="secondary" onClick={() => navigator.share({ title: "My Everpiece account", text: `${account.username ? `@${account.username}\n` : ""}${account.address} · ${config.networkLabel}` }).catch((e) => { if (e?.name !== "AbortError") setShareError("Sharing is unavailable. Use the copy buttons above."); })}>Share account</button>}<p className="muted small" role="status">{shareError}</p></section>
      {!account.username && <ProfileSection title="Receive by username"><UsernameSetup account={account} onDone={onReady} /></ProfileSection>}
      <Link href="/get-paid" className="card settings-row"><span className="settings-icon"><Icon name="add" /></span><span className="grow"><strong>Get paid from any chain</strong><span className="muted small">Your pay link: anyone can pay it from Base, Ethereum, BNB Chain and more, no account needed.</span></span><Icon name="chevron" size={18} /></Link>
      <Link href="/request" className="card settings-row"><span className="settings-icon"><Icon name="request" /></span><span className="grow"><strong>Create a payment link</strong><span className="muted small">Choose an amount and sign a request. Share its verified link or QR.</span></span><Icon name="chevron" size={18} /></Link>
      <ProfileSection title="Supported assets"><p className="muted small">{assets.length ? assets.join(" and ") : "AUSD configured for this deployment"} on {config.networkLabel}. Your asset balances are shown separately on Home.</p></ProfileSection>
    </>}
    <div className="coming-soon-row"><Icon name="bank" size={19} /><span>Receive to a local bank</span><span className="pill muted">Coming soon</span></div>
  </div>;
}
