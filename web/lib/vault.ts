import { getAddress, type Address } from "viem";
import { createSecretVaultWithExistingPasskey, decryptSecretVaultWithPasskey, parseSecretVault } from "@category-labs/mera";
import { VAULT_MAX_BYTES, VAULT_MAX_CONTACTS, VAULT_MAX_SENT, mergeAddressBook, parseAddressBook, vaultBackupTyped, vaultHashOf, type AddressBook } from "@everpiece/shared";
import { config } from "./config";
import { chainTime } from "./chain";
import { loadSent, saveSentList, type SentPayment } from "./flows";
import { withSigner, type Account } from "./mera";
import { PayError } from "./pay";
import { loadPins, savePins } from "./username";

/**
 * Encrypted address book (contacts + sent receipts), backed up so a new phone gets them back from the passkey alone.
 * Encryption happens HERE, with Mera's Secret Vault: a fresh PRF salt per backup (its own namespace), AES-256-GCM under
 * the passkey-derived key. The server only ever holds the ciphertext. It never contains money, keys or message secrets
 * (see packages/shared/src/vault.ts), and a restore only adds: it never replaces a contact this device already pinned.
 */
export const vaultAvailable = () => config.voiceUrl !== "";
const rpId = () => process.env.NEXT_PUBLIC_RP_ID || window.location.hostname;
const LAST_KEY = "everpiece.vault.last.v1";

export type VaultStatus = { backedUpAt: number | null; seq: number };
export const lastBackup = (): number | null => {
  try {
    return Number(localStorage.getItem(LAST_KEY)) || null;
  } catch {
    return null;
  }
};

function currentBook(): AddressBook {
  const contacts = Object.entries(loadPins()).map(([username, account]) => ({ username, account })).slice(0, VAULT_MAX_CONTACTS);
  const sent = loadSent()
    .slice(0, VAULT_MAX_SENT)
    .map((s) => ({ paymentId: s.paymentId, amount: s.amount, to: s.to, createdAt: s.createdAt, expiresAt: s.expiresAt })); // no message secrets, no delivery data
  return { v: 1, savedAt: Date.now(), contacts, sent };
}

async function remote(account: Address): Promise<{ vault: string; seq: number; updatedAt: number } | null> {
  const r = await fetch(`${config.voiceUrl}/v1/vault/${account}`).catch(() => null);
  if (!r) throw new PayError("NETWORK_UNAVAILABLE");
  if (r.status === 404) return null;
  if (!r.ok) throw new PayError("PROVIDER_UNAVAILABLE");
  return (await r.json()) as { vault: string; seq: number; updatedAt: number };
}

/** Two fingerprints: one encrypts (Mera vault, fresh salt), one signs "this is my vault now" for the server. */
export async function backUp(account: Account): Promise<{ contacts: number; receipts: number }> {
  if (!vaultAvailable()) throw new PayError("PROVIDER_UNAVAILABLE");
  const book = currentBook();
  const plain = new TextEncoder().encode(JSON.stringify(book));
  if (plain.length > VAULT_MAX_BYTES / 2) throw new PayError("INVALID_AMOUNT");
  const vault = await createSecretVaultWithExistingPasskey({ rpId: rpId(), credential: { credentialId: account.credentialId, transports: account.transports }, secret: plain });
  plain.fill(0);
  const json = JSON.stringify(vault);
  const existing = await remote(account.address);
  const seq = (existing?.seq ?? 0) + 1;
  const deadline = (await chainTime()) + 300n;
  const signature = await withSigner(account, (signer) => signer.signTypedData(vaultBackupTyped(config.directoryDomain, { account: getAddress(account.address), vaultHash: vaultHashOf(json), seq: BigInt(seq), deadline }, config.chainId)));
  const r = await fetch(`${config.voiceUrl}/v1/vault/${account.address}`, {
    method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ vault: json, seq: String(seq), deadline: String(deadline), signature }),
  }).catch(() => null);
  if (!r) throw new PayError("NETWORK_UNAVAILABLE");
  if (!r.ok) throw new PayError("PROVIDER_UNAVAILABLE");
  localStorage.setItem(LAST_KEY, String(Date.now()));
  return { contacts: book.contacts.length, receipts: book.sent.length };
}

/** One fingerprint: decrypt the stored vault with this passkey and add what this device is missing. */
export async function restore(account: Account): Promise<{ addedContacts: number; addedReceipts: number } | null> {
  if (!vaultAvailable()) throw new PayError("PROVIDER_UNAVAILABLE");
  const stored = await remote(account.address);
  if (!stored) return null;
  const plain = await decryptSecretVaultWithPasskey({ rpId: rpId(), vault: parseSecretVault(stored.vault) });
  const book = parseAddressBook(new TextDecoder().decode(plain));
  plain.fill(0);
  if (!book) throw new PayError("PROVIDER_UNAVAILABLE");
  const sentNow = loadSent();
  const merged = mergeAddressBook({ pins: loadPins(), sent: sentNow.map((s) => ({ paymentId: s.paymentId, amount: s.amount, to: s.to, createdAt: s.createdAt, expiresAt: s.expiresAt })) }, book);
  savePins(merged.pins);
  const have = new Set(sentNow.map((s) => s.paymentId.toLowerCase()));
  const added: SentPayment[] = merged.sent.filter((s) => !have.has(s.paymentId.toLowerCase())).map((s) => ({ paymentId: s.paymentId, sender: account.address, amount: s.amount, to: s.to, createdAt: s.createdAt, expiresAt: s.expiresAt }));
  saveSentList([...sentNow, ...added].sort((a, b) => b.createdAt - a.createdAt));
  localStorage.setItem(LAST_KEY, String(stored.updatedAt));
  return { addedContacts: merged.addedContacts, addedReceipts: merged.addedSent };
}
