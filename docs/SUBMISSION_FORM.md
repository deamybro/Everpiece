# Metropolis submission form: paste-ready text (deadline Oct 14 2026, 04:59 GMT+1)

Each block is sized for its box (limits in brackets). Everything is from verified facts (see `docs/SUBMISSION.md` for transaction hashes). Replace nothing except the `<…>` placeholders: your public repo URL, demo video URL, pitch video URL, and your team name.

- **Live product link:** https://app.everpiece.xyz (Monad mainnet, chain 143). Mobile-first; open it on a phone.
- **Repo:** `<your public GitHub URL>` (push first; see the pre-push checklist at the bottom).

---

## Project details

**Project name [120]:** Everpiece

**Tagline [200]:**
Send dollars, including AUSD, to anyone on Monad with one fingerprint: no seed phrase, no gas, and payable from any chain by someone with no account.

**Project description [8000]:**
Everpiece is a mobile-first payments app on Monad. The goal is that a person can get paid and pay in dollars without ever noticing there is a blockchain underneath.

Sign-up is one fingerprint: a Mera passkey creates the account. There is no seed phrase, no browser extension and no email or SMS code. The person picks a username and can immediately send and receive. Their balance shows USDC and AUSD side by side.

Sending is gasless. The user signs the exact payment, a relayer submits it, and the contract enforces precisely what was signed (amount, recipient, a spending limit and a deadline). Payments between Everpiece accounts settle on Monad in about one block.

People who are not on Everpiece yet can still pay and be paid. Anyone with a wallet on Base, Ethereum, Arbitrum, Optimism, Polygon, Avalanche, Gnosis or BNB Chain can open a user's pay link and pay it with USDC. Aurora Intents moves the money and the recipient receives USDC on Monad. The sender needs no bridge, no swap and no Everpiece account. A real BNB Chain payment and a real Base payment both arrived on mainnet.

For recipients with no account yet, a payment can be sent to a phone number or email as a protected payment: the recipient verifies and claims it, and if it is never claimed the sender can reclaim it after it expires.

Paying in a dollar the recipient wants: a payment funded in USDC can arrive as AUSD. The contract tries Agora's AUSD/USDC Instant Settlement pair when Agora has approved our contract, and otherwise a fixed, permissionless Uniswap v4 AUSD/USDC pool. If neither can deliver, the payment fails with nothing moved, or, only if the sender signed that choice, delivers USDC. The app never says AUSD arrived when it did not.

Money can also work while it waits: AUSD can be put into Aave or Morpho's Grove x Steakhouse AUSD vault and withdrawn, without gas, with the shares always held by the user and never by us.

Privacy and control: messages and voice notes attached to payments are end-to-end encrypted with keys derived from the user's own passkey. An optional private balance (TACEO Merces) hides sender, receiver and amount for private sends. Rules ("when I get paid, keep half and put half into Earn") run only within limits the user signs, and a Copilot can draft such a rule from a sentence; it only proposes, and the user must read and sign it.

Everything above runs on Monad mainnet with real money under small beta limits per payment and per day.

**What is not finished (stated plainly):** the live USDC to AUSD conversion uses Uniswap v4 until Agora grants our contract the approved-swapper role. Nigerian bank payout is designed and shown as "Coming Soon". Stock investing is not live. Account recovery depends on passkey sync (Google or iCloud); Everpiece has no way to restore a lost passkey.

