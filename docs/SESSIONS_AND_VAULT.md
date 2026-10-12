# Scoped signing session and encrypted address book (2026-10-12)

## Scoped signing session (`web/lib/session.ts`, `web/components/SessionBar.tsx`)
- One fingerprint opens a Mera secp256k1 signing session that is kept in this tab's memory only, for 5 minutes and up to $10, $20 or $50 (the user picks).
- Only actions that declare an amount may use it: payments (`payV2`, `pay`) and Earn deposits. Account changes, rules, grants, private payments, protected (link/phone/email) sends, withdrawals and anything without an amount always ask.
- It closes by itself on: timer, cap used up, the page hidden for 30 s, page hide, or "Lock now". `end()` zeroes the key.
- **The cap is enforced by this app, not by Mera and not by the chain.** Script running on this origin could sign while a session is open; that is why the CSP is strict (THREAT_MODEL F1) and why sessions are short and small.

## Encrypted address book (`packages/shared/src/vault.ts`, `web/lib/vault.ts`, voice store `/v1/vault/<account>`)
- Contacts (pinned usernames) and sent receipts are encrypted on the device with Mera's Secret Vault: a fresh PRF salt per backup (its own namespace), AES-256-GCM under the passkey-derived key. The server stores only the ciphertext.
- Never in the backup: money, keys, message secrets, delivery data.
- Writes need the account's signature over the exact vault, a higher sequence number and a deadline of at most 10 minutes. Reads are open (ciphertext is useless without the passkey).
- A restore only ADDS: a contact already pinned on the device is never replaced (that pin is what warns if a username's account changes).
- Cross-device test: same passkey on another device or a fresh browser profile, sign in, tap "Restore here" (one fingerprint).
