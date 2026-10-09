# READINESS.md — final testing before mainnet (2026-10-06)

The yardsticks are master §57 (Core Definition of Done) and §60 (Final Release Checklist).

Everything marked ✅ was **run today** unless a date is given. ⏳ means waiting on time. 🟠 means partly done. ❌ means not done. 👤 means it needs the owner.

## Automated suites (run 2026-10-06)

| Suite | Result |
|---|---|
| Contracts: all suites incl. mainnet + testnet forks, CI profile (10,000 fuzz runs, deep invariants) | **260/260** |
| Relayer (with anvil fork of real AUSD) | **40/40** (22 offline) |
| Claims (with fork) | **22/22** |
| Shared · Directory · Voice | **36/36 · 13/13 · 9/9** |
| Typecheck, all workspaces · web production build · scan unit test | clean · ✅ · 2/2 |
| Relayer gas limits proven on cold state, mainnet + testnet (`RelayerGas.t.sol`) | 12/12 |

## Live end-to-end on https://test.everpiece.xyz

These run from the server in a capped container (`deploy/test-stack/e2e.sh`).

| Spec | Result today |
|---|---|
| `request`: request → scan the real QR (iPhone-style decoder) → pay in Dollars (instant) and in CTK via Agora (protected); paid, unknown and foreign links refused | ✅ |
| `payout`: verified Nigerian bank account → ₦3,000 request → one-prompt payment → "Delivered" only on the provider's confirmation; a failing account refunded (SIMULATED Paycrest) | ✅ |
| `add`: add Dollars from another chain (SIMULATED Aurora); forced settlement failure shows the held balance; retry converts exactly $5.00 | ✅ |
| `history`: indexer history, refresh, new device, sign-out/in, second browser, cancel, receipts | ✅ |
| `message`: encrypted voice/note by link and by @username | ✅ 2/2 earlier today. On the final run, 1 passed and 1 was blocked by the anti-squatting cap (below) |
| `username`: @username send/claim, pinning, look-alike refusal | ✅ earlier today; blocked on the final run by the same cap |
| `flow`, `email` (link payment claimed with an SMS/email code) | Skipped on testnet by design: real SMS/email can't be read by a bot. See DoD #8 |

**About the cap:** the directory allows **30 new usernames per IP per day**. Today's runs used them up from both the server (30/30) and the owner's PC (29/30). It's working as designed, so I didn't loosen it. Rerun after the 24-hour window.

## Core Definition of Done (§57)

| # | A new user can… | Status | Evidence |
|---|---|---|---|
| 1 | open Everpiece in a browser | ✅ | https://test.everpiece.xyz |
| 2 | create / recover a Mera identity | ✅ | `history.spec` (new device, sign out/in, second browser) |
| 3 | choose a username | ✅ | `username.spec`, `message.spec` |
| 4 | access/use supported Dollars | ✅ | real Agora AUSD on testnet; `add.spec` |
| 5 | select the intended recipient | ✅ | @username pinning + "this is the person I mean" (`username.spec`) |
| 6 | create a protected payment | ✅ | `history`, `username`, `message` specs |
| 7 | optionally attach encrypted voice | ✅ | `message.spec`; a real Android voice note (2026-10-02) |
| 8 | share / open a claim (link) | 🟠 | Proven on a fork (claims 22/22, an on-chain `claimLinkPayment`) and live by email on 2026-09-30 on the **previous** testnet escrow. **Not yet re-run on the current AUSD escrow** → 👤 a 2-minute manual test (below) |
| 9 | verify the intended recipient | ✅ | username pinning; the link code + approver (claims tests) |
| 10 | claim without MON | ✅ | every claim is relayed (gasless) |
| 11 | see payment history | ✅ | `history.spec` (Envio indexer) |
| 12 | create another payment | ✅ | `username.spec` (second payment, pinned) |
| 13 | cancel before claim | ✅ | `history.spec`, `username.spec` |
| 14 | receive an exact refund | ✅ | the balance is back to the cent ($80.00 after cancel) |
| 15 | allow an expired payment's refund | ✅ | Run live 2026-10-09 06:48 UTC on the testnet AUSD escrow: `0xb1eb8e92…a5dc` ($1, minimum 1-day expiry) was refunded by anyone through the public relayer, no signature: tx `0xe2472401d4a02539d23f42f7cc47b23bb4ec9ebc50a92ec1c7ce9201541cf428`, block 69472739, CONFIRMED at finality, chain status REFUNDED. The sender's AUSD went 99.00 → 100.00 (exactly the $1). Earlier the refund was correctly refused before expiry (`PaymentNotExpired`). |
| 16 | inspect real Monad evidence | ✅ | receipts link every step to the explorer (`history.spec`) |

## Final Release Checklist (§60)

**Product**
- Core story clear: ✅ (README updated today).
- No crypto jargon in the primary flow: ✅. Fixed today: the pay-a-request screen said "AUSD", "token" and "blockchain".
- No MON requirement: ✅.
- Mobile-first web works: ✅.
- Real Android tested: 🟠 a voice note on Android Chrome (2026-10-02); the **full money flow on a real Android phone** is 👤.

