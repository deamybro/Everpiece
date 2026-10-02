"use client";

import type { RelayStatus } from "../lib/api";

/** Inclusion is not success: in-flight states never read as done (ESCROW_SPEC §17, D9). */
export function progressText(s: RelayStatus | "SIGNING" | "ATTACHING" | "", verb: string): string {
  switch (s) {
    case "ATTACHING":
      return "Encrypting and attaching your message…";
    case "SIGNING":
      return "Confirm with your fingerprint or screen lock…";
    case "SUBMITTED":
    case "PROCESSING":
      return `${verb}…`;
    default:
      return "";
  }
}

export function Progress({ text }: { text: string }) {
  if (!text) return null;
  return (
    <div className="status" role="status">
      <span className="spinner" aria-hidden="true" />
      {text}
    </div>
  );
}
