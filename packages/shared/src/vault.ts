// Encrypted address book (contacts + sent receipts). The plaintext below is encrypted ON THE DEVICE with Mera's Secret
// Vault (AES-256-GCM under a key derived from a fresh passkey PRF salt) and only the ciphertext is stored on the server.
// The server cannot read it, and a new device recovers it with the same passkey. Nothing here is money: restoring it
// never moves or restores funds, and it never overwrites a contact the device already pinned.
import { keccak256, toHex, type Address, type Hex } from "viem";
import { directoryDomain } from "./directory.ts";
import { MONAD_MAINNET_CHAIN_ID } from "./constants.ts";

export const VAULT_MAX_BYTES = 64 * 1024;
export const VAULT_MAX_CONTACTS = 500;
export const VAULT_MAX_SENT = 200;

export type VaultContact = { username: string; account: Address };
export type VaultSent = { paymentId: Hex; amount: string; to: string; createdAt: number; expiresAt: string };
export type AddressBook = { v: 1; savedAt: number; contacts: VaultContact[]; sent: VaultSent[] };

const ADDR = /^0x[0-9a-fA-F]{40}$/;
const HEX32 = /^0x[0-9a-fA-F]{64}$/;
const NAME = /^[a-z0-9_]{1,32}$/;

/** Strict parse of decrypted text: anything outside this shape is dropped or refused. Never throws. */
export function parseAddressBook(text: string): AddressBook | null {
  try {
    const o = JSON.parse(text) as Record<string, unknown>;
    if (!o || o.v !== 1 || !Array.isArray(o.contacts) || !Array.isArray(o.sent) || o.contacts.length > VAULT_MAX_CONTACTS || o.sent.length > VAULT_MAX_SENT) return null;
    const contacts: VaultContact[] = [];
    for (const c of o.contacts as Record<string, unknown>[]) {
      if (typeof c?.username === "string" && NAME.test(c.username) && typeof c.account === "string" && ADDR.test(c.account)) contacts.push({ username: c.username, account: c.account as Address });
    }
    const sent: VaultSent[] = [];
    for (const s of o.sent as Record<string, unknown>[]) {
      if (typeof s?.paymentId === "string" && HEX32.test(s.paymentId) && typeof s.amount === "string" && /^[0-9]{1,30}$/.test(s.amount) && typeof s.to === "string" && s.to.length <= 120
        && typeof s.createdAt === "number" && Number.isFinite(s.createdAt) && typeof s.expiresAt === "string" && /^[0-9]{1,20}$/.test(s.expiresAt)) {
        sent.push({ paymentId: s.paymentId as Hex, amount: s.amount, to: s.to, createdAt: s.createdAt, expiresAt: s.expiresAt });
      }
    }
    return { v: 1, savedAt: typeof o.savedAt === "number" ? o.savedAt : 0, contacts, sent };
  } catch {
    return null;
  }
}

/**
 * What a restore may add to this device: contacts it does NOT already pin (a pinned address is never replaced: that pin is
 * what warns the user if a username's account changes) and receipts it doesn't have. Pure; the caller writes the result.
 */
export function mergeAddressBook(local: { pins: Record<string, Address>; sent: VaultSent[] }, remote: AddressBook): { pins: Record<string, Address>; sent: VaultSent[]; addedContacts: number; addedSent: number } {
  const pins = { ...local.pins };
  let addedContacts = 0;
  for (const c of remote.contacts) {
    if (!(c.username in pins)) {
      pins[c.username] = c.account;
      addedContacts++;
    }
  }
  const have = new Set(local.sent.map((s) => s.paymentId.toLowerCase()));
  const extra = remote.sent.filter((s) => !have.has(s.paymentId.toLowerCase()));
  const sent = [...local.sent, ...extra].sort((a, b) => b.createdAt - a.createdAt).slice(0, VAULT_MAX_SENT);
  return { pins, sent, addedContacts, addedSent: extra.length };
}

// ── authenticated writes: the account signs "I replace my vault with this one" ────────────────────────────────────────
export const vaultHashOf = (vaultJson: string): Hex => keccak256(toHex(vaultJson));

export const VAULT_BACKUP_TYPES = {
  VaultBackup: [
    { name: "account", type: "address" },
    { name: "vaultHash", type: "bytes32" },
    { name: "seq", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
} as const;
export type VaultBackup = { account: Address; vaultHash: Hex; seq: bigint; deadline: bigint };

export function vaultBackupTyped(domainAddress: Address, m: VaultBackup, chainId: number = MONAD_MAINNET_CHAIN_ID) {
  return { domain: directoryDomain(domainAddress, chainId), types: VAULT_BACKUP_TYPES, primaryType: "VaultBackup" as const, message: m };
}
