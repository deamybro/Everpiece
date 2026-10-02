"use client";

import { seconds, type IncomingMessage } from "../lib/message";

/** A decrypted, verified message, or why it can't be shown. Never blocks the money around it. */
export function MessageCard({ message, from, onlyYou }: { message: IncomingMessage; from?: string; onlyYou?: boolean }) {
  if (message.status === "none") return null;
  return (
    <div className="card stack" aria-label="Message from the sender">
      <strong>{from ? `A message from ${from}` : "A message from the sender"}</strong>
      {message.status === "loading" && <div className="muted small">Opening the message…</div>}
      {message.status === "unavailable" && (
        <div className="muted small">The message can&apos;t be loaded right now. You can still claim your money.</div>
      )}
      {message.status === "invalid" && (
        <div className="status warn">This message couldn&apos;t be verified, so it isn&apos;t shown. Your money is not affected.</div>
      )}
      {message.status === "ok" && (
        <>
          {message.note && <p className="note">{message.note}</p>}
          {message.audioUrl && (
            <>
              <audio controls src={message.audioUrl} aria-label="Voice message" />
              <div className="muted small">Voice note, {seconds(message.durationMs ?? 0)}</div>
            </>
          )}
          <div className="muted small">
            Encrypted on the sender&apos;s phone. {onlyYou ? "Only your account can open it." : "Only this link can open it."}
          </div>
        </>
      )}
    </div>
  );
}
