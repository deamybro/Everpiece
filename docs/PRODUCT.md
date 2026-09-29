# PRODUCT.md — Everpiece

> **Send money to the right person, and let them choose what it becomes.**

Source of truth: Master Build Prompt v3.2 §1–§2. Maris owns scope; agents recommend.

## 1. Definition

Everpiece is a **mobile-first Next.js web app, installable as a PWA**, on Monad mainnet. There is no native app for the hackathon.
A sender sends Dollars to a **person**. The payment stays protected until the intended recipient claims it. After claiming, the recipient chooses what the value becomes: **Keep Dollars · Cash out · Own a Piece · Split**.

Core promise: *Your money stays yours until the right person has it. Then it's theirs to spend, save or own.*

## 2. Irreducible product (must work if every optional integration fails)

Gasless, protected person-to-person Dollar payments with recipient-bound claims, cancellation, expiry/refunds and encrypted personal messages.

Core = escrow contract + Mera accounts + relayer + claim flows + messages. Everything else is optional.

## 3. Core flows

**Sender:** Choose person → Enter Dollars → Optional text/voice/occasion → Review → Fingerprint → *Payment protected*
**Recipient:** Open Everpiece → Verify you're the intended recipient → Hear/read message → Fingerprint → *Claim Dollars* → Choose what happens next

- **Existing user:** `@mama` resolves (off-chain) to her Mera account → username-mode payment.
- **New user:** secure claim **link** shared by the sender through any channel (WhatsApp, Telegram, SMS, email, iMessage, QR, share sheet). No deep messaging integration. Claiming requires the link *and* verifying the contact the sender entered (two-capability model, ESCROW_SPEC §3.2).
- **Sender can cancel** until claimed. Unclaimed payments **return automatically** after expiry.

**Hard rule:** ESCROW → CLAIM → RECIPIENT OWNS DOLLARS. Only then Keep / Cash out / Own a Piece / Split. A provider failure never invalidates a valid claim.

## 4. Fees

Everpiece fee for hackathon V1: **zero** (unless Maris changes it). Provider costs shown honestly. Review screen shows:
You send · Funding/provider fee · Everpiece fee · Recipient receives · Recipient · Expiry.
Users never need MON; the relayer pays gas. Consumer copy: **"Free to claim."** Never "Buy MON for gas."

## 5. Terminology (consumer UI)

| Say | Never say |
|---|---|
| Dollars | AUSD |
| Piece of Apple | RWA ERC-20 |
| Fingerprint | WebAuthn PRF |
| Claim | execute contract |
| Money returned | escrow refund transaction |
| Free to claim | gas-sponsored meta-transaction |

Self-description: "mobile-first web app / installable PWA" — never "native mobile app".

## 6. Personal layer

Optional text, voice note, occasion (Birthday, Graduation, Wedding, Family support, Holiday, Just because). Encrypted client-side. Not AI.

## 7. Scope

**Core (must ship):** username payments, link payments, claim, cancel, expiry refund, messages, zero-fee display, PWA install.
**Optional (only if core is solid; each must be honestly labeled DISABLED/SIMULATED/SANDBOX/LIVE):** Ramp, Aurora Intents, Monday Trade (Own a Piece), payout provider (cash out), Circle CCTP, Unlink, Chainlink CRE, recurring splits.
**Out of scope:** cards, yield, lending, trading terminal, charts, copy trading, DAO, token, governance, generic wallet, group wallets, autonomous agents/portfolio managers, multi-token escrow, corporate actions, merchant acquiring.

AI never chooses recipient, amount, allocation, stock, sale, cash-out or split (Master Prompt §0.8).

## 8. UX rules

- Design first for **budget Android + Chrome**; also test iOS Safari, desktop Chrome, WhatsApp and Telegram in-app browsers.
- Never assume in-app WebViews support passkeys/PRF. If not: "Open securely in your browser to continue." Handoff technique must be tested on real devices.
- Claim-link secrets live after `#`; parse, validate, move to memory, then `history.replaceState` once the handoff is done. Never send to server, log, cache, or report.
- PWA service worker never caches claim URLs, OTP responses, approvals, or secret-bearing requests.
- Cancel copy: "Cancel works only if they haven't claimed yet." Cancel is available until expiry. After expiry the money returns automatically (default expiry 30 days; allowed range 1–30 days, pending Maris confirmation).
- Recipient pinning: after the first successful payment, the recipient's account and key are pinned on the device. If they change: "This recipient's security details changed. Verify them before sending."
- Recovery honesty: "Your account lives in your passkey. If you lose access to your passkey, Everpiece can't restore it." (THREAT_MODEL §F7)

## 9. Application states (master §30, D9)

**Transaction inclusion is not application success.**
- Canonical on-chain states: ACTIVE · CLAIMED · CANCELLED · REFUNDED (EXPIRED is derived).
- In-flight UI states: SUBMITTED ("Sending…") → PROCESSING ("Protecting your payment…").
- Show **Sent / Claimed / Cancelled / Money returned** only after the receipt succeeded, the expected escrow event was observed, the on-chain state matches, and the block is final (ESCROW_SPEC §17).
- On failure, show failure and re-read chain state. Never override it.

Failure copy (master §37):
- Funding: "Funding didn't complete. No payment was created."
- Claim: "Your money is still protected. Try again."
- Cancel: never show "Money returned" until the refund actually succeeded.
- Payout: "Bank payout failed. Your Dollars are still safe."
- Piece: "The purchase didn't execute. Your Dollars remain safe."

Other derived states (Viewed, Claimable, Expired, Payout pending, …) never override chain truth. Money math uses bigint base units only (master §39).
