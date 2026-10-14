# Submission texts and video scripts (Metropolis, deadline Oct 14 2026, 04:59 GMT+1)

Everything below is written from what is verified. Items in **[CHECK]** need you to confirm before you paste them. Do not add claims that are not in this file.

Live app: https://app.everpiece.xyz (mobile-first installable web app, Monad mainnet, chain 143).

## Evidence you can point to (all on Monad mainnet)
| What | Proof |
|---|---|
| USDC to AUSD conversion through our fixed Uniswap v4 route, delivered exactly $1.000000 AUSD, spent $0.999844 USDC | tx `0x1286fcf6bae499082850aa34f768bbfabdd662bf3b6c4a88e04d5b89aa4f5ec2` |
| A real payment from a BNB Chain wallet (USDC, $0.50) arrived as USDC on Monad with no Everpiece account on the sender's side | delivery tx `0xc8421567d3d4b3ecac74ac3049d86649b79385c7bd9010a83859f2c91c677a2b` |
| AUSD into the Morpho vault and back through the gasless relayer, $1.00 in, $1.00 out | deposit `0x3cb08c1334c57f056d5328122e73f76ce089e30331e61668e6ec6481e3fbec40`, withdraw `0x38508590f5ae80a7129623a544e89e32a0ed79df49f3c24cbe1346812af58db6` |
| A second $0.50 cross-chain payment from Base with the confidential option ticked; arrived at the same account, delivered by the same Aurora address as the non-confidential one | tx `0xb95216500365fc174f8e6c38f9bcb44ce908ac1d6ed29d0ada25a60a195fe842` |
| Direct AUSD payment, $1.000000 delivered gaslessly to an app account | tx `0x94230dfe405f01e6e9f7f5555d5dd19ce9c4d7b0cd235720df347be8179f7cf1` |
| EverpiecePayV2 (payments, conversion) | `0x29D15Bb918589B9dF84EdE5c3B5A7a3Ec89c8eb5` |
| AUSD Earn (Aave + Morpho vaults) | `0x4bb7d4ce29f7c8410576cdf084637c790fd44e5a` |

---

## 1. Agora: Best Cross-Border Payments App

**Core features (paste):**

Everpiece is a mobile-first payments app on Monad where anyone can send dollars, including AUSD, to another person across borders in seconds, with no seed phrase, no browser extension and no gas.

- **One-fingerprint onboarding.** A Mera passkey creates the account. There is no seed phrase and no email or SMS code to sign up. A user is ready to send after a single fingerprint and picking a username.
- **AUSD and USDC side by side.** The balance shows both. Sending AUSD to a `@username` settles on Monad in about one block. The sender pays no gas: a relayer submits the signed payment and the contract enforces the exact amount the sender signed.
- **Paying in a dollar the recipient wants.** A sender can fund a payment from USDC and the recipient receives AUSD. The contract tries Agora's AUSD/USDC Instant Settlement pair first (it needs Agora's approved-swapper status for our contract, **[CHECK: write "requested" only if you have sent the request in docs/AGORA_APPROVAL_REQUEST.md, otherwise "being requested"]**) and otherwise a fixed, permissionless Uniswap v4 AUSD/USDC pool. If neither works, the payment either fails with nothing moved, or, only if the sender signed that choice, delivers USDC. The app never says AUSD was delivered when it was not.
- **Across borders without an account.** Anyone with a wallet on another chain can pay a user's pay link (`/to/<username>`) with USDC from Base, Ethereum, Arbitrum, Optimism, Polygon, Avalanche, Gnosis or BNB Chain. Aurora Intents moves it and the recipient receives USDC on Monad. A real BNB Chain payment of $0.50 arrived this way.
- **Reaches people who are not on Everpiece yet.** Send to a phone number or email as a protected payment: the recipient verifies and claims, and an unclaimed payment can be reclaimed by the sender after it expires.
- **Money that works while it waits.** AUSD can be placed into Aave or Morpho's Grove x Steakhouse AUSD vault and withdrawn without gas.
- **Business viability.** Revenue comes from a small relayer fee and the conversion spread, with Aurora's integrator revenue share on cross-chain payments. The cost per payment is gas, which on Monad is a fraction of a cent. Nigerian bank payout is designed and shown as "Coming Soon".

