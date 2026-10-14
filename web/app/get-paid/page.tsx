"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { QrCode } from "../../components/QrCode";
import { Welcome } from "../../components/Welcome";
import { loadAccount, type Account } from "../../lib/mera";

/** Your receiving details: the Monad address (USDC/AUSD) and a link anyone can use to pay you from any chain. */
export default function GetPaidPage() {
  const [account, setAccount] = useState<Account | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [copied, setCopied] = useState("");
  useEffect(() => {
    setAccount(loadAccount());
    setLoaded(true);
  }, []);
  if (!loaded) return null;
  if (!account) return <Welcome onReady={setAccount} title="Create your account first." />;
  const link = account.username ? `${window.location.origin}/to/${account.username}` : "";
  const copy = (what: string, v: string) => navigator.clipboard.writeText(v).then(() => setCopied(what)).catch(() => {});
  return (
    <div className="stack">
      <div className="row">
        <Link href="/" className="brand">Everpiece</Link>
        <Link href="/" className="muted small">Done</Link>
      </div>
      <h1>Get paid</h1>
      {link && (
        <div className="card stack">
          <strong>Your pay link</strong>
          <p className="muted small">Anyone can pay you from any wallet on another chain, with any supported token. You receive USDC here. They don&apos;t need an Everpiece account.</p>
          <div className="mono small">{link}</div>
          <QrCode value={link} label="Your pay link QR code" />
          <button className="secondary" onClick={() => copy("link", link)}>{copied === "link" ? "Link copied ✓" : "Copy link"}</button>
        </div>
      )}
      <div className="card stack">
        <strong>Your address on Monad</strong>
        <p className="muted small">Send only USDC or AUSD on the Monad network to this address. Other tokens or networks can&apos;t be recovered.</p>
        <div className="mono small">{account.address}</div>
        <QrCode value={account.address} label="Your Monad address QR code" />
        <button className="secondary" onClick={() => copy("addr", account.address)}>{copied === "addr" ? "Address copied ✓" : "Copy address"}</button>
      </div>
    </div>
  );
}