**Escrow**
- Real mainnet: ❌ 👤 GO.
- Cap enabled, liability correct, cancellation works, refund works, recipient authorization works: ✅ (tests, fork, indexer).
- The open decision **F-01 (MEDIUM)**: one funded account can fill the $5,000 global cap with self-payments. 👤

**Gasless**
- Real AUSD authorization verified, relayer simulation, nonce queue: ✅.
- Tight gas limits: ✅ fork-proven worst cases.
- Reserve-balance behavior: ✅ understood and seen live. The testnet relayer dropped below its 0.2 MON floor today, refused sends, and was topped up with the owner's GO.
- Relayer funded **on mainnet**: ❌ 👤 amount + GO.

**Claims**
- Secure URL secret (#fragment), separate recipient verification, no public OTP, no permanent lockout, two capabilities required, no secret caching or logging: ✅ (claims 22/22, THREAT_MODEL).

**Mera**
- Signing works: ✅.
- Recovery expectations understood: ✅ (same passkey → same account).
- **Production RP ID**: ❌. Passkeys are bound to the hostname. The test site's are `test.everpiece.xyz`; mainnet needs the app served at `everpiece.xyz` (VERIFIED §3.5). 👤 the domain/hosting decision.
- Android passkey: 🟠 (as under Product).

**Voice**
- Encrypted on device, server stores ciphertext, wrong recipient can't decrypt, tampered ciphertext fails, an outage doesn't block funds: ✅.

**Metrics**
- Real only (indexer from chain events), no fake users, volume or partners: ✅.

**Optional integrations**, each labelled honestly:
- Agora Instant Settlement: LIVE on testnet (CTK); mainnet needs `APPROVED_SWAPPER`.
- Aurora Intents: **SIMULATED** on testnet, labelled on every screen; live is not enabled.
- 0x: DISABLED (design only).
- Private send (Unlink): DISABLED.
- Ramp, payout, Pieces, CRE: DISABLED.

**Submission**
- README: ✅ updated today.
- Demo video, project description, screenshots: ❌ 👤 (DEMO_SCRIPT.md exists).
- Bounty details: ❌. BOUNTIES.md still needs the official text pasted 👤.
- Contract address and transaction proof: ✅ testnet; ❌ mainnet.
- GitHub repository: ❌. The branch is **local only, never pushed**. 👤 say where to push.
- **Exact deadline**: ❌ TODO(VERIFY). The public page says "Open 1 Sep to 13 Oct" with no time or timezone. Internal target 12 Oct. 👤 read it from the logged-in dashboard.

## Owner decisions still open (blocking mainnet)

1. **F-01**: a per-sender cap (redeploy), a higher global cap, relayer limits, or accept it with monitoring.
2. **The relayer policy engine is TEST-only.** It has no sanctions or identity screening. Accept that for launch, or choose a screening provider.
3. **Mainnet GO, with amounts**: deploy the escrow + EverpiecePay, MON for the relayer, a canary payment.
4. **Production domain** `everpiece.xyz` for passkeys (the RP ID).
5. **Agora `APPROVED_SWAPPER`** for EverpiecePay on mainnet (pay in USDC; Aurora top-ups).
6. **Aurora API key**, then the approved ~$5 real Aurora top-up (money rules M1–M8 confirmed 2026-10-06).
7. **Submission:** the deadline time, a push target for the repo, the demo video, the bounty text.

## Two quick manual checks for the owner (≈5 minutes)

1. **Link claim on the current escrow** (DoD #8), on your phone at test.everpiece.xyz:
   - Get 100 test Dollars → Send money → $1 → **Email** → your own email → Continue → Confirm with fingerprint.
   - Copy the link it shows. Open it (in a private tab is fine), create an account when asked, enter the code that arrives by email, and claim.
   - That covers link creation, the email code, approval and a gasless claim on the current AUSD escrow.
2. **Full flow on a real Android phone and an iPhone**:
   - create an account, pick a username, request money and scan the QR with the other phone;
   - on iPhone this is also the first real test of the jsQR scanner.

## Private payments: status

- **Monad Private Settlement** (Category, revealed today; VERIFIED §4.12):
  - encrypted, institution-run settlement domains on the Monad L1, for "banks, fund, or asset manager" use;
  - no date, no testnet, no SDK and no token list;
  - **not usable by a consumer payments app now**. Revisit when access and tokens (AUSD?) are published.
- **Unlink** (VERIFIED §4.10) is still the only path for an Everpiece Private mode that works on testnet, but it's blocked: the Unlink dashboard wouldn't load, so there's no API key or appId. Owner decision 2026-10-02 was to wait for today's announcement. **Recommendation:** keep Private mode DISABLED for the submission. Resume with Unlink once its dashboard works, or with Private Settlement once Category opens access.
- **TACEO Merces** (VERIFIED §4.11): mainnet USDC only, max 1 USDC per transaction, users pay their own gas. Not a fit.
