import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes } from "node:crypto";
import type { Hex } from "viem";

/**
 * Phone numbers (and, for the email channel, email addresses) are sensitive application data (master §12.3).
 * The HKDF labels keep their original "phone" names so existing keys and data stay valid. AES-256-GCM at rest, keyed-HMAC lookup keys
 * (a plain hash of a phone number is trivially brute-forced), masked for display, never logged, never on-chain.
 * Two independent subkeys are derived from PHONE_ENC_KEY with HKDF and explicit labels.
 */
export class PhoneVault {
  private readonly encKey: Buffer;
  private readonly macKey: Buffer;

  constructor(rootKey: Hex) {
    const root = Buffer.from(rootKey.slice(2), "hex");
    this.encKey = Buffer.from(hkdfSync("sha256", root, Buffer.alloc(0), "everpiece.claims.phone.enc.v1", 32));
    this.macKey = Buffer.from(hkdfSync("sha256", root, Buffer.alloc(0), "everpiece.claims.phone.mac.v1", 32));
  }

  encrypt(e164: string): string {
    const iv = randomBytes(12);
    const c = createCipheriv("aes-256-gcm", this.encKey, iv);
    const ct = Buffer.concat([c.update(e164, "utf8"), c.final()]);
    return [iv, c.getAuthTag(), ct].map((b) => b.toString("base64url")).join(".");
  }

  decrypt(blob: string): string {
    const [iv, tag, ct] = blob.split(".").map((s) => Buffer.from(s, "base64url"));
    const d = createDecipheriv("aes-256-gcm", this.encKey, iv);
    d.setAuthTag(tag);
    return Buffer.concat([d.update(ct), d.final()]).toString("utf8");
  }

  /** Stable per-phone key for rate limits / duplicate detection. */
  lookupKey(e164: string): string {
    return createHmac("sha256", this.macKey).update(e164).digest("base64url");
  }
}

/** Email invites use the same vault; their lookup key is namespaced so it can never equal a phone's. */
export const emailLookupInput = (email: string) => `email:${email}`;

/** "mama.ngozi@example.com" → "m•••@example.com". */
export function maskEmail(email: string): string {
  const at = email.lastIndexOf("@");
  return `${email.slice(0, 1)}•••${email.slice(at)}`;
}

/** "+2348000000000" → "+234 ••• ••• 0000". */
export function maskPhone(e164: string): string {
  const cc = e164.slice(0, Math.max(2, e164.length - 10));
  return `${cc} ••• ••• ${e164.slice(-4)}`;
}