**How we built it / technical [8000]:**
- **Account layer:** Mera 0.2 passkeys with the PRF extension. The account key, an inbox key, a message seed and the private-balance credential are all derived from one passkey on the device and never stored or sent. Account state reconstructs from the passkey alone.
- **Contracts (Solidity 0.8.28, Foundry):** EverpiecePayV2 (direct and converted payments, signed fallback, gas floors), EverpieceStableConverter (fixed Uniswap v4 AUSD/USDC route), EverpieceEscrowUsdc (protected payments), EverpieceEarn and EverpieceEarnUsdc (ERC-4626 vaults, shares always owned by the user), EverpieceAutomate (bounded grants). Fork tests run against the real tokens and pools on Monad.
- **Relayer:** a small Node service pays gas for signed actions, with measured gas limits per action, per-payment and per-day caps, and idempotency. A signed payment can only do what it says.
- **Cross-chain:** Aurora Intents deposits and quotes. The app refuses any quote whose recipient or amount differs from the request, tracks the deposit to delivery, and shows the Monad transaction.
- **Indexer:** Envio HyperIndex with Postgres and Hasura, serving payment history, rule triggers and public metrics.
- **Encrypted data:** payment messages (E2E, per-payment keys), and an encrypted address book stored as a Mera Secret Vault so a new phone recovers contacts and receipts from the passkey.
- **Hardening:** strict per-request nonce CSP, no secrets in the repo, transaction success checked at the finalized block, and every external fact traced to `docs/VERIFIED.md`.

---

## Pitch video script (up to 2:00)
1. (0:00) "I'm <name>, building Everpiece." One sentence on who you are.
2. (0:10) The problem: "Sending dollars across borders still means apps, exchanges, seed phrases, fees, and a recipient who has to have the same app."
3. (0:30) The idea: "Everpiece makes it one fingerprint. You get a username, you send dollars, and the person on the other end doesn't need an account, or even to be on Monad."
4. (0:55) Show the app for ten seconds (home with USDC and AUSD).
5. (1:10) Why now and why Monad: instant, near-free settlement; passkeys; stablecoins like AUSD.
6. (1:35) What's next: Nigerian bank payout, Agora's approved-swapper role, wider chains. Close: "Dollars, across borders, with one fingerprint."

## Demo video (up to 3:00 on the main form; each bounty video up to 2:00)
Use the shot lists in `docs/SUBMISSION.md` (Agora and Aurora) and below (Mera). If you can record only one, record one 2:50 video in this order: onboarding (0:20), AUSD balance and a gasless send with the unlock session (0:50), receiver's balance (0:15), cross-chain payment arriving (0:50), encrypted backup and restore on a second device (0:40).

---

## Bounty: Agora, Best Cross-Border Payments App [8000]
**Describe the core features, with a focus on sending AUSD to another person or across borders:**
See `docs/SUBMISSION.md` section 1 and paste it as written. In short: one-fingerprint Mera onboarding; AUSD and USDC balances; gasless AUSD sends to a `@username` that settle in about one block; payment funded in USDC delivered as AUSD through Agora's pair when approved, otherwise a fixed Uniswap v4 pool, and never a false "AUSD delivered"; pay from other chains with no account on the sending side (BNB Chain and Base payments arrived on mainnet); phone and email protected payments; AUSD Earn through Aave and Morpho. Evidence: AUSD payment tx `0x94230dfe405f01e6e9f7f5555d5dd19ce9c4d7b0cd235720df347be8179f7cf1`, USDC to AUSD conversion tx `0x1286fcf6bae499082850aa34f768bbfabdd662bf3b6c4a88e04d5b89aa4f5ec2`. Limit stated plainly: the Agora pair route is built and waiting for Agora's approved-swapper grant; the live conversion uses Uniswap v4. The bounty suggested mocking funds on testnet; we run mainnet with real money under small caps.
**Demo video:** `<video URL>`

## Bounty: Aurora Intents, Bring Any-Chain Liquidity to Monad [8000]
**Product used:** Intents Deposits and the Swap API (quote with a one-time deposit address).
**How it integrates (paste `docs/SUBMISSION.md` section 2).** Evidence: BNB Chain to Monad delivery tx `0xc8421567d3d4b3ecac74ac3049d86649b79385c7bd9010a83859f2c91c677a2b`; Base to Monad (confidential option ticked) tx `0xb95216500365fc174f8e6c38f9bcb44ce908ac1d6ed29d0ada25a60a195fe842`. Eight source chains. Quote safety checks, refund address in every quote, delivery tracking, plain "takes a few minutes" messaging. The confidential option sends Aurora's confidential setting; we say exactly what Aurora says it hides and nothing more: the delivery on Monad, its amount and recipient stay public, and we cannot verify the hiding from Monad.
**Demo video:** `<video URL>`

