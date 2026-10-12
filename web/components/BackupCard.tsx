"use client";

import { useState } from "react";
import { friendlyError } from "../lib/api";
import { friendlyPasskeyError, type Account } from "../lib/mera";
import { PayError } from "../lib/pay";
import { backUp, lastBackup, restore } from "../lib/vault";

const errText = (e: unknown) => (e instanceof PayError ? friendlyError(e.code) : friendlyPasskeyError(e));

/** Encrypted backup of contacts and receipts, opened only by this account's passkey (lib/vault.ts). */
export function BackupCard({ account }: { account: Account }) {
  const [busy, setBusy] = useState<"" | "backup" | "restore">("");
  const [msg, setMsg] = useState("");
  const [error, setError] = useState("");
  const [last, setLast] = useState<number | null>(() => (typeof window === "undefined" ? null : lastBackup()));

  async function run(kind: "backup" | "restore") {
    setBusy(kind);
    setMsg("");
    setError("");
    try {
      if (kind === "backup") {
        const r = await backUp(account);
        setMsg(`Backed up ✓ ${r.contacts} contacts and ${r.receipts} receipts, encrypted.`);
      } else {
        const r = await restore(account);
        setMsg(r === null ? "No backup found for this account yet." : `Restored ✓ added ${r.addedContacts} contacts and ${r.addedReceipts} receipts to this device.`);
      }
      setLast(lastBackup());
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy("");
    }
  }

  return (
    <section className="card stack" aria-label="Encrypted backup">
      <strong>Encrypted backup</strong>
      <span className="muted small">
        Your contacts and receipts, locked with your passkey. We store only scrambled data we can&apos;t read, and a new phone gets it back with the same passkey. It never contains money or keys, and it doesn&apos;t replace contacts you already have.
      </span>
      {last && <span className="muted small">Last backup: {new Date(last).toLocaleString()}</span>}
      <div className="row">
        <button className="secondary" disabled={busy !== ""} onClick={() => run("backup")}>{busy === "backup" ? "Backing up…" : "Back up now"}</button>
        <button className="secondary" disabled={busy !== ""} onClick={() => run("restore")}>{busy === "restore" ? "Restoring…" : "Restore here"}</button>
      </div>
      <span className="muted small">Backing up asks for your fingerprint twice: once to lock it, once to sign it as yours.</span>
      {msg && <div className="status ok">{msg}</div>}
      {error && <div className="status bad">{error}</div>}
    </section>
  );
}
