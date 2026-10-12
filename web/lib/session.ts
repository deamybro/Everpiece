import type { Address, Hex, LocalAccount } from "viem";

/**
 * A scoped, in-memory signing session (Mera's secp256k1 signing session, kept alive on purpose).
 *
 * After ONE fingerprint the owner may sign small payments without being asked again, until the first of: the timer,
 * the spending cap, the page being hidden for a moment, or "Lock now". The key exists only in this tab's memory (never
 * stored, never sent) and is zeroed by `end()` when the session closes. Only actions that declare an amount can use it
 * (sends and Earn deposits); account changes, rules, grants, private payments and everything else always ask.
 *
 * The cap is enforced by this app, not by Mera and not by the chain: it limits what honest code in this page will sign
 * without asking. Anything able to run script on this origin could sign while a session is open, which is why the
 * policy is strict and why sessions are short and small (THREAT_MODEL F1).
 */
export type SessionInfo = { address: Address; expiresAt: number; cap: bigint; capLeft: bigint };
type Active = SessionInfo & { signer: LocalAccount; end: () => void; inboxKey: Hex; messageSeed: Hex; timer: ReturnType<typeof setTimeout> };

/** Hidden for longer than this (user switched away) and the session closes. */
export const HIDDEN_GRACE_MS = 30_000;

let active: Active | null = null;
let snapshot: SessionInfo | null = null;
let hiddenTimer: ReturnType<typeof setTimeout> | null = null;
let hooked = false;
const listeners = new Set<() => void>();

function emit(): void {
  snapshot = active ? { address: active.address, expiresAt: active.expiresAt, cap: active.cap, capLeft: active.capLeft } : null;
  for (const l of listeners) l();
}

function hook(): void {
  if (hooked || typeof document === "undefined") return;
  hooked = true;
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) hiddenTimer = setTimeout(lockSession, HIDDEN_GRACE_MS);
    else if (hiddenTimer) {
      clearTimeout(hiddenTimer);
      hiddenTimer = null;
    }
  });
  window.addEventListener("pagehide", lockSession);
}

export function startSession(a: { address: Address; signer: LocalAccount; end: () => void; inboxKey: Hex; messageSeed: Hex; ttlMs: number; cap: bigint }): void {
  lockSession();
  hook();
  active = {
    address: a.address, signer: a.signer, end: a.end, inboxKey: a.inboxKey, messageSeed: a.messageSeed,
    expiresAt: Date.now() + a.ttlMs, cap: a.cap, capLeft: a.cap, timer: setTimeout(lockSession, a.ttlMs),
  };
  emit();
}

export function lockSession(): void {
  if (!active) return;
  clearTimeout(active.timer);
  const end = active.end;
  active = null;
  try {
    end(); // zeroes the key material
  } catch {
    /* already ended */
  }
  emit();
}

/** Reserve `spend` from the open session for this account, or null (then the caller asks for a fingerprint as usual). */
export function takeFromSession(address: Address, spend: bigint): { signer: LocalAccount; inboxKey: Hex; messageSeed: Hex; refund: () => void } | null {
  const a = active;
  if (!a || a.address.toLowerCase() !== address.toLowerCase() || Date.now() >= a.expiresAt || spend < 0n || spend > a.capLeft) return null;
  a.capLeft -= spend;
  emit();
  return {
    signer: a.signer, inboxKey: a.inboxKey, messageSeed: a.messageSeed,
    refund: () => {
      if (active === a) {
        a.capLeft += spend;
        emit();
      }
    },
  };
}

export const getSessionSnapshot = (): SessionInfo | null => snapshot;
export function subscribeSession(l: () => void): () => void {
  listeners.add(l);
  return () => void listeners.delete(l);
}