**Honest limits (say them if asked):** the live conversion today uses Uniswap v4 until Agora grants our contract the approved-swapper role. Bank payout and private payments are not part of this demo. The app runs on mainnet with real money under per-payment and per-day beta caps.

**Demo video (max 2:00) shot list:**
1. 0:00 Open the app on a phone, tap Create account, fingerprint. Say: "No seed phrase, no extension."
2. 0:15 Choose a username. Show the balance with **AUSD** and USDC rows. **[CHECK: the demo account must hold at least $2 of AUSD, see "Prep" below]**
3. 0:30 Send: pick AUSD, enter `@friend`, amount $1, review screen, fingerprint. Show "Paid" and the receipt link to the Monad transaction.
4. 0:55 Second phone (or second browser profile): the friend's balance has gone up by $1 in the same moment.
5. 1:10 Cross-border: on a computer, open the friend's pay link, pick USDC on BNB Chain, copy the deposit address, send from a crypto wallet. Say: "No Everpiece account needed on the sending side."
6. 1:40 Show "Paid" arriving and the friend's balance. Close with the one line: "AUSD, across borders, with one fingerprint."

---

## 2. Aurora Intents: Bring Any-Chain Liquidity to Monad

**How the project integrates Aurora Intents (paste):**

Everpiece uses **Aurora Intents deposits and the Swap API** for payments that arrive from other chains.

- **The flow.** A user (or anyone, with no Everpiece account) opens a pay link, picks the chain and token they hold, gives a refund address, and gets a one-time Aurora deposit address and the exact amount to send. Aurora delivers USDC straight to the recipient's account on Monad. Nothing passes through an Everpiece wallet: the recipient is set in the Aurora quote, and our app refuses to show any quote whose recipient or amount differs from what was asked.
- **What was proven live.** A real $0.50 USDC payment from BNB Chain, sent from an external wallet, arrived on Monad with Aurora status `SUCCESS` (delivery tx `0xc8421567d3d4b3ecac74ac3049d86649b79385c7bd9010a83859f2c91c677a2b`). The app tracked it from "received" to "arrived" and shows the delivery transaction as proof.
- **Settlement and refund handling.** The payer's refund address is part of the quote. Underpayment, late deposits and failures end in an Aurora refund, which the app shows as "refunded" with the address. The app tells the payer plainly that cross-chain payments take a few minutes.
- **Multi-chain sources.** Eight source chains are live: Base, Ethereum, Arbitrum, Optimism, Polygon, Avalanche, Gnosis and BNB Chain, USDC on each.
- **Persistent link, one address per request.** Each user has a standing pay link; every payment attempt gets its own deposit address and tracking.
- **Confidential Intents (bonus).** A "hide which wallet I'm paying from" option sends Aurora's confidential setting. We describe it exactly as Aurora does: it hides the paying wallet and the route; the payment arriving on Monad, its amount and its recipient stay public. **[CHECK: only keep this paragraph if you have completed one confidential payment end to end; otherwise say "implemented, not yet demonstrated" or delete it]**
- **Removes a real friction.** The sender needs no bridge, no swap and no Everpiece account. The recipient gets spendable dollars on Monad.

**Demo video (max 2:00) shot list:**
1. 0:00 Show the user's pay link and QR on a phone. Say who it is for.
2. 0:15 On a computer, open the link. Pick **USDC on BNB Chain**, enter $1, enter a refund address, tap Get deposit address.
3. 0:40 Show the deposit address and exact amount. Send from an external wallet. Show the wallet confirming.
4. 1:00 Back in the app: "Received: moving it to Monad", then "Paid".
5. 1:30 On the recipient's phone: balance up. Open the Monad transaction. Say: "Funds arrived from another chain, with no account on the sending side."

---

## Prep before recording
- Put at least $2 of AUSD into the demo account (needs your GO, from the canary wallet `0x65E0…7aD1`, which holds about $1.01 AUSD). Alternatively send AUSD from any wallet to the account address on Monad.
- Use two devices or two browser profiles for the send and receive shots.
- Do a dry run of the BNB payment the day before. It took about three minutes last time, so cut or speed up that part of the video and say so.
- Check the Zerion/other wallet has a little BNB for gas on BNB Chain.
