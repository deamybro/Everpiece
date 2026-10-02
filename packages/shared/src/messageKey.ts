import { Aes256Gcm, CipherSuite } from "@hpke/core";
import { DhkemX25519HkdfSha256, HkdfSha256 } from "@hpke/dhkem-x25519";
import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, hexToBytes, type Address, type Hex } from "viem";
import { MONAD_MAINNET_CHAIN_ID } from "./constants.ts";
import { directoryDomain } from "./directory.ts";

/**
 * Messages for @username payments (master §23–24.4). The recipient has a message key: an X25519 key pair in its own
 * cryptographic domain, never the EVM key and never the inbox key (the directory sees the inbox key):
 *   seed    = HKDF-SHA256(passkey PRF output, salt none, info "everpiece.message-key.v1", 32 B)   EVERPIECE_MESSAGE_KEY_V1
 *   keypair = RFC 9180 DeriveKeyPair(DHKEM(X25519, HKDF-SHA256), seed)
 * Its public half is published in the directory, signed by the account (MessageKeyRegistration), so the directory
 * can't substitute a key of its own.
 *
 * The sender encrypts the message exactly as for a link (voice.ts envelope v1) under a FRESH random 32-byte message
 * secret, then seals that secret to the recipient with HPKE (RFC 9180, base mode):
 *   suite = DHKEM(X25519, HKDF-SHA256) · HKDF-SHA256 · AES-256-GCM      info = "everpiece.username.voice.v1"
 *   aad   = paymentId (32 B), so a wrap can't be moved to another payment
 *   wrap  = enc (32 B) ‖ ciphertext (32 B + 16 B tag) = 80 bytes, delivered with the inbox entry
 * HPKE: hpke-js (@hpke/core 1.9.0, @hpke/dhkem-x25519 1.8.0, pinned). It passes the RFC vectors (re-checked in
 * test/messageKey.test.ts) but is NOT formally audited; its X25519 comes from noble-curves (audited), AES-GCM from
 * Web Crypto (VERIFIED §4.13).
 */

export const MESSAGE_WRAP_BYTES = 80;
const INFO = new TextEncoder().encode("everpiece.username.voice.v1");

export const messageKeySuite = () => new CipherSuite({ kem: new DhkemX25519HkdfSha256(), kdf: new HkdfSha256(), aead: new Aes256Gcm() });
const suite = messageKeySuite();

/** EVERPIECE_MESSAGE_KEY_V1 seed. Re-derivable from the passkey on any device; privacy only, it can't move money. */
export function deriveEverpieceMessageSeedV1(prfOutput: Uint8Array): Uint8Array {
  if (prfOutput.length !== 32) throw new Error("prfOutput must be 32 bytes");
  return hkdf(sha256, prfOutput, undefined, new TextEncoder().encode("everpiece.message-key.v1"), 32);
}

/** The 32-byte X25519 public key for a seed (what the account publishes). */
export async function messagePublicKey(seed: Hex): Promise<Hex> {
  const kp = await suite.kem.deriveKeyPair(hexToBytes(seed));
  return bytesToHex(new Uint8Array(await suite.kem.serializePublicKey(kp.publicKey)));
}

export async function wrapMessageSecret(recipientMessageKey: Hex, paymentId: Hex, messageSecret: Hex): Promise<Hex> {
  const recipientPublicKey = await suite.kem.deserializePublicKey(hexToBytes(recipientMessageKey));
  const { enc, ct: ciphertext } = await suite.seal({ recipientPublicKey, info: INFO }, hexToBytes(messageSecret), hexToBytes(paymentId));
  const out = new Uint8Array(MESSAGE_WRAP_BYTES);
  out.set(new Uint8Array(enc), 0);
  out.set(new Uint8Array(ciphertext), 32);
  if (enc.byteLength !== 32 || ciphertext.byteLength !== 48) throw new Error("unexpected HPKE sizes");
  return bytesToHex(out);
}

/** Throws if the wrap wasn't made for this key AND this payment. */
export async function unwrapMessageSecret(seed: Hex, paymentId: Hex, wrap: Hex): Promise<Hex> {
  const w = hexToBytes(wrap);
  if (w.length !== MESSAGE_WRAP_BYTES) throw new Error("bad wrap length");
  const kp = await suite.kem.deriveKeyPair(hexToBytes(seed));
  const pt = await suite.open({ recipientKey: kp, enc: w.slice(0, 32), info: INFO }, w.slice(32), hexToBytes(paymentId));
  if (pt.byteLength !== 32) throw new Error("bad message secret");
  return bytesToHex(new Uint8Array(pt));
}

/** Signed by `account`: "this is my message key". Same EIP-712 domain as UsernameRegistration. */
export const MESSAGE_KEY_REGISTRATION_TYPES = {
  MessageKeyRegistration: [
    { name: "account", type: "address" },
    { name: "messageKey", type: "bytes32" },
    { name: "deadline", type: "uint256" },
  ],
} as const;
export type MessageKeyRegistration = { account: Address; messageKey: Hex; deadline: bigint };

export function messageKeyRegistration(escrow: Address, m: MessageKeyRegistration, chainId: number = MONAD_MAINNET_CHAIN_ID) {
  return {
    domain: directoryDomain(escrow, chainId),
    types: MESSAGE_KEY_REGISTRATION_TYPES,
    primaryType: "MessageKeyRegistration" as const,
    message: m,
  };
}
