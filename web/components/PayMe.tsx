"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { ExternalPay } from "./ExternalPay";
import { friendlyError } from "../lib/api";
import { externalPayAvailable } from "../lib/funding";
import { findRecipient, UsernameError, type Recipient } from "../lib/username";

/** Public "pay @username" page: anyone, from any chain, with no Everpiece account. They receive USDC on Monad (Aurora). */
export function PayMe({ username }: { username: string }) {
  const [to, setTo] = useState<Recipient | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    findRecipient(username)
      .then((r) => setTo(r.recipient))
      .catch((e) => setError(friendlyError(e instanceof UsernameError ? e.code : "NETWORK_UNAVAILABLE")));
  }, [username]);
  return (
    <div className="stack">
      <Link href="/" className="brand">Everpiece</Link>
      {error && <div className="status bad">{error}</div>}
      {!to && !error && <p className="muted">Looking up @{username}…</p>}
      {to && (externalPayAvailable() ? <ExternalPay to={to} /> : <div className="status warn">Paying from another chain isn&apos;t available here.</div>)}
    </div>
  );
}