## Bounty: Envio, Best Use of Envio [8000]
**How the project uses Envio:**
Everpiece runs an Envio HyperIndex indexer (envio 3.12.1, pinned) over Monad mainnet (chain 143). It indexes EverpieceEscrow, EverpiecePay, EverpiecePayV2 and EverpieceEarn events into Postgres, served through Hasura GraphQL at `/svc/indexer/v1/graphql`. Entities: Payment, PaymentEvent, InstantPayment (with asset and requested asset), EarnEvent, Account and Stats. The indexer runs in Docker on our own server with reorg rollback on and a one-block lag behind finality. It is live and tracking the chain head: it was 3 blocks behind the head when we last checked.
It does real work in three places: (1) the app's payment history reads from it; (2) the Automate service's watcher polls it for incoming payments at finality and turns them into rule triggers; (3) the public "Everpiece in numbers" page reads the Stats entity. Money truth is never taken from the indexer: balances and settlement are re-read on-chain at the finalized block. Handler and ABI tests check that the indexed events match the contracts' ABI.
**Honest note:** it reads through the public RPC rather than HyperSync.

## Bounty: Mera, One Passkey, Many Keys [8000]
**How the project uses Mera in non-account work:**
Everpiece derives several independent, non-signing keys from the one passkey PRF output on the device, with nothing stored or sent. (1) An inbox key and a message seed that encrypt and open the voice notes and text messages attached to payments: end-to-end encrypted with per-payment keys, so the server only holds ciphertext it cannot read. (2) The credential for the private balance (TACEO Merces) is derived from the signer on each action. (3) An encrypted address book (contacts and sent receipts) stored in a Mera Secret Vault: a fresh PRF salt per backup (its own namespace), AES-256-GCM under the passkey-derived key. The server stores only the vault JSON and replaces it only against the account's own signature, a higher sequence number and a short deadline.
**Cross-device test:** sign in on a second device or a fresh browser profile with the same passkey, tap Restore here, and the contacts and receipts reappear; a message sent to the account opens there too. Restoring only adds: it never replaces a contact the device already pinned.
**Demo video:** `<video URL>`

## Bounty: Mera, Best Mera-Powered UX on Monad [8000]
**How the project integrates Mera as the entire account layer:**
Mera is the only account layer: no seed phrase, no extension, no custody backend, no email or SMS code to sign up. One passkey ceremony creates the account and a username. Our relayer only pays gas for payments the user signed; it never holds keys.
**Session design:** one fingerprint opens a scoped, in-memory Mera signing session for 5 minutes with a cap the user picks ($10, $20 or $50). Small payments and Earn deposits inside it need no further prompt. The session closes on the timer, when the cap is used, after 30 seconds off the page, or on "Lock now", and the key is zeroed. Actions that declare no amount (account changes, rules, private payments) always ask. The cap is enforced by our app, not by Mera or the chain, and we say so.
**Stateless test:** clear local storage or open a fresh device, sign in with the passkey, and the account, username and balance reconstruct; the encrypted address book restores with one more fingerprint.
**Stack composability:** gasless relayer, Aurora Intents funding, Aave and Morpho vaults, and an on-chain bounded-grant contract for optional unattended rules.
**Demo video:** `<video URL>`

---

## Before you press Submit
- Fill the logo (square PNG, at least 500 px, under 2 MB).
- Paste the live link, repo URL and video URLs.
- Click **Save progress**, then **Submit** (saving alone does not submit).
- **Repo pre-push check (ask me to run it):** secrets, key files, `.env`, and any text you do not want public. The repo must be public or shared with metropolis@hackathon.monad.xyz.
