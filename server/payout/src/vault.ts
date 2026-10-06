import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";
import type { Hex } from "viem";

/** Bank account numbers at rest (owner decision P4): AES-256-GCM under an HKDF subkey; never logged, never public. */
export class BankVault {
  private readonly key: Buffer;
  constructor(rootKey: Hex) {
    this.key = Buffer.from(hkdfSync("sha256", Buffer.from(rootKey.slice(2), "hex"), Buffer.alloc(0), "everpiece.payout.bank.enc.v1", 32));
  }
  encrypt(accountNumber: string): string {
    const iv = randomBytes(12);
    const c = createCipheriv("aes-256-gcm", this.key, iv);
    const ct = Buffer.concat([c.update(accountNumber, "utf8"), c.final()]);
    return [iv, c.getAuthTag(), ct].map((b) => b.toString("base64url")).join(".");
  }
  decrypt(blob: string): string {
    const [iv, tag, ct] = blob.split(".").map((s) => Buffer.from(s, "base64url"));
    const d = createDecipheriv("aes-256-gcm", this.key, iv);
    d.setAuthTag(tag);
    return Buffer.concat([d.update(ct), d.final()]).toString("utf8");
  }
}
export const newSalt = (): Hex => `0x${randomBytes(32).toString("hex")}`;
