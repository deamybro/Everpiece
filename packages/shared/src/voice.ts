import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, hexToBytes, keccak256, type Hex } from "viem";
import { metadataCommitment } from "./commitments.ts";

/**
 * Link-payment message v1: an optional voice note and/or short text, encrypted on the sender's device
 * (master §24.2, §24.5; ESCROW_SPEC §3.2, §4).
 *
 * Every key comes from the claim package's voiceRootSecret (independent random bytes, never the claim key) via
 * HKDF-SHA256 with its own label, so the store's locator reveals nothing about the AES key and neither can sign:
 *   key     = HKDF(voiceRootSecret, info "everpiece.link.voice.v1.key")            AES-256-GCM (Web Crypto)
 *   locator = HKDF(voiceRootSecret, info "everpiece.link.voice.v1.locator")        where the voice store keeps it
 *   salt    = HKDF(voiceRootSecret, info "everpiece.link.voice.v1.metadata-salt")  metadataCommitment salt
 *
 * Envelope = exactly the bytes the voice store keeps, and what the payment's metadataCommitment binds:
 *   0x01 version ‖ audio type (1 byte) ‖ duration ms (uint32 BE) ‖ IV (12 random bytes) ‖ AES-256-GCM ciphertext+tag
 *   (the first 6 bytes are the GCM additional data, so the type and duration can't be changed either)
 * Plaintext = note length (uint16 BE) ‖ note (UTF-8) ‖ audio bytes
 *
 * The store sees only ciphertext plus the type and duration. The sender signs the commitment inside the payment
 * intent, so a recipient can tell that a message really came with THIS payment: one the store or anyone else
 * swapped in fails the check.
 */

export const MESSAGE_VERSION = 1;
export const MAX_VOICE_MS = 30_000;
export const MAX_NOTE_CHARS = 200;
export const MAX_NOTE_BYTES = 800;
export const MAX_ENVELOPE_BYTES = 1024 * 1024; // 30 s of AAC at 128 kbit/s (Safari may ignore a lower bitrate) is ~480 KB
const HEADER_BYTES = 6;
const IV_BYTES = 12;
const TAG_BYTES = 16;

/** Container types a browser may record (detected at runtime); codes are part of the v1 format. */
const AUDIO_CODES = ["", "audio/webm", "audio/mp4", "audio/ogg"] as const;
export type AudioType = Exclude<(typeof AUDIO_CODES)[number], "">;

export class MessageError extends Error {
  readonly code: "MessageMalformed" | "MessageNotForThisPayment" | "MessageTampered" | "MessageTooLarge";
  constructor(code: MessageError["code"]) {
    super(code);
    this.code = code;
  }
}

export type Message = { note: string; audio?: { bytes: Uint8Array; type: AudioType; durationMs: number } };
export type SealedMessage = { envelope: Uint8Array; locator: Hex; envelopeHash: Hex; commitment: Hex };
export type EnvelopeHeader = { version: 1; audioType: AudioType | null; durationMs: number };

const utf8 = new TextEncoder();
const derive = (root: Hex, info: string) => hkdf(sha256, hexToBytes(root), undefined, utf8.encode(info), 32);
/** A fresh copy on its own ArrayBuffer (what Web Crypto's BufferSource expects). */
const own = (b: Uint8Array) => new Uint8Array(b) as Uint8Array<ArrayBuffer>;

export const messageLocator = (voiceRootSecret: Hex): Hex => bytesToHex(derive(voiceRootSecret, "everpiece.link.voice.v1.locator"));
export const messageSalt = (voiceRootSecret: Hex): Hex => bytesToHex(derive(voiceRootSecret, "everpiece.link.voice.v1.metadata-salt"));
const aesKey = (voiceRootSecret: Hex, usage: "encrypt" | "decrypt") =>
  crypto.subtle.importKey("raw", own(derive(voiceRootSecret, "everpiece.link.voice.v1.key")), "AES-GCM", false, [usage]);

/** "audio/webm;codecs=opus" → "audio/webm"; null if the format isn't one v1 allows. */
export function audioTypeOf(mime: string): AudioType | null {
  const base = mime.split(";")[0].trim().toLowerCase();
  return (AUDIO_CODES as readonly string[]).includes(base) && base !== "" ? (base as AudioType) : null;
}

/** Envelope checks anyone can do without the key (the voice store uses this before accepting an upload). */
export function parseEnvelopeHeader(envelope: Uint8Array): EnvelopeHeader {
  if (envelope.length > MAX_ENVELOPE_BYTES) throw new MessageError("MessageTooLarge");
  if (envelope.length < HEADER_BYTES + IV_BYTES + TAG_BYTES + 2) throw new MessageError("MessageMalformed");
  if (envelope[0] !== MESSAGE_VERSION) throw new MessageError("MessageMalformed");
  const code = envelope[1];
  if (code >= AUDIO_CODES.length) throw new MessageError("MessageMalformed");
  const durationMs = new DataView(envelope.buffer, envelope.byteOffset).getUint32(2);
  const audioType = code === 0 ? null : AUDIO_CODES[code];
  if (durationMs > MAX_VOICE_MS || (audioType === null && durationMs !== 0) || (audioType !== null && durationMs === 0)) {
    throw new MessageError("MessageMalformed");
  }
  return { version: 1, audioType: audioType as AudioType | null, durationMs };
}

