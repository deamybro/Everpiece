import type { Hex } from "viem";
import { NO_METADATA, openMessage, sealMessage, type Message, type SealedMessage } from "@everpiece/shared";
import { config } from "./config";

/**
 * Link-payment messages (voice and/or text). Encrypted on this device with a key from the link's voice secret
 * (packages/shared voice.ts); the store only ever receives ciphertext. Messages are optional: if the store is
 * down, money can still be sent, claimed, cancelled and refunded (master §24.8).
 */

export const messagesAvailable = () => config.voiceUrl !== "";

export class MessageUploadError extends Error {}

/** Encrypt and upload before the payment is signed, so its intent can commit to exactly these bytes. */
export async function attachMessage(voiceRootSecret: Hex, m: Message): Promise<SealedMessage> {
  const sealed = await sealMessage(voiceRootSecret, m);
  let last = "";
  for (let attempt = 0; attempt < 3; attempt++) {
    const r = await fetch(`${config.voiceUrl}/v1/messages/${sealed.locator}`, {
      method: "PUT",
      headers: { "content-type": "application/octet-stream" },
      body: new Uint8Array(sealed.envelope),
    }).catch(() => null);
    if (r && (r.status === 201 || r.status === 200)) return sealed;
    last = r ? String(r.status) : "network";
    if (r && r.status >= 400 && r.status < 500 && r.status !== 429) break; // won't succeed on retry
    await new Promise((res) => setTimeout(res, 1000));
  }
  throw new MessageUploadError(last);
}

export type IncomingMessage =
  | { status: "none" }
  | { status: "loading" }
  | { status: "ok"; note: string; audioUrl?: string; durationMs?: number }
  /** The store is unreachable or no longer has it. */
  | { status: "unavailable" }
  /** Something came back, but it isn't the message the sender attached to this payment. */
  | { status: "invalid" };

/** Fetch, check against the payment's on-chain metadataCommitment, and decrypt. Never throws. */
export async function loadMessage(voiceRootSecret: Hex, locator: Hex, commitment: Hex): Promise<IncomingMessage> {
  if (commitment.toLowerCase() === NO_METADATA) return { status: "none" };
  if (!config.voiceUrl) return { status: "unavailable" };
  const r = await fetch(`${config.voiceUrl}/v1/messages/${locator}`).catch(() => null);
  if (!r || r.status !== 200) return { status: "unavailable" };
  try {
    const m = await openMessage(voiceRootSecret, new Uint8Array(await r.arrayBuffer()), commitment);
    if (!m.audio) return { status: "ok", note: m.note };
    const audioUrl = URL.createObjectURL(new Blob([new Uint8Array(m.audio.bytes)], { type: m.audio.type }));
    return { status: "ok", note: m.note, audioUrl, durationMs: m.audio.durationMs };
  } catch {
    return { status: "invalid" };
  }
}

export const seconds = (ms: number) => {
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};
