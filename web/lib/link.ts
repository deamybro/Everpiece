import { bytesToHex, hexToBytes, type Hex } from "viem";
import { generatePrivateKey } from "viem/accounts";

/**
 * Client claim package v1 (ESCROW_SPEC §4) — lives ONLY in the URL fragment, never sent to any server:
 *   0x01 ‖ claimPrivateKey(32) ‖ voiceRootSecret(32) ‖ recipientSalt(32)   → base64url
 * claimPrivateKey comes from viem's audited secp256k1 key generation; the other two are independent random bytes.
 */
export type ClaimPackage = { claimPrivateKey: Hex; voiceRootSecret: Hex; recipientSalt: Hex };

const b64url = (b: Uint8Array) => btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const unb64url = (s: string) => {
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
};

export function randomBytes32(): Hex {
  return bytesToHex(crypto.getRandomValues(new Uint8Array(32)));
}

export function newClaimPackage(): ClaimPackage {
  return { claimPrivateKey: generatePrivateKey(), voiceRootSecret: randomBytes32(), recipientSalt: randomBytes32() };
}

export function encodePackage(p: ClaimPackage): string {
  const out = new Uint8Array(97);
  out[0] = 1;
  out.set(hexToBytes(p.claimPrivateKey), 1);
  out.set(hexToBytes(p.voiceRootSecret), 33);
  out.set(hexToBytes(p.recipientSalt), 65);
  return b64url(out);
}

export function decodePackage(fragment: string): ClaimPackage | null {
  try {
    const b = unb64url(fragment.replace(/^#/, ""));
    if (b.length !== 97 || b[0] !== 1) return null;
    return {
      claimPrivateKey: bytesToHex(b.slice(1, 33)),
      voiceRootSecret: bytesToHex(b.slice(33, 65)),
      recipientSalt: bytesToHex(b.slice(65, 97)),
    };
  } catch {
    return null;
  }
}

export function claimLink(paymentId: Hex, p: ClaimPackage): string {
  return `${window.location.origin}/c/${paymentId}#${encodePackage(p)}`;
}