export const envelopeCommitment = (voiceRootSecret: Hex, envelope: Uint8Array): Hex =>
  metadataCommitment(keccak256(envelope), messageSalt(voiceRootSecret));

/** Encrypt on this device. `iv` is only for test vectors; production always uses a fresh random IV. */
export async function sealMessage(voiceRootSecret: Hex, m: Message, iv: Uint8Array = crypto.getRandomValues(new Uint8Array(IV_BYTES))): Promise<SealedMessage> {
  const note = utf8.encode(m.note);
  if ([...m.note].length > MAX_NOTE_CHARS || note.length > MAX_NOTE_BYTES) throw new MessageError("MessageTooLarge");
  if (note.length === 0 && !m.audio) throw new MessageError("MessageMalformed");
  if (iv.length !== IV_BYTES) throw new MessageError("MessageMalformed");
  const audio = m.audio?.bytes ?? new Uint8Array(0);
  if (m.audio && (audio.length === 0 || !Number.isInteger(m.audio.durationMs) || m.audio.durationMs < 1 || m.audio.durationMs > MAX_VOICE_MS)) {
    throw new MessageError("MessageMalformed");
  }

  const code = m.audio ? AUDIO_CODES.indexOf(m.audio.type) : 0;
  if (m.audio && code <= 0) throw new MessageError("MessageMalformed");
  const header = new Uint8Array(HEADER_BYTES);
  header[0] = MESSAGE_VERSION;
  header[1] = code;
  new DataView(header.buffer).setUint32(2, m.audio?.durationMs ?? 0);

  const plain = new Uint8Array(2 + note.length + audio.length);
  new DataView(plain.buffer).setUint16(0, note.length);
  plain.set(note, 2);
  plain.set(audio, 2 + note.length);

  const key = await aesKey(voiceRootSecret, "encrypt");
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: own(iv), additionalData: header, tagLength: 128 }, key, plain));
  const envelope = new Uint8Array(HEADER_BYTES + IV_BYTES + ct.length);
  envelope.set(header, 0);
  envelope.set(iv, HEADER_BYTES);
  envelope.set(ct, HEADER_BYTES + IV_BYTES);
  if (envelope.length > MAX_ENVELOPE_BYTES) throw new MessageError("MessageTooLarge");
  const envelopeHash = keccak256(envelope);
  return { envelope, locator: messageLocator(voiceRootSecret), envelopeHash, commitment: metadataCommitment(envelopeHash, messageSalt(voiceRootSecret)) };
}

/**
 * Check, then decrypt. `expectedCommitment` is the payment's on-chain metadataCommitment: a message that doesn't
 * match it is refused before decryption, and any changed byte fails AES-GCM authentication.
 */
export async function openMessage(voiceRootSecret: Hex, envelope: Uint8Array, expectedCommitment: Hex): Promise<Message> {
  const h = parseEnvelopeHeader(envelope);
  if (envelopeCommitment(voiceRootSecret, envelope).toLowerCase() !== expectedCommitment.toLowerCase()) throw new MessageError("MessageNotForThisPayment");
  let plain: Uint8Array;
  try {
    const key = await aesKey(voiceRootSecret, "decrypt");
    const iv = own(envelope.subarray(HEADER_BYTES, HEADER_BYTES + IV_BYTES));
    plain = new Uint8Array(
      await crypto.subtle.decrypt(
        { name: "AES-GCM", iv, additionalData: own(envelope.subarray(0, HEADER_BYTES)), tagLength: 128 },
        key,
        own(envelope.subarray(HEADER_BYTES + IV_BYTES)),
      ),
    );
  } catch {
    throw new MessageError("MessageTampered");
  }
  if (plain.length < 2) throw new MessageError("MessageMalformed");
  const noteLen = new DataView(plain.buffer).getUint16(0);
  if (noteLen > MAX_NOTE_BYTES || 2 + noteLen > plain.length) throw new MessageError("MessageMalformed");
  let note: string;
  try {
    note = new TextDecoder("utf-8", { fatal: true }).decode(plain.subarray(2, 2 + noteLen));
  } catch {
    throw new MessageError("MessageMalformed");
  }
  const audio = plain.subarray(2 + noteLen);
  if ((h.audioType === null) !== (audio.length === 0)) throw new MessageError("MessageMalformed");
  return h.audioType ? { note, audio: { bytes: own(audio), type: h.audioType, durationMs: h.durationMs } } : { note };
}
