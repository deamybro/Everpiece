# HANDOFF.md

Read `MASTER_PROMPT.md` (full v3.2), this file, and the repo before continuing.

---

## Session 32 — 2026-10-06 — Real-phone feedback: instant @username, receipts, QR, Slush-style UI, pay from any chain

- **Owner on a real phone:**
  - "sent to a username, why is it waiting for claim, it's supposed to send asap";
  - "request payment qr not showing";
  - "no transaction receipts";
  - "I want it similar to Slush but retain our colour";
  - "pay from any chain … automatically settles on usdc or ausd, didn't see that feature".
- **Deployed** `62952fc`.
- **Built:**
  - @username sends are **Instant by default** (EverpiecePay, final); Protected is one tap away; a message forces Protected.
  - **Instant payments in history** (sent/received; conversions once; bank payouts labelled) and **receipts** for them (indexer + `settled(id)` on-chain).
  - **QR fix:** Chrome's forced dark mode made the QR white-on-white. The app is now dark by design with `color-scheme: dark`; the QR keeps its white field (verified in a dark-mode screenshot).
  - **Midnight UI (Slush-style):** a wallet card with Send/Request/Scan/Add tiles, hide-balance eye, holdings list; bank shortcuts; a bottom tab bar (Home, Bank, Scan, Activity, Receive) shown only on Home/Receive/Scan.
  - **Pay from another chain inside a payment:** "From another chain" on a pay-a-request screen → Aurora (simulated on testnet) → back to the payment with that token selected → one prompt converts and pays exact Dollars.
- **Not run yet:**
  - the updated `username.spec` (adds an instant send; protected flows now choose Protected) and `history.spec`. Blocked by the per-IP username cap (frees ~00:17 UTC) and low testnet gas.
  - **Owner:** refill the deployer `0xc90551F8abEEf31eD7a7C1DAAaF20E5eC2EA8eAe` (testnet faucet, CAPTCHA).

---

## Session 31 — 2026-10-06 — Identity rewrite, relayer top-up, EverpiecePay adversarial review

- **Owner:** "go"; then "no repo, I don't want any trace of" the previous GitHub identity; new identity **deamybro <deamybro@gmail.com>**; remove the text mentions; GitHub push later (the owner logs in first).
- **Identity:**
  - All 140 commits on all branches rewritten (author + committer); the two text mentions replaced across history.
  - `refs/original` and reflog dropped, `gc --prune=now`: **0 objects** contain the old name or email.
  - The safety bundle was deleted after verification. Repo git config set to deamybro.
  - The server copy was redeployed clean and `src.old` removed; the running container is clean.
  - Not touched: the PC's **global** git config (still the old identity, used by other repos) and Docker's internal build cache on the host.
- **Relayer gas (O6):** auto top-up + alerts in the testnet stack (`181eaa4`). It works, but the deployer has only 1.24 testnet MON, so the owner refills from the faucet.
- **O2 resolved:** `contracts/test/adversarial/PayAttack.t.sol`, P01–P12, 12/12 (CI fuzz 10k). No contract bug; FINDINGS.md F-06/F-07 INFO. Contracts offline 229 passed + 5 fork-skipped; with forks 272.
- **Not pushed:** waiting for the owner's GitHub login.

---

## Session 30 — 2026-10-06 — Full audit

- **Report:** `docs/AUDIT-2026-10-06.md`. Deployed `d4b1086`.
- **Fixed:**
  - **A1 HIGH:** the payout amount is now capped by the quote (`payoutWithinQuote`, refused before signing);
  - A2: rate limit on relayer quotes;
  - A3: payout order budget + rate cache;
  - A4: HSTS;
  - A5: source-map-js;
  - A6: segmented controls and `$` sign.
- **Verified sound:**
  - all suites (contracts 260/260 incl. forks + CI fuzz; workspaces 132);
  - no secrets in git history;
  - forged X-Forwarded-For not trusted;
  - localhost-only ports;
  - TLS 1.3, headers, CORS;
  - live `payout` + `add` E2E on the final build.
- **Open, by priority:**
  - **O1 CRITICAL** — the repo has never been pushed (owner: where?);
  - **O2 HIGH** — no adversarial review of EverpiecePay yet;
  - O3 policy engine; O4 F-01;
  - **O5** bank-name enumeration by address (privacy decision);
  - O6 the testnet relayer at 0.64 MON;
  - O7 production RP ID;
  - O8 a manual link-claim test;
  - O12 tomorrow's checks.

---

## Session 29 — 2026-10-06 — Visual redesign ("the ui is still wack")

- **Deployed** `ab573b1` to https://test.everpiece.xyz.
- **Design system** (`web/app/globals.css`, rewritten):
  - Inter, self-hosted by next/font, so the CSP is unchanged; tabular figures only on amounts.
  - A neutral canvas, one brand colour, borderless cards with soft depth; new buttons, inputs and radio cards.
  - Test-money notices are compact chips; top-bar pills.
- **Wallet-style Home:** a gradient balance card with Send money / Request; round icon actions (Scan to pay, To a bank, Cash out, Add money; full names kept as aria-labels); a "How you receive money" settings row.
- **SVG icons:** `components/Icon.tsx`.
- **Review rows shortened** so values fit on one line.
- **Process:** `deploy/test-stack/shots.sh` takes phone-size screenshots on the host (`web/e2e/shots.spec.ts`); every screen was reviewed by eye across 3 iterations.
  - Found and fixed: narrow word spacing (Plus Jakarta Sans → Inter), the settings row stacking (`a.card` specificity), "Send money" wrapping, wrapped review values.
- **Tests:** live `payout` ✅ and `add` ✅ on the final build.
  - The simulated payout provider's bank-lookup cap is raised to 500/IP/day (test site only; real lookups keep 20).

---

## Session 28 — 2026-10-06 — Naira payouts: a flow you can see on testnet, and a good UX

- **Owner:** "build it on testnet so I can see the flow, also build a good UX".
- **Deployed** to https://test.everpiece.xyz (SIMULATED Paycrest; real public bank list and live rate).
- **Built:**
  - `/bank`, "Send naira to a bank": my own (**cash out**) or an @username's; only to the account the recipient signed.
    - Server: sender-initiated orders bound to the recipient's signed destination.
  - **PayoutTimeline**: Paid → Sent to the bank → Delivered (or failed → refunded), with real times from the server's per-order history.
  - **Home:** one primary action, a 2×2 tile grid (Request, Scan to pay, Send to a bank, Cash out to my bank), quiet links (Add money, How you receive money), and a **Bank payouts** list with live, provider-confirmed states.
  - **/receive:** bank search, popular banks first (by name from the provider list), automatic account check at 10 digits.
  - **Naira amounts:** a ₦ sign, separators, quick amounts (₦5k–50k), live "≈ $".
- **Bug found by the live E2E:** open screens behind one IP (a carrier NAT) exhausted the payout server's single 60/min budget and a cash-out failed with "Too many requests".
  - Fix: separate budgets (reads 240/min, writes 30/min); the client retries one 429; polling is gentler and stops when the tab is hidden or the payout is final.
- **UX review:** phone-size screenshots via `web/e2e/shots.spec.ts` (`E2E_SHOTS=1`) on the host; checked by eye. Fixed: link buttons rendering as primary, cluttered actions, the underlined brand, bare amount input.
- **Tests:** payout server 6/6; live `payout.spec` ✅ (request → delivered, refund, cash out → Home list) and `add` ✅.
- **Try it (one phone):**
  1. test.everpiece.xyz → create an account → Get 100 test Dollars.
  2. "How you receive money" → Nigerian bank account → any bank → any 10 digits (`2222222222` = a failing payout).
  3. Home → "Cash out to my bank".
- **Next:** Paycrest KYB (owner); `EverpiecePayout` contract; the 2026-10-07 checks (expired refund; specs needing new usernames).

---

## Session 27 — 2026-10-06 — The last mile: Dollars → a Nigerian bank account (SIMULATED Paycrest)

- **Owner:** "Everpiece should solve" the last mile: stablecoin → local currency → bank. Decisions:
  - **P1** nobody custodies the money (one contract on mainnet);
  - **P2** promise "at least ₦X";
  - **P3** refunds go to the sender's own address;
  - **P4** bank details are encrypted on the server.
- **Deployed** `6f84727` to https://test.everpiece.xyz.
- **Verified (VERIFIED §4.15):**
  - Paycrest Sender API v2: endpoints, envelope, `validated` = the bank payout is confirmed, HMAC webhooks, **mainnet-only**, KYB required, **no Monad**, so money goes via Base.
  - Live public NGN bank list and rate (₦1,354.88 per USDC).
  - Circle CCTP V2 on Monad: domain 15, mainnet + testnet contracts with code on-chain.
- **Built:**
  - Design `docs/PAYOUT.md`.
  - Shared `payout.ts`: signed `PayoutAccount` + `PayoutRequest`, "at least ₦X" maths rounded up, forward-only states. Shared 40/40.
  - `server/payout` (new workspace): Paycrest client; bank accounts verified, salted hash + AES-GCM; saved only with the owner's signature; requests bound to that destination; one live order per request; DELIVERED only on validated; HMAC webhooks re-checked with the provider. 5/5.
  - `scripts/paycrest-sim.mjs`: Paycrest's shapes; the real public bank list and rate; simulated names, orders, deposits (test AUSD on Monad testnet), payouts and refunds.
  - Web: `/receive`, ₦ on `/request`, `/payout/<id>` (both signatures checked on the payer's device), scan + `/add` support.
  - Test stack: payout reached via `/payout-api` (no host Caddy change); the bank key generated once in the host .env.
  - THREAT_MODEL §M; ledger rows; README.
- **Tests:** live `payout.spec` ✅ (delivered + refunded paths), `add` ✅. Specs that need new usernames wait for the per-IP cap to free (from 00:17 UTC 2026-10-07).
- **Owner next:**
  1. Paycrest sign-up + **KYB** → API key + secret.
  2. Then I build `EverpiecePayout` (AUSD → Agora USDC → CCTP V2 → Paycrest on Base; PAYOUT.md §5) + its fork tests + review.
  3. GO for a first $0.50–$1 real payout to a real NG account.
- **Still due 2026-10-07:** the expired-refund check (payment `0xb1eb…a5dc` after 10:11 UTC); rerun request/history/message/username.

---

## Session 26 — 2026-10-06 — Final testing before mainnet; private payments update

- **Owner:**
  - "final testing and make sure everpiece ticks all the box before mainnet"; what's new on private payments (Category's Monad Private Settlement).
  - Confirmed: money rules M1–M8; the ~$5 real Aurora top-up (once there is an API key); mainnet deploy + relayer funding (no amounts given, and "final testing" first, so **nothing was sent on mainnet**).
- **Deployed** `bab3613` to https://test.everpiece.xyz.
- **Results: `docs/READINESS.md`** (new). Every §57 Definition-of-Done step and every §60 release-checklist item, with evidence.
  - Contracts 260/260 (fork + CI profile). Relayer 40/40 with fork. Claims 22/22 with fork. Shared 36, directory 13, voice 9. Typecheck and build clean.
  - Live E2E: request, add, history ✅. message/username passed earlier today; on the final run they were blocked by the directory's 30-new-usernames-per-IP-per-day cap (working as designed; not loosened).
- **Fixed:** jargon in the pay-a-request flow ("AUSD", "token", "blockchain" → Dollars wording; master §60). README rewritten to current state.
- **Expired refund (DoD #15), live:** $1 testnet payment `0xb1eb8e92d2fc3dd086b0530ba20a059c131046b0046a6bb3426610ffe133a5dc` with the minimum 1-day expiry. Created and CONFIRMED at finality; early refund correctly refused (`PaymentNotExpired`, no gas).
  - **Next session after 2026-10-07 10:11 UTC:** `POST /svc/relayer/v1/payments/refund {paymentId}` → CONFIRMED; check the sender got exactly $1 back.
  - The throwaway test key is in the session scratchpad only.
- **Private payments:** Monad Private Settlement (revealed today; VERIFIED §4.12) is institutional, with no date, SDK or token list, so it's not usable now. Recommendation: Private mode stays DISABLED for the submission. Unlink is still blocked on its dashboard.
- **Owner, open (READINESS.md):**
  - F-01;
  - policy engine (TEST-only);
  - mainnet GO with amounts;
  - production domain `everpiece.xyz` (passkey RP ID);
  - Agora `APPROVED_SWAPPER`;
  - Aurora API key;
  - deadline time, repo push target, demo video, bounty text;
  - manual checks: a link claim by email on the current escrow, the full flow on real Android + iPhone.
- **Rerun after the cap window:** `deploy/test-stack/e2e.sh optiongenome request message username`.

---

## Session 25 — 2026-10-06 — Routing design: Aurora as the future funding provider

- **Owner:**
  - Aurora Intents = preferred future multi-chain **funding** provider, not AUSD settlement. Don't enable it for real yet.
  - Keep 0x as the alternative EVM routing provider.
  - Never assume Aurora delivers AUSD.
  - If Aurora completes but Agora fails, the funds stay in the payer's account; no automatic reverse route.
  - No real mainnet transaction without owner approval.
  - Then: "keep simulated on testnet".
  - Asked "no way to make it real?" → answered with the mainnet path (below); no decision yet.
- **Branch:** `feat/payment-intents-agora` (local only, not pushed). **Deployed** `a830020` to https://test.everpiece.xyz.
- **Built:**
  - `docs/ROUTING.md` (new; the relayer already cited it):
    - layers: funding / settlement / payment;
    - the flow source → Aurora → verified Monad intermediate (USDC) → Agora → exact AUSD → Instant/Protected;
    - the conditions an intermediate asset must meet;
    - the AUSD-directness rule;
    - the order of checks (Agora before Aurora);
    - the failure matrix;
    - no automatic reverse route; no mainnet transaction without the owner.
  - Relayer config refuses an Aurora destination that is AUSD or lacks a verified Agora route (tests).
  - `/add`: when Aurora delivered but settlement fails, it shows the delivered asset's real balance in the payer's own account and says nothing is sent back automatically; retry later.
  - FUNDING.md M4 and the ledger row aligned.
- **Tests run:** relayer 22/22; web typecheck; live E2E on the host, `add` 1/1, which now forces the settlement failure, checks the held-balance message, then converts successfully.
- **To make it real (owner):**
  1. Intents Studio API key (via `set-secret.sh`);
  2. Agora `APPROVED_SWAPPER` for EverpiecePay on the mainnet USDC/AUSD pair;
  3. GO for mainnet EverpiecePay/escrow deploy + relayer funding;
  4. confirm FUNDING.md M1–M8;
  5. GO for one small real top-up.

  A faster partial step: steps 1 + 5 alone test the Aurora leg for real (USDC lands in the owner's own account; that also confirms whether Aurora's own token API lists AUSD).

---

## Session 24 — 2026-10-06 — Aurora Intents: "Add Dollars from another chain" with USDC

- **Owner:** "build it, its part of our main build, use usdc". Also GO to fund the testnet relayer with 2 testnet MON.
- **Branch:** `feat/payment-intents-agora` (local only, not pushed). **Deployed** `03a089a` (+ docs) to https://test.everpiece.xyz.
- **Flow (docs/FUNDING.md):**
  1. USDC on Base/Ethereum/Arbitrum/… → Aurora, EXACT_OUTPUT to the payer's OWN Everpiece account on Monad.
  2. One passkey prompt converts it to exactly the requested Dollars: `payWithToken` to self through the Agora AUSD/USDC pair.
  3. From there, every existing flow works.
- **Verified (VERIFIED §4.14):**
  - Aurora supports Monad as source and destination (mainnet only). API paths, enums, statuses and fees come from Aurora's docs.
  - Monad has no AUSD in the intents token list, hence USDC.
  - Mainnet USDC `0x7547…f603` (permit domain "USDC" v2, checked on-chain).
  - Agora mainnet AUSD/USDC pair `0xf332…2470` (on-chain: AUSD/USDC, 1:1 at check time; APPROVED_SWAPPER required).
- **Built:**
  - Shared `funding.ts`: a quote is accepted only if it matches what was asked: assets, recipient, refund address, ≥ exact amount, a deposit address, no memo, a future deadline. Mainnet USDC added to the registry.
  - Relayer `/v1/funding/{sources,quote,deposit,status}`: the key stays server-side and never reaches logs or responses; per-IP limits; top-ups ≤ 600.
  - `scripts/aurora-sim.mjs`: the test site's SIMULATED Aurora, with the same API, delivering test CTK.
  - Web `/add`: price → deposit (QR, tracked, resumes after reload) → one-prompt conversion. Entry points: Home, Send shortfall, pay-request shortfall (returns to the payment).
- **Mainnet fork:** USDC → exactly 25 AUSD through the real pair with a USDC permit. EverpiecePay was placed at a wallet Agora already approved, so the pair is unmodified.
  - Its worst-case gas, **520,398**, exceeded the 490k limit set in session 23, so `payWithToken` is now 550k (`gasLimits.test.ts` keeps the relayer and the fork test in sync).
- **Ops:** the testnet relayer fell below its 0.2 MON floor (0.193) after today's test runs, so every send failed. With the owner's GO: 2 testnet MON from the deployer, tx `0x10145ec1…65c8`, status success, finalized; relayer 2.19 MON, healthy.
- **Tests run:**
  - Shared 36/36. Relayer 22/22: fake Aurora, plus an end-to-end run against the simulator.
  - Contracts gas fork suite 12/12 (mainnet + testnet).
  - Web typecheck and build.
  - Live E2E on the host: **add 1/1**, request 1/1, history 1/1, message 2/2, username 1/1. flow/email skip on testnet.
- **Open (owner, docs/FUNDING.md):**
  - an Intents Studio API key;
  - Agora `APPROVED_SWAPPER` for EverpiecePay on mainnet;
  - confirm money rules M1–M8;
  - mainnet GO, then one small real top-up.
  - Unchanged: policy engine (TEST-only), F-01, deadline, Private mode, submission package.
- **Suggestion:** the testnet relayer will run dry again under heavy testing; consider a low-balance alert or an auto top-up from the deployer (needs a GO).

---

## Session 23 — 2026-10-06 — "Fix the problems, make sure everything is perfect"

- **Branch:** `feat/payment-intents-agora` (local only, not pushed). **Deployed** `d908d7e` to https://test.everpiece.xyz.
- **Relayer gas limits, all proven** (`722701c`): `contracts/test/fork/RelayerGas.t.sol` runs every relayer action on mainnet AND testnet AUSD forks (Monad rules), cold state (`vm.cool`), fresh recipient, intrinsic + calldata (or the EIP-7623 floor), and requires ≥ 5% headroom. Three limits were BELOW the worst case:

  | method | old | worst case | new |
  |---|---|---|---|
  | createPayment | 350k | 318,483 | 350k |
  | claimUsernamePayment | 215k | 208,121 | 230k |
  | claimLinkPayment | 240k | **250,278** | 270k |
  | cancel | 195k | 189,469 | 205k |
  | refundExpired | 145k | 138,273 | 155k |
  | payWithAusd | 240k | **255,331** | 280k |
  | payWithToken | 420k | **449,716** | 490k |

  The measurement is an upper bound (live testnet: payWithAusd 223,216; payWithToken 400,622). `server/relayer/test/gasLimits.test.ts` fails if the relayer defaults and the fork-tested constants drift.
- **iPhone QR scanning** (`3634ed9`): `/scan` falls back to jsQR 1.4.0 (Apache-2.0, loaded only when needed) where there's no BarcodeDetector (iPhone Safari). `request.spec` now pays by scanning Maris's real on-screen QR through a fake camera with the detector removed.
- **Rate limits** (`3634ed9`, `d908d7e`): the directory allows 60 req/min per IP, shared by everyone behind one address (carrier NAT).
  - `directory()` retries a 429 twice (it is refused before processing).
  - The username check said nothing when it failed; now it says so and retries.
  - Home polls the inbox every 10 s instead of 5 s, and nothing from hidden tabs (refresh on show).
  - Receipts use the viewer's own @username from the device.
- **E2E on the host** (`deploy/test-stack/e2e.sh`): this PC ran out of memory (16.3/17.9 GB committed) and browsers crashed. Specs now run on the VPS in a throwaway Playwright 1.63.0 container capped at 1.5 GB / 1 CPU (owner: "is the vps not better?"). The image (~1.5 GB) stays on the host for reuse.
- **Tests run:**
  - Testnet E2E on `d908d7e` (from the host): request 1/1 (incl. the jsQR scan), history 1/1, message 2/2, username 1/1. flow/email skip on testnet (real SMS/email).
  - Contracts 217 offline and 259/259 with fork. Relayer 33/33 with fork (15 offline). Directory 13/13. Web typecheck, `next build`, scan unit test 2/2.
- **Not verified:** `flow.spec`/`email.spec` (link claims with a code) need the local dev stack (`npm run dev:stack`), which needs memory this PC didn't have. Link-claim gas is covered by the fork test; the web link-claim code didn't change this session.
- **Open (owner):** the relayer policy engine is TEST-only (no sanctions/identity screening); F-01; mainnet GO and funding; the deadline; Private mode after 6 Oct; the submission package; a real-iPhone scan check.

---

## Session 22 — 2026-10-05/06 — Payment requests + scan-to-pay, deployed; four testnet bugs fixed

- **Branch:** `feat/payment-intents-agora` (local only, not pushed). **Deployed** `2c7b2f2` to https://test.everpiece.xyz (owner: "yes" / "can't u do this urself?").
- **Built (`e19388a`):**
  - `/request`: the recipient signs an exact AUSD request (Instant or Protected, 24 h) and shows it as a QR code and link. The page flips to Paid only when the directory has an on-chain proof.
  - `/pay/<requestId>`: verified before it is shown (the recipient's signature over every field plus their signed @username record). The payer picks AUSD or test CTK (live relayer quote, countdown, refresh before expiry).
    - Protected + CTK: converted to the payer's own AUSD first, then escrowed with `salt = requestId`; two passkey prompts.
  - `/scan`: BarcodeDetector camera or a pasted link; only this origin's `/pay/<32-byte id>` links are followed.
  - Home: "Request" and "Scan to pay". Camera allowed on our own origin only. Own 404 page (`cdd059b`): Next's default uses inline styles the CSP blocks.
  - `web/e2e/request.spec.ts` (`a0881df`).
- **Bugs found on testnet and fixed:**
  1. **Every direct-AUSD instant payment was refused** (`60a0526`): `payWithAusd` needs 223,216 gas on Monad testnet, and the relayer's limit was 200k. The fork tests fit because a local fork uses Ethereum's gas schedule. Now 240k. **`payWithToken` (420k) was not measured separately**; it passed the E2E.
     - A first diagnosis ("lagging RPC node") was wrong: the replays omitted the gas limit. That change was reverted (`e5f93b5`).
  2. **Each deploy re-indexed testnet from scratch** (`93d0bd5`, `83682cd`) and saturated the public RPC's 50 req/s per-IP limit for ~20 min, so faucet sends failed with 429. The indexer now resumes when the contracts and its code are unchanged (marker in a new `indexer-state` volume) and wipes only after 3 failed runs in a row. `backoff_millis: 2000`. Faucet sends retry 5×.
  3. **Receipts showed an address instead of @username** (`2c7b2f2`): Home re-fetched names for every Activity row on every refresh and hit the directory's 60/min per-IP limit. Verified names are now cached for the tab (usernames never change).
  4. Rename: `REQUESTS_PER_RECIPIENT_PER_DAY` (it counts per recipient).
- **Tests run:**
  - Testnet E2E on `2c7b2f2`: request 1/1, history 1/1, message 2/2.
  - Relayer 14/14 offline and 32/32 with fork (run on `2e13794`; the gas-limit change was checked with the offline suite only). Directory 13/13. Web typecheck, `next build`, scan unit test 2/2.
  - Back-to-back specs from one IP can still trip the directory's per-minute limit (a test artifact; run them one at a time).
- **Ops:** directory DB backed up before deploy: `/data/directory.sqlite*.bak-20261005220928`. SSH to the host still resets now and then; the deploy completed each time (check `/opt/everpiece/src/REVISION`).
- **Open:**
  - real-phone QR scan (iPhone Safari has no BarcodeDetector; paste fallback only);
  - the relayer policy engine is TEST-only (no sanctions/identity screening): owner decision before mainnet;
  - F-01, mainnet GO and funding, the deadline, Private mode after 6 Oct, the submission package.

---

## Session 21 — 2026-10-03 — EverpiecePay + payment intents on real Agora AUSD (backfilled 10-05)

- **Branch:** `feat/payment-intents-agora`. This session wasn't logged at the time; the entry is reconstructed from the commits.
- **Contracts (`22f05ee`):** `EverpiecePay` — instant payments, no owner/admin, each payment settles once.
  - `payWithAusd`: one AUSD ERC-3009 signature with nonce = payment id.
  - `payWithToken`: payer EIP-712 signature + ERC-2612 permit; swaps through the fixed Agora pair for exactly the AUSD amount to the recipient, and refunds the rest.
  - Tests: 14 unit (incl. fuzz) on a mock pair; 3 fork tests on real Monad testnet AUSD + the CTK/AUSD pair + Whitelister.
  - Docs: `BASELINE.md`, `INTEGRATION_VERIFICATION.md`.
- **Shared (`f70e262`):** token registry, exact amounts without floats, EverpiecePay typed data (id vector checked in Solidity), signed `PaymentRequest`, central lifecycle `canTransition`. 30/30.
- **Relayer (`1b90aee`):** instant pay endpoints (CONFIRMED only with the `Paid` event + `settled(id)` at finalized); `/v1/quotes` (direct or Agora, never a fake quote); `LocalRulesPolicy` — labelled TEST, no sanctions/identity screening — that fails closed and records every decision. 14 offline + 32 with fork.
- **Deploy/stack/indexer (`a09876c`, `4e1ddf1`):** the testnet deploy script redeploys the unchanged escrow over real AUSD plus EverpiecePay and whitelists it with Agora. The directory signing domain is pinned so existing @usernames and message keys stay valid. The faucet hands out real test AUSD or test CTK. The indexer records instant payments (5/5).
- **Directory (`aec3733`):** payment requests create/get/mine/paid; "paid" is accepted only with a proof recomputed against the chain. 13/13.
- **Open:** the policy engine is test-only (no real screening) — needs an owner decision before mainnet.

## Session 20 — 2026-10-02 — Adversarial suite (Codex Phase A, reassigned)

- **Owner:** "yes" to the core team taking over `contracts/test/adversarial/`. AGENTS.md is updated.
  - "yes" was **not** taken as a mainnet GO. That still needs an explicit GO with amounts.
- **Built:**
  - `AttackMatrix.t.sol`: A01–A40, every master §44.2 row, plus fuzz properties for the exact expiry boundary and for "any other key never claims or cancels".
  - `Reentrancy.t.sol`: a hostile token reenters during funding, claim payout and refund payout.
  - `FINDINGS.md`: coverage table plus findings in §44.3 format.
- **Results:** 44/44. CI profile: fuzz 10,000 runs each. Full suite 202 passed, 2 skipped (fork).
  - Three first-run failures were test bugs (memory-struct aliasing; an external call consuming `expectRevert`), fixed. No contract bug was found.
- **Findings:**
  - **No CRITICAL/HIGH.**
  - **F-01 MEDIUM:** one funded account can fill the global $5,000 liability cap with self-payments, block all new sends, then cancel at no loss. Fix options: a per-sender cap (redeploy), a higher ceiling (redeploy), relayer limits, or accept it with monitoring. **Owner decision.**
  - F-02–F-05 INFO: stranded unsolicited AUSD; approver snapshot; pause vs expiry; boundary/freeze behavior.
- **Open:**
  - owner decision on F-01;
  - mainnet GO and funding;
  - the exact deadline;
  - Private mode after 6 Oct;
  - the submission package.

---

## Session 19 — 2026-10-02 — Payment receipts

- **Owner:** "payment receipts is important". Also confirmed a real-phone voice note works (Android; 20.8 KB note stored and bound at 17:03 UTC).
- **Built (`0e6e852`):** `/r/<paymentId>` receipt.
  - Contents: amount; Everpiece fee $0; network fee $0 (paid by Everpiece); from/to; how it was sent; expiry.
    - The recipient stays private until a claim. The sender's typed label shows only on the sender's own device.
  - Timeline: each step links its transaction on the explorer. Built from the indexer plus `getPayment` (the chain wins; it refreshes while the indexer catches up).
  - Save as PDF / Print (print CSS) and Share.
  - Linked from every Activity row and the send/claim done screens.
- **Tests run on testnet:** history 1/1, now including receipts (claimed and cancelled, both sides); message 2/2.
  - `username.spec` was blocked by the directory's anti-squatting caps (60/min, then 30 new usernames per IP per day) after today's many runs from one IP. Not a product failure; the same @username flow passed inside `message.spec`.
- **Open (owner decisions):**
  - take over `contracts/test/adversarial/` (AGENTS.md reserves it for Codex);
  - mainnet GO and funding;
  - the exact deadline from the dashboard;
  - Private mode after 6 Oct;
  - the submission package.

---

## Session 18 — 2026-10-02 — Message binding + clearer UI

- **Branch:** `feat/escrow-v1` (local only, not pushed).
- **Binding (THREAT_MODEL K.1 #6, `2800a84`):**
  - Uploads start with a 24 h lifetime. `POST /v1/messages/<locator>/bind {paymentId, metadataSalt}`: the store checks the on-chain commitment at finalized, then keeps the message until expiry + 15 days.
  - Sender and recipient both bind; pending binds retry from Home.
  - Voice tests 9/9, including the in-place migration (old rows keep 45 days). Live: health shows `bound` rising with the E2E runs.
- **UI clarity (owner: "make UI more understanding"):**
  - Welcome and an empty Home show "How Everpiece works" in 3 steps.
  - Send: Step 1–3; each recipient type says how claiming works; review shows "What happens next" and the real expiry date; the link screen is numbered steps.
  - Home: each payment gets one sentence on where the money is and what happens next.
  - Claim page:
    - names the sender's @username when there is one;
    - explains why an account and a code are needed;
    - Step 1–2;
    - one brand (it was doubled).
  - **Fix:** after a confirmed cancel, the row showed "Waiting to be claimed" plus a Cancel button until the indexer caught up. It now shows Cancelled at once; regression check in `message.spec.ts`.
  - Review rows stay as master §1.7 requires.
- **Tests run on https://test.everpiece.xyz (`84c8dd6`):** message 2/2, history 1/1, username 1/1. A screenshot tour at phone width was checked by eye.
- **Open:** real-phone recording (Android Chrome, iPhone Safari); the submission package.

---

## Session 17 — 2026-10-02 — @username messages, self-review, relayer 429 fix

- **Branch:** `feat/escrow-v1` (local only, not pushed).
- **Owner direction:** finish what's open and do the review yourself, without waiting for Codex.
- **Built:**
  - `packages/shared/src/messageKey.ts`:
    - EVERPIECE_MESSAGE_KEY_V1, its own HKDF domain from the PRF, turned into X25519 by RFC 9180 DeriveKeyPair;
    - HPKE wrap of a fresh message secret, aad = paymentId;
    - account-signed `MessageKeyRegistration`.
    - Tests 24/24 (shared), including RFC 9180 A.1.1 copied from the RFC text and low-order key rejection.
  - Directory:
    - message keys (signed, one per account, immutable), returned with lookups;
    - an optional 80-byte `messageWrap` on inbox deliveries;
    - in-place migration (the VPS DB was backed up first: `/data/directory.sqlite*.bak-20261002154439`).
    - Tests 10/10.
  - Web:
    - New usernames publish the key in the same prompt; older accounts get "Turn on voice messages".
    - Home opens and verifies a message with no prompt (4 s cap, so money never waits). If this device lacks the seed, one prompt unlocks it.
    - Senders get the composer only for recipients with a verified key.
- **Fixed (found by the testnet E2E):** the relayer treated HTTP 429 from Monad's public RPC as a broadcast rejection; a valid cancel showed FAILED. It now retries and defers to the monitor (`20592b9`). Relayer 26/26 including fork.
- **Self-review:** THREAT_MODEL §K.1, nine items:
  - fixed: the relayer broadcast;
  - accepted with reasons: derived link key, capability reads, unaudited HPKE (mitigated), device-stored seed, metadata;
  - before mainnet: bind uploads to finalized payments.
- **Tests run on https://test.everpiece.xyz (`20592b9`):** message **2/2** (link and @username), history 1/1, username 1/1.
- **Open:**
  - **Real phones:** recording on Android Chrome (webm) and iPhone Safari (mp4) is untested; only Chromium's fake mic is.
  - Before mainnet: bind uploads to finalized payments (K.1 #6).

---

## Session 16 — 2026-10-02 — Encrypted voice + note messages (link payments)

- **Branch:** `feat/escrow-v1` (local only, not pushed).
- **Built (master §24–25, demo part 1):**
  - `packages/shared/src/voice.ts`, link-message envelope v1 (ESCROW_SPEC §3.2):
    - AES-256-GCM via Web Crypto;
    - key, store locator and commitment salt each HKDF'd from the link's `voiceRootSecret` under its own label;
    - `metadataCommitment` binds the exact envelope.
    - Tests 8/8, including tamper, wrong key, swapped message, limits, and a pinned vector re-derived independently with `node:crypto`.
  - `server/voice`, ciphertext-only store, 6/6 tests:
    - header checks, first write wins;
    - ≤ 1 MiB per message, per-IP rate and daily caps, total-bytes cap;
    - 45-day deletion.
  - Web:
    - `MessageComposer`: written note (≤ 200 characters) plus a voice note (≤ 30 s, codec picked at runtime) on the review step for phone/email payments.
    - `sendByLink` encrypts and uploads **before** signing; if that fails, nothing is signed or sent.
    - The claim page shows the message only after checking the on-chain commitment. An outage or a swapped message never blocks the claim.
    - CSP `media-src 'self' blob:`; `Permissions-Policy microphone=(self)`.
  - Stacks: voice service on 8791 (compose `127.0.0.1:47307`).
  - **Host Caddy:** `/svc/voice/*` → 47307 added to the `test.everpiece.xyz` block only, with the owner's approval (backup `/etc/caddy/Caddyfile.bak-everpiece-20261002151754`, validated, graceful reload, 7-line diff).
- **Tests run:** deployed `e1c96db`. Playwright on https://test.everpiece.xyz: **message 1/1** (Chromium fake mic):
  - the upload is ciphertext (starts 0x01, no plaintext note);
  - the recipient decrypts the note and playable audio;
  - with the store blocked, the claim still opens;
  - a swapped envelope is refused.
  - Regression: history 1/1, username 1/1.
- **Decisions to review (Codex):**
  - A derived key instead of content-key + wrap for link mode (THREAT_MODEL §K).
  - Locator capability reads instead of signed bucket URLs.
- **Open:**
  - **Username-mode messages:** need a recipient encryption key (HPKE/X25519 evaluation, §23.1). Not built; the composer only appears for link payments.
  - Real-device recording: Android Chrome, iOS Safari (mp4).
  - Production storage choice (R2/S3 vs self-hosted).

---

## Session 15 — 2026-10-02 — Privacy research + on-chain proof

- **Branch:** `feat/escrow-v1` (local only, not pushed).
- **Privacy (VERIFIED §4.11–4.12):**
  - Monad docs list only TACEO.
  - Monad's blog covers Unlink (2026-06-25).
  - Monad teased its own privacy launch for **2026-10-06** (Open summit, reportedly Category Labs; no spec yet).
  - TACEO's launch post lists no Monad testnet.
  - **Owner decision:** wait for Monad's 6 Oct announcement before choosing the Private mode provider.
- **Completed (master §56 part 3, §57 item 16):**
  - Activity rows link their latest transaction on the explorer (`NEXT_PUBLIC_EXPLORER_URL`; testnet uses testnet.monadscan.com).
  - New public `/proof` page ("Everpiece in numbers"), indexer data only:
    - people;
    - count and volume of sent / claimed / cancelled / expired payments;
    - protected now, claim rate (claimed ÷ finished) and median time to claim;
    - the latest 10 transactions;
    - the escrow address.
  - Indexer: `Account` entity plus `Stats.users` (distinct senders or claimers). Tests 4/4 and typecheck pass (WSL copy `~/everpiece`).
  - Compose: indexer-db, Hasura and the indexer use `restart: unless-stopped`; the stack stays `on-failure:3`.
- **Tests run:** deployed `0e5b561` to the VPS (re-indexed; liability still $4.00). Playwright history **1/1** on https://test.everpiece.xyz, including the explorer links and the proof page. Mobile layout checked.
- **Next (definition of done, §57):**
  - encrypted voice message (§24, demo part 1);
  - submission package (README, video, deadline);
  - Private mode after 6 Oct;
  - mainnet canary needs the owner's GO.

---

## Session 14 — 2026-10-02 — Everpiece on Monad testnet

- **Branch:** `feat/escrow-v1` (local only, not pushed).
- **Owner decisions:**
  - Testnet first.
  - **TestDollar** (an AUSD stand-in, so the escrow stays unchanged) rather than changing the escrow for USDC.
  - Private payments as a **separate Private mode** via Unlink: @username to @username, final once sent; protected payments stay cancellable.
- **Facts (VERIFIED §4.9–4.10):**
  - AUSD is absent on testnet, and the escrow is AUSD-specific.
  - The testnet RPC limits `eth_getLogs` to 100 blocks.
  - Unlink: testnet available, mainnet by request. It hides sender, recipient and amount; documents no cancel or expiry; needs a dashboard API key and appId.
- **Completed:**
  - `contracts/src/testnet/TestDollar.sol`: the exact IAUSD surface, an honest name, minter-only minting capped at $100, no freeze/burn/pause. 9 tests, including the unchanged escrow's full lifecycles on it. Full suite 158 passed.
  - `shared`: `DollarToken` for the funding domain (AUSD by default, so vectors are unchanged). Relayer `DOLLAR_EIP712_NAME`; web `NEXT_PUBLIC_DOLLAR_*`.
  - **Deployed to testnet** with `scripts/deploy-testnet.mjs` (refuses other chains; finalized receipts; read-back checks):
    - TestDollar `0xd073fD9a4361a18aa41f599d8A6ea96033376667`;
    - escrow `0x94A25e4cE211D94709915100bd6E8CbC4477BFD5`.
    - Keys were generated on the VPS (addresses only shown); the owner funded the deployer and relayer with 5 MON each.
  - `scripts/testnet-stack.mjs`: https://test.everpiece.xyz now runs on **Monad testnet**, with persistent keys and `/data` databases (no more resets), a TestDollar faucet (minter key, cooldowns), and real Twilio SMS plus Resend email (simulated refused). Compose `STACK_SCRIPT` switches between fork and testnet.
  - Indexer: chain from `ENVIO_CHAIN_ID`, RPC window capped at 90 blocks. It initially indexed nothing because of the 100-block limit; fixed.
- **Tests run on testnet (real transactions):** Playwright history **1/1** (45 s) and username **1/1**; flow and email skip (live providers).
  - Indexer `activeLiability` = on-chain `totalActiveLiability` = 4,000,000 at finalized.
- **Open:**
  - The Unlink dashboard fails to load ("Couldn't load this page" at `/orgs/everpiece/projects`, on PC and phone). Private mode is blocked on getting an API key and appId.
  - The relayer, approver and minter keys sit in the host `.env` (fine for testnet; KMS before mainnet).
  - Verify the contracts on the explorer (Sourcify) so their source is public.

---

## Session 13 — 2026-10-02 — Payment history from the indexer

- **Branch:** `feat/escrow-v1` (local only, not pushed).
- **Owner request:** history must come from the VPS indexer for the signed-in account, not browser storage. Local data may only be a cache or fallback. It must survive refresh, sign-out/sign-in and a second browser or device, and the contract and send/claim/cancel flows must not change.
- **Owner direction:** build on **testnet first**, and **private payments are compulsory**. Not started here; it needs facts and decisions (see the next section).
- **Completed:**
  - `web/lib/history.ts`: sent (`sender = me`) and received (`recipient = me`, i.e. claimed by me) from Envio/Hasura GraphQL.
    - States: protected; expired (derived, `ACTIVE && now ≥ expiresAt`); claimed; cancelled; refunded.
    - Labels come from this browser's cache, else the claimer's or sender's **verified** @username, else the payment kind. An unclaimed recipient stays private: it is only a commitment on-chain.
  - **The local cache is not authoritative:**
    - it only adds labels, plus just-sent payments not yet indexed;
    - each entry is checked on-chain to belong to the signed-in account. **Bug fixed:** the cache wasn't scoped per account, so after sign-out/sign-in another account's sends could show;
    - when the history service is unreachable, the UI shows a labelled device-only fallback.
  - Home's "Sent" becomes **Activity** (sent and received). Cancel and return-expired call the unchanged flows. The cache now records `sender`.
  - `NEXT_PUBLIC_INDEXER_URL` (plus CSP); dev-stack publishes it.
  - Caddy (Everpiece block only, with backup and validation): exposes **only** `/svc/indexer/v1/graphql`. Hasura metadata, query and console paths are 404.
- **Tests run:** Playwright on https://test.everpiece.xyz: **history 1/1**, username 1/1.
  - The history test covers sent and received, refresh, a wiped cache, sign-out/sign-in with the same passkey, a second browser for each account, and a cancel reflected on both. Final balance $94.
  - `flow` and `email` skip themselves because SMS and email are live (they read simulated outboxes).
  - Test fixes: every context is closed after each test (open pages had exhausted the next test's per-IP directory limit); the test stack's `REGISTRATIONS_PER_IP_PER_DAY` is configurable, and the host sets 30.
- **Open:**
  - Testnet and private payments (owner direction).
  - The public GraphQL lets anyone read any address's history. That data is public on-chain anyway, but it's one more reason private payments matter.

---

## Session 12 — 2026-09-30 — Public HTTPS test site (test.everpiece.xyz) on the shared VPS

- **Branch:** `feat/escrow-v1` (local only, not pushed).
- **Owner:** added the A record `test` → 38.49.209.149 in Namecheap.
- **Completed:**
  - `STACK_PUBLIC_ORIGIN` mode: one origin, services under `/svc/*`, and `TRUST_PROXY` for per-visitor rate limits.
  - A filtered read-only `/rpc`, so anvil is never exposed.
  - An Everpiece-only Caddy block, with backup `Caddyfile.pre-everpiece-20260930T2234Z`. Validated before install (append-only, 23 → 24 sites) and reloaded gracefully. Seven co-tenant sites answered 200 both before and after.
- **Tests run:**
  - HTTPS and TLS valid on `/` and all four `/svc/*` health endpoints; `emailLive: true`.
  - RPC filter: allowed reads succeed. `anvil_setBalance`, `anvil_impersonateAccount`, `eth_sendRawTransaction`, `eth_call` to a foreign contract and a batch with `evm_mine` all get 403.
  - Playwright against the public site: **2 passed** (link and username flows), **1 skipped** (`email.spec`, because email is live; verified by hand in session 11).
  - Host: Everpiece about 880 MB in total; 15/15 PM2 apps online; 6 co-tenant containers up; Caddy active.
- **Open:**
  - Real-device testing (Android Chrome with Google Password Manager, iPhone Safari, WhatsApp in-app browser → system browser handoff, master §C7).
  - The public site has no access gate. Email abuse is bounded only by rate limits and Resend's 100 a day. Consider a simple gate if it's shared widely.
  - Production rpId decision: everpiece.xyz vs a subdomain; passkeys can't move between them.
- **Incident 2026-10-01 13:56 UTC — public site returned 502:**
  - **Cause:** the dev-stack orchestrator crashed on an unhandled `Error: aborted` (ECONNRESET), when a client disconnected mid-request to the faucet port. My bug. The container restarted on a **fresh chain**, wiping the owner's overnight phone test (`@maris` and an email payment, around 23:19 UTC).
  - **Fix (6ea72d1):** per-request error handling, a body cap and `clientError` handling. Reproduced locally (the old pattern crashes, the new one survives), then live: an aborted faucet request against the public site left the stack running (0 restarts).
  - The `Server Reference ID did not match` errors in the web log are bots probing Next server actions; harmless.
- **Real SMS (2026-10-01, owner: no budget, so use the Twilio trial):**
  - Twilio's "Try out Verify" delivered to the owner's Airtel number and approved the check.
  - The owner created a Standard API key. Service SID and key went to the host via Notepad, then hidden SSH stdin; lengths confirmed on the host; file wiped.
  - The stack uses `twilio-verify` when all three are set: claims reports `"sms":"twilio-verify","smsLive":true`, and email is still Resend.
  - Trial limits: 40 verifications, at most 5 verified recipients, Nigeria only. Unverified numbers will fail with `VerificationUnavailable`.
  - The service's friendly name is "Try It Out Verify Service" and appears in the SMS. Renaming it to "Everpiece" changes the owner's Twilio account settings, so it waits for the owner's OK.
- **Known limit:** any stack restart or deploy creates a new chain, escrow and keys, and in-memory databases are lost, so test accounts reset. Option: persist anvil state and keys across restarts.
- **Next recommended action:** the owner tests on their phone; then web history from the indexer.

---

## Session 11 — 2026-09-30 — Real email for claim codes (Resend)

- **Branch:** `feat/escrow-v1` (local only, not pushed).
- **Decisions (owner):** provider **Resend**; sending domain **everpiece.xyz**, which the owner says they control. Codes come from `Everpiece <codes@mail.everpiece.xyz>` because Resend recommends a subdomain.
- **Completed:**
  - Resend API verified from official docs (VERIFIED §4.8).
  - `ResendEmailProvider`: Everpiece generates and checks the code; Resend only delivers it. The idempotency key is the OTP ref.
  - Config `EMAIL_PROVIDER=resend` needs `RESEND_API_KEY` and `EMAIL_FROM`.
  - The test stack uses Resend when the host `.env` has both, and stays simulated otherwise.
  - `deploy/test-stack/set-secret.sh`: hidden input over SSH stdin, keeps other lines, mode 600. Verified on the host with a dummy value; the file hash matched after cleanup.
  - `EMAIL_FROM` is set on the host; `RESEND_API_KEY` is **not** (owner step).
- **Tests run:** claims **12/12** offline and **22/22** with the fork (Resend adapter against mocked HTTP; config guards). Playwright **3/3** on the VPS; `email.spec` skips itself once email is live.
- **Owner steps to go live:**
  1. Create a Resend account.
  2. Add the domain `mail.everpiece.xyz` and add the DNS records Resend shows to everpiece.xyz's DNS.
  3. Once it shows Verified, create an API key with sending access.
  4. Run `deploy/test-stack/set-secret.sh optiongenome RESEND_API_KEY`.
  5. Restart the stack; then do a live send to a real inbox (TODO(VERIFY) in VERIFIED §4.8).
- **Limits:** Resend's free plan allows 100 emails a day and 3,000 a month.
- **Went live (same session):**
  - **Owner:** created the Resend account, verified `mail.everpiece.xyz` in Namecheap DNS (DKIM TXT, two CNAMEs, DMARC; receiving off), and created a Sending-access key.
  - **Key handling:** the key reached the host through a Notepad file that was sent with hidden input, confirmed by length on the host, then overwritten and deleted. It was never shown in chat.
  - **Test stack:** recreated with `"email":"resend"` and `emailLive: true`.
  - **Live test:** a $5 link payment with the code sent to the owner's Gmail. It arrived in **Primary**, the owner read the code, and the claim went through; the indexer shows it CLAIMED.
  - **Bug fixed:** `set-secret.sh` silently saved nothing for piped input without a trailing newline (commit 85236a4).
- **Incident — host-wide OOM at 21:06, not caused by Everpiece:**
  - Two co-tenant `node` processes (1,340 MB and 1,167 MB) plus graph-node exhausted RAM.
  - The kernel killed **only Everpiece processes** (all `oom_score_adj 1000`: Hasura, anvil, our Node processes); no co-tenant process was killed.
  - Hasura used up `restart: on-failure:3` and stayed down, and the indexer exited without it.
  - Restarted by hand once memory was back (~2 GB free); the indexer re-indexed.
  - While Hasura was down, the indexer also logged transient `Fork Error … 413` from the fork's upstream public RPC. It did not recur after the restart.
- **Suggested follow-up:** `restart: unless-stopped` for the indexer services so they come back by themselves after a host OOM (Docker backs off restarts), or a small watchdog. Owner's call, given the shared host.

---

## Session 10 — 2026-09-30 — Email claim code (SMS alternative) + passkey wording

- **Branch:** `feat/escrow-v1` (local only, not pushed).
- **Decisions (owner):**
  - Mera stays passkey-only; no email login for the wallet (it would need custody or a third-party key service).
  - Approved: **email as an alternative to SMS for the link-claim code**, since SMS is blocked for Nigeria.
  - Approved: the wording "fingerprint or screen lock".
- **Completed:**
  - **shared:** `EmailInviteRegistration` (its own EIP-712 type), `normalizeEmail` (lowercase ASCII) and `emailHash`. Vectors generated with cast (`evidence/claims-email-v0`).
  - **claims:**
    - Invites carry a `channel`; `/v1/invites` takes `phone` or `email`, each checked against its own signed type.
    - Codes go to the invite's channel with the same LocalOtp rules, cooldowns and a per-address daily cap.
    - `EMAIL_PROVIDER=none|simulated`; simulated is gated like SMS. Old databases migrate, with channel = sms.
    - The phone path is unchanged: the same responses, plus `channel` and `maskedContact`.
  - **web:**
    - Send offers Phone | Email | @username. The email share step warns "Don't email this link"; WhatsApp opens without a number.
    - The claim page says "Send me the code", then "texted" or "emailed".
    - Copy everywhere says "fingerprint or screen lock" (passkeys also unlock with face or PIN).
  - **Docs:** THREAT_MODEL **C10** (same-inbox risk; not enforceable; SIMULATED only), claims README, `.env.example`, INTEGRATION_LEDGER.
- **Tests run:**
  - shared **11/11**; claims **20/20** with the fork, including an email invite paid out by `claimLinkPayment` in real AUSD.
    - A phone-typed signature can't register an email invite; channels can't be switched; no plaintext address is stored or logged.
  - Web typecheck clean.
  - Playwright **3/3** against the VPS test stack through the tunnel: `email.spec.ts` (new), `flow.spec.ts` and `username.spec.ts`.
  - Couldn't run the local stack: the owner's own tunnel to another server holds local port 8787, so it was left alone.
- **Open:**
  - No live email provider.
  - Owner to choose one, plus a sending domain with SPF, DKIM and DMARC.
  - Its API must be verified in VERIFIED.md before an adapter is written.
- **Next recommended action:** owner picks an email provider (or live SMS); then web history from the indexer.

---

## Session 9 — 2026-09-30 — Test stack on the owner's shared VPS

- **Branch:** `feat/escrow-v1` (local only, not pushed). The code was shipped by `git archive` over SSH; no GitHub was involved.
- **Decisions (owner):**
  - Use the VPS already used for Tenet, and don't stop other processes there. It's shared by about 20 projects.
  - Access is via an SSH tunnel only: no public domain, and the shared Caddy is untouched.
  - No swap; cap Everpiece instead.
- **Completed:**
  - `deploy/test-stack/`: a Dockerfile (Node 24 + Foundry 1.8.3 anvil + CA certificates), `compose.yaml`, `push.sh <ssh-host>` and a README with the tunnel command. The host address is not in the repo.
    - Compose project `everpiece-test` in `/opt/everpiece`, with ports on the host's 127.0.0.1:47300–47305 only.
    - Caps: 1200 MB with no swap, 1 CPU, 512 pids, `restart: on-failure:3`, and rotated logs.
  - `scripts/dev-stack.mjs` gained opt-in `STACK_BIND_HOST`, `STACK_WEB=prod` and `STACK_WEB_BUILDER=webpack`. Local defaults are unchanged.
- **Found and fixed while deploying:**
  1. The slim image had no CA certificates, so anvil couldn't fork over HTTPS.
  2. The Turbopack `next build` needs more than 1.15 GB. The kernel killed it inside our cap (`CONSTRAINT_MEMCG`); no co-tenant was touched.
     - A capped probe measured the webpack build at 745 MB, so the container now builds with webpack.
- **Tests run:** Playwright from this PC through the tunnel, against the server's production build: **2/2 pass** (link flow and username flow).
  - Container memory peaked at 753 MB, with 0 OOM kills and 0 restarts, and idles at about 340 MB.
  - The host's free memory never went below 719 MB, including the failed attempts.
  - All 15 co-tenant PM2 apps stayed online, and the 6 co-tenant containers kept their uptimes.
- **Open / known limits:**
  - Each start creates new keys and a new escrow, so old test accounts see an empty chain.
  - The indexer is not deployed yet. Envio's Postgres and GraphQL server need about 0.5 GB more than the current cap allows. It needs its own capped compose service, with the RAM measured first.
  - HTTPS on a domain waits on the owner choosing the passkey domain.
- **Indexer added to the test stack (same session, owner: "do it"):** `indexer`, `indexer-db` (postgres:18.3) and `indexer-hasura` (v2.43.0), the versions envio 3.12.1 uses.
  - **Wiring:**
    - `indexer/config.yaml` takes its RPC source from `ENVIO_RPC_URL` / `ENVIO_RPC_FOR`: `sync` on the fork, because HyperSync only sees real mainnet.
    - dev-stack publishes each run's escrow and deploy block to a shared volume. The indexer re-indexes from scratch (`envio start -r`) when that changes.
    - Public read-only GraphQL on 127.0.0.1:47306. Secrets live in the host's `/opt/everpiece/.env` (0600), generated there.
  - **Memory:**
    - Caps: 192 / 320 / 384 MB; stack cap lowered to 1000 MB (measured peak 753).
    - `oom_score_adj 1000` on every Everpiece container, so a host-wide OOM kills Everpiece first.
    - The indexer services wait for the stack's healthcheck. The first deploy started them alongside the web build and host free memory dipped to 400 MB. After the fix: no alert.
  - **Ports:**
    - The browser URLs used to be baked as 127.0.0.1:3000/8787/…, which clashed with the owner's other local tunnels (one already held 8787).
    - `STACK_PUBLIC_PORT_BASE=47300` now puts them on 47300–47305, tunnelled 1:1.
    - `E2E_BASE_URL` / `E2E_FAUCET_URL` point Playwright at the tunnel.
  - **Verified:** Playwright **2/2** against the server through the tunnel.
    - The indexer then held exactly those payments: 4 payments, $60 created, $45 claimed, $15 cancelled, 0 active.
    - 8 PaymentEvents equals the raw `eth_getLogs` count; `activeLiability` 0 equals on-chain `totalActiveLiability` at finalized.
    - Public GraphQL mutations are refused.
  - **Steady state:** Everpiece uses about 820 MB in total (stack 426, Hasura 196, indexer 164, db 37). 0 OOM kills, 0 restarts; host has about 1 GB free. All 15 co-tenant PM2 apps are online and the 6 co-tenant containers kept their uptimes.
  - **Observed, not changed (owner's call):**
    - The host's sshd is under constant brute force (`MaxStartups throttling`, invalid users); fail2ban is inactive.
    - Tunnels get reset now and then; the README has a reconnect loop.
- **Next recommended action:** web history from the indexer's GraphQL (`NEXT_PUBLIC_INDEXER_URL`, device-local list as fallback), then the escrow GO for mainnet.

---

## Session 8 — 2026-09-30 — Envio indexer (build + test; not yet running on a chain)

- **Branch:** `feat/escrow-v1` (local only, not pushed).
- **Decision (owner):** the indexer is reassigned to the core team. Build and test it now without Docker; host it later.
- **Completed:** `indexer/` on **envio 3.12.1** (pinned):
  - Config keys come from the package's own `evm.schema.json` (VERIFIED §4.7); no guessed syntax.
  - The four payment events → `Payment`, `PaymentEvent` timeline and `Stats`. `Stats` counts and volumes cover executed events only, and `activeLiability` mirrors the escrow's.
  - The handlers throw on impossible history: unknown payment, second settle, amount or sender mismatch.
  - Escrow address, start block and block lag come from the environment. Production lag is 3 (Monad finalizes at head − 2), with reorg rollback on.
- **Tests run:** in WSL Debian (Node 22; Envio has no Windows build):
  - `npm ci` from the committed lockfile, codegen, and typecheck are all clean.
  - vitest **4/4**: ABI drift check against `packages/shared`; created→claimed; cancel/refund/active metrics; impossible-history refusals.
- **Found and fixed:**
  - With `block_lag > 0`, Envio's test indexer never finishes, because the simulated head is the last test block. The lag is now configurable and tests use 0.
  - npm 10.9 crashes resolving vitest's optional peers; the lockfile was made with npm 11.
- **Open / known limits:**
  - Not yet run against real chain events. That needs the escrow on mainnet (owner GO), and either Envio Cloud (needs a push, blocked on the commit identity) or Docker/Podman.
  - The web doesn't read the indexer yet (history is still device-local).
  - Restoring recipient pins from the indexer on a new device would defeat TOFU, so pins stay local by design.
- **Disk:** C: had ~5 GB free of 237 GB.
  - `pagefile.sys` is 16.7 GB, Windows-managed, and grows under memory pressure (7.7 GB RAM, 0.7 GB free during runs). That matches the drops while the stack and browsers ran. No single file over 50 MB was written in the scan window.
  - Other large items: WSL Debian `ext4.vhdx` 15.3 GB (last written 25/09), `hiberfil.sys` 3.2 GB. System settings are the owner's to change.
- **Next recommended action:**
  1. Web history from the indexer's GraphQL, behind a `NEXT_PUBLIC_INDEXER_URL`, with the device-local list as fallback.
  2. After the escrow GO: deploy the indexer and verify real events.

---

## Session 7 — 2026-09-30 — Username payments (directory + UI)

- **Branch:** `feat/escrow-v1` (local only, not pushed).
- **Completed:**
  - **`packages/shared/src/directory.ts`:**
    - EIP-712 `UsernameRegistration` (domain "Everpiece Directory" v1, bound to chain + escrow), signed by the account.
    - Username rules: lowercase ASCII `^[a-z][a-z0-9_]{2,19}$`, reserved staff-like names, display-name cleaning (rejects control and bidi characters).
    - `EVERPIECE_INBOX_V1` inbox key = HKDF-SHA256(PRF output, info "everpiece.inbox.v1"). Domain-separated from the account key.
    - New dependency: `@noble/hashes` 2.4.0, already in the tree via `@scure/bip32`.
    - Vectors in `vectors.json` → `directory`, generated independently by `evidence/directory-v0/vectors.sh` (cast + `node:crypto` HKDF).
  - **`server/directory`** (new workspace, :8789, **holds no keys**). Routes:
    - `/v1/usernames/register`: first come, one name per account, immutable, per-IP daily cap.
    - `/v1/usernames/lookup` and `/v1/usernames/by-account`.
    - `/v1/inbox/deliver`: stored only if `(recipient, salt)` opens the on-chain commitment of an ACTIVE USERNAME payment read at `finalized`.
    - `/v1/inbox/list`: needs the inbox key; only its hash is stored, compared in constant time.
  - **`web`:**
    - The Mera wrapper derives the inbox key in the same ceremony.
    - `lib/username.ts`: the browser re-verifies every registration signature, plus TOFU pinning (`everpiece.pins.v1`, set only after CONFIRMED).
    - Home: "Get paid by username" setup card; "Money for you" list with "from @sender" and one-fingerprint claim; automatic retry of undelivered inbox entries.
    - Send: "Phone number | @username" choice. A new recipient needs an explicit "This is the person I mean" tick; a pinned one shows "You've paid them before ✓"; a changed account is blocked with the §10.2 message.
    - The directory URL is added to the CSP `connect-src`, the dev stack and `.env.example`.
  - **`docs/THREAT_MODEL.md` §B:** documents what was actually built (B1/B2) and the new B4 (inbox privacy).
  - **One username = one person (owner request):**
    - The database enforces it: username PRIMARY KEY + CHECK lowercase, account UNIQUE, and a new `skeleton` column UNIQUE.
    - The lookalike key (`usernameSkeleton` in shared) makes `mama`, `marna`, `mama_` and `m_a_m_a` count as the same name; reserved names are also checked on the folded key.
    - After a lost sign-up race the server re-reads the database for an accurate error, and any non-UNIQUE database error now surfaces as a 500 instead of "UsernameTaken".
    - New `/v1/usernames/available` route, so the app shows "taken" or "too close to someone else's" before the fingerprint prompt.
    - An old directory DB file without the `skeleton` column refuses to start. Only `:memory:` DBs exist so far.
- **Tests run:**
  - shared **10/10**, directory **7/7** (including a simultaneous-sign-up race and database-level refusal), claims 8/8, relayer 6/6; typecheck clean in all four and in web.
  - Playwright against the dev stack: **2/2 pass**.
    - `flow.spec.ts`: the link flow, unchanged.
    - `username.spec.ts` (21 s): both users register; $20 to `@mama` is claimed from Home; the second send is pinned and then cancelled; a tampered pin is blocked; an unknown username is refused; a third user can't take `@mama_…` or its lookalike.
  - Zero CSP errors; zero error-level server logs.
  - Production `next build` + `next start` (after the commits):
    - nonce CSP, including the directory in `connect-src`, on `/`, `/send` and `/c/*`; `no-store` on `/c/*`.
    - In Playwright Chromium: service worker activated, fragment wiped, **zero console errors**.
    - The desktop app's browser preview pane can't register service workers ("unknown error when fetching the script"). That's a limitation of the pane, not the app.
- **Open / known limits:**
  - The inbox key is kept in `localStorage` (read-only privacy key). The owner may prefer a fingerprint prompt per inbox check.
  - Usernames can't be changed and there is no re-verification/migration flow.
  - The pin covers the account only; no recipient encryption key exists yet.
  - The directory operator sees the username-payment graph. TODO(REVIEW) on the inbox-key derivation, together with the voice keys (§23).
  - The sent list is still device-local; the Envio indexer is still next.
  - **Machine:** the C: drive repeatedly filled to 0 MB from something outside the repo (~8 GB consumed during this session's test run). `web/.next` was deleted once to recover.
- **Decisions (owner, 2026-09-30):**
  1. The inbox key stays in `localStorage` (no fingerprint prompt per inbox check). Accepted: anyone with that browser profile can see incoming username payments, but can't move money.
  2. Username rules accepted as built: 3–20 lowercase ASCII, immutable in V1, lookalikes folded.
  3. Commit, then the Envio indexer.
- **Decisions still needed from owner:** the commit identity for the history rewrite (before any push), and the SMS provider path.
- **Next recommended action:** owner review of the decisions above → commit as `feat(shared): username directory typed data + inbox key`, `feat(directory): username directory server`, `feat(web): send to @username, claim from Home` → re-run the production build/CSP check → Envio indexer.

---

## Session 6 — 2026-09-29 — PWA (web) + local dev stack

- **Branch:** `feat/escrow-v1` (local only, not pushed).
- **Decision (owner):** the PWA is reassigned to the core team. SMS provider setup is parked ("build other things first"). The chat/voice "send message intent" ("Send Mama $200" → review screen → fingerprint) is deferred.
- **Completed:**
  - **`web/`** (Next.js 16.3.7, React 19.3):
    - Mera 0.2.0 `EVERPIECE_ACCOUNT_V1` passkey account, with one passkey prompt per money action.
    - Home: balance, sent list, cancel, return-expired.
    - Send by link: amount → phone → review with fees → one fingerprint signs both the AUSD authorization and the InviteRegistration → WhatsApp / share / copy link.
    - Claim page `/c/[paymentId]#pkg`: the fragment is wiped from the address bar on load; the recipient creates an account, gets the texted code, and claims.
    - Per-request nonce CSP (`proxy.ts`), `no-store` on `/c/*`, Referrer-Policy `no-referrer`, a manifest and a conservative service worker.
  - **Money-safety rule in the send flow:** once `createPayment` is CONFIRMED, the flow retries the invite 3× and never offers a retry that could fund a second payment. If the invite still fails, it shows a "money is protected, cancel from Home" state, and the link is never shown, so nobody can claim it.
  - **Bug fixed:** the invite deadline was `now + 3000` s, but the claims server caps it at 600 s (BadDeadline). It is now `now + 540`.
  - **`scripts/dev-stack.mjs`** (`npm run dev:stack`): anvil Monad fork with Monad-like finality, fresh random in-memory keys, escrow deploy, relayer :8787, claims :8788 (simulated SMS), faucet :8790 (test AUSD, `/sms` viewer), web :3000.
- **Tests run:**
  - Playwright E2E `web/e2e/flow.spec.ts`: **1/1 pass** (54 s) against the dev stack, using a CDP virtual authenticator with PRF, so Mera runs its real code path. The run covers:
    - two passkey accounts, the faucet, and a $25 link send;
    - a wrong code is refused, the right code claims, and the recipient balance shows $25;
    - a second $10 payment is cancelled and the money returns;
    - the dead link and a fragment-less link are refused;
    - zero CSP console errors.
  - Production `next build` + `next start`: nonce CSP present on `/`, `/send` and `/c/*`, with **no console errors**.
  - Workspace offline tests (shared 8, relayer 6, claims 8) and typecheck (including web) are clean.
- **Open / known limits:**
  - SMS is still BLOCKED for real users (Twilio trial is templates only; see VERIFIED §4.6).
  - Username mode has no UI yet. It needs a small username directory.
  - The sent list is kept in `localStorage` only (lost on a new device). The Envio indexer fixes this.
  - The web app has no hosting or domain set up yet (everpiece.xyz is not frozen).
  - Demo persona names in tests/docs still include the owner's name. Waiting on the owner's scrub choice together with the history rewrite.
- **Decisions needed from owner:**
  1. New commit name/email for the history rewrite before any push.
  2. SMS provider path (Twilio upgrade / Termii / wait).
- **Next recommended action:** username payments (directory + UI), then the Envio indexer (sent/received history across devices).

---

## Session 5 — 2026-09-29 — claims/approver server

- **Branch:** `feat/escrow-v1` (local only).
- **Decision (owner):** the claims/approver server is assigned to the core team.
- **Completed:**
  - **SMS provider research** (master §12.2), in VERIFIED §4.4–4.5:
    - Twilio Verify and Termii Token APIs verified from official docs.
    - **Nigeria constraint:** MTN, Airtel and 9mobile reject numeric international senders; alphanumeric sender IDs need 2–3 weeks of registration; DND can filter OTPs. UK is fine with a branded dynamic sender, but generic IDs such as "OTP" or "Verify" are blocked.
  - `@everpiece/shared`: `InviteRegistration` + `ClaimStart` EIP-712 ("Everpiece Claims" v1), `phoneHash`, E.164, and cast vectors reproduced by viem (shared 8/8).
  - **`server/claims`:**
    - sender-signed invite, with the phone AES-GCM at rest;
    - only a link-key holder can trigger an SMS;
    - the provider does the OTP, so we store none;
    - progressive cooldowns with no permanent lockout, and a per-phone daily cap;
    - the approval (300 s) is bound to the wallet that started the session;
    - startup guards (chain, escrow, key == `claimApprover`, key != owner);
    - adapters: Twilio Verify, Termii, and SIMULATED (localhost plus explicit opt-in only).
- **Tests run:**
  - claims: 6 offline + 9 fork. The fork run includes a full invite → code → approval → on-chain `claimLinkPayment` paying 20 AUSD to the verified recipient.
  - Offline workspace (shared 8, relayer 6, claims 6) and typecheck are clean.
  - Evidence: `evidence/claims-v0/`.
- **Open / blocked:**
  - **SMS provider BLOCKED for Nigeria** until the owner chooses a provider, creates the account, registers a sender ID, and a live test send to NG and UK numbers succeeds.
  - Termii adapter TODO(VERIFY): body encoding, phone format, failure shape.
  - The approver key and `PHONE_ENC_KEY` are env vars → KMS/secret manager before mainnet.
- **Decisions needed from owner:**
  1. SMS provider (Twilio Verify vs Termii) and account setup; start sender-ID registration now given the lead time.
  2. If Nigerian delivery isn't proven by about Oct 7: approve or reject the §12.4 sender-assisted fallback, which is weaker and must be labeled as such.
  3. Commit identity for the history rewrite (still pending).
- **Next recommended action:** the PWA (Mera onboarding; send/claim/cancel against the relayer and claims server), then the Envio indexer.

---

## Session 4 — 2026-09-29 — ops verification + gasless relayer

- **Agent:** Everpiece team
- **Branch:** `feat/escrow-v1` (local only, not pushed).
- **Decision (owner):** the **relayer is reassigned from Codex to the core team** (master §43.1 exception). The PWA, claims/approver server, SMS, voice and indexer remain unassigned.
- **Completed:**
  - Verified Monad RPC block tags / finality / receipt semantics (VERIFIED §1.14). Resolved the ESCROW_SPEC §17 TODO: success needs `receipt.blockNumber <= "finalized"`.
  - Verified Safe v1.4.1 on chain 143 (VERIFIED §4.3); bytecode matches the registry.
  - CI workflow (not yet run: no remote); root `README.md`, `AGENTS.md`.
  - Added AUSD's verified custom errors to `IAUSD` (declarations only; escrow bytecode unaffected, 149 offline forge tests re-run green) so services decode AUSD reverts from the shared ABI.
  - npm workspace (root `package.json`): `packages/shared`, `server/relayer`.
  - **`server/relayer`:** HTTP API for exactly five escrow actions and nothing else. It does strict schemas, off-chain signature prechecks, natural-key idempotency, per-IP/per-signer/daily limits, a MON balance guard and a daily gas budget. It simulates at explicit gas limits (so reverts cost no gas) and uses a serialized nonce queue with persisted raw txs and rebroadcast. The monitor confirms only at finality with the expected event and state; everything is stored in SQLite (`node:sqlite`); logs are redacted.
- **Tests run:**
  - relayer offline 6/6;
  - relayer fork (anvil 1.8.3 `--network monad` fork of mainnet, real AUSD) 18/18, including the claim/cancel race where both are included and the loser is FAILED and reconciled;
  - shared 7/7; typecheck clean.
  - Evidence: `evidence/relayer-v0/`.
- **Gas observed (real AUSD, fork):** create 231–265k, username claim 157–174k, link claim ~197k, cancel ~156k, refund ~117k. Every one is under its limit (350k / 215k / 240k / 195k / 145k).
- **Open findings / limits:**
  - The relayer key is an env var: KMS before mainnet.
  - The rate limiter is in-memory, per process.
  - anvil models `finalized` as latest−64 (Monad ≈ latest−2); the relayer logic is identical, and the tests mine past it.
- **TODO(VERIFY):** unchanged from session 3, minus the RPC finality item (resolved) and the multisig item (a test Safe via the UI is still to do).
- **Git identity:** commits use the owner's chosen identity (set 2026-10-06).
- **Next recommended action:**
  1. The owner picks the commit identity → rewrite history → push → CI runs.
  2. Codex Phase A adversarial suite on the escrow.
  3. Next unassigned core pieces: the claims/approver server (link-mode OTP → `ClaimApproval`), then the PWA (Mera onboarding, send/claim/cancel).

---

## Session 3 — 2026-09-29 — EverpieceEscrow v1 implementation

- **Date/time:** 2026-09-29
- **Agent:** Everpiece team
- **Branch:** `feat/escrow-v1` (from `main` @ 4b223f5). Not merged, not pushed; no remote configured.
- **Completed:**
  1. Initialized git; committed the docs, `MASTER_PROMPT.md` (transcribed verbatim from Maris's chat paste; Maris please diff against your original) and Milestone 1 evidence on `main`.
  2. Foundry project `contracts/`: `network = "monad"`, solc 0.8.28, cancun, via-IR; OZ v5.7.0 and forge-std v1.16.2 pinned as submodules.
  3. `EverpieceEscrow.sol` per ESCROW_SPEC v0.2, including:
     - single-signature ERC-3009 funding (nonce = paymentId, all AUSD arguments derived from the intent, exact balance deltas);
     - username claim;
     - two-factor link claim with the approver snapshot;
     - cancel and refund that pause can never block;
     - V1 cap ceilings;
     - the fail-closed AUSD security-mode guard;
     - Ownable2Step with renounce disabled;
     - no admin fund path.
  4. Tests: 177 in total. Unit, exact boundaries, authorization/replay, race/accounting, vectors, fuzz, invariants, and fork against real AUSD.
  5. Slither 0.11.6: 0 high/medium, 13 informational (triaged below).
  6. `packages/shared`: generated ABI, EIP-712 typed data, commitments, `deriveEverpieceAccountV1`, `vectors.json`, and a viem test suite (7/7; 4th independent implementation).
  7. Deploy script with VERIFIED-fact assertions, simulated against mainnet. **Nothing broadcast.**
- **Files changed:**
  - `contracts/{foundry.toml,foundry.lock}`
  - `contracts/src/**`
  - `contracts/test/**` (`adversarial/` has a README only)
  - `contracts/script/DeployEverpieceEscrow.s.sol`
  - `packages/shared/**`
  - `scripts/gen-shared-abi.mjs`
  - `evidence/escrow-v1/**`
  - `docs/{ESCROW_SPEC §22, VERIFIED §1.13/§3.5, THREAT_MODEL §H, INTEGRATION_LEDGER, HANDOFF}`
  - `.gitmodules`
- **Tests run:**
  - `RUN_FORK_TESTS=true FOUNDRY_PROFILE=ci forge test`: **177 passed, 0 failed**.
    - Fuzz: 9 properties × 10,000 runs.
    - Invariants: 8 invariants over 1,024 runs × 128 depth = 131,072 calls.
    - Fork block ≈ 108.92M.
  - `forge test` offline: 149 passed, 2 fork suites skipped.
  - `packages/shared`: `node --test` 7/7; `tsc --noEmit` clean.
  - Outputs are in `evidence/escrow-v1/`.
- **Facts verified:** OZ/forge-std/viem/Slither versions (VERIFIED §1.13). The AUSD receive-upgrade flag is readable on the live system and the guard works on a fork.
- **Open findings:** none CRITICAL/HIGH/MEDIUM known. Slither informational triage:
  - `reentrancy-balance`: the balance-delta check is intentional; `nonReentrant` everywhere; fail-safe.
  - `unused-return`: `tryRecover` error argument ignored on purpose.
  - `timestamp` ×7: expiry semantics by design.
  - `cyclomatic-complexity` (createPayment 13) and naming (`AUSD`, `DOMAIN_SEPARATOR`): accepted.
- **TODO(VERIFY):**
  - hackathon deadline/timezone;
  - Agora bounty text;
  - a test Safe via the UI before transferring ownership (Safe v1.4.1 is verified on 143, VERIFIED §4.3);
  - ownership of `everpiece.xyz` + HTTPS (before freezing the rpId);
  - SMS provider;
  - the `@noble/curves` key API (link package).
- **Blocked integrations:** all optional integrations DISABLED.
- **Decisions (Maris, this session):** expiry 1 d / 30 d / default 30 d; caps $500 / $5,000 as absolute ceilings; username claim to the committed recipient only; two-factor link claim with approver snapshot; owner-only pause that never blocks cancel/refund; no withdraw/rescue/proxy; single-signature ERC-3009 funding; implement the AUSD security-mode guard (conditions met: present, readable, documented); `EVERPIECE_ACCOUNT_V1` unchanged; no custom recovery; target rpId `everpiece.xyz`, not frozen; git initialized; inclusion ≠ success.
- **Deviations from spec:** ESCROW_SPEC §22 (8 items). None alters money semantics. The notable one: `claimKey` may not equal the snapshotted approver (`InvalidClaimKey`).
- **Next recommended action:**
  1. **Codex Phase A**: an adversarial review and suite against `contracts/src/EverpieceEscrow.sol` in `contracts/test/adversarial/` (prompt below).
  2. Maris: push to GitHub, open a PR `feat/escrow-v1 → main`.
  3. Add CI (forge offline suite + `packages/shared` test/typecheck).
  4. After Codex is green, Maris GO → mainnet deploy + canaries A/B/C at about $10 with `setCaps` lowered first.

### Codex Phase A prompt (paste into Codex)

> Read MASTER_PROMPT.md, docs/ESCROW_SPEC.md (v0.2 + §22), docs/THREAT_MODEL.md and contracts/. Assume contracts/src/EverpieceEscrow.sol is vulnerable. Do not edit contracts/src/. Write your attack suite in contracts/test/adversarial/ (you may reuse test/utils/EscrowBase.t.sol and MockAUSD). Execute the full master §44.2 matrix, independently of the core team's tests. Report every issue in the §44.3 format with a regression test. CRITICAL/HIGH block mainnet.

---

## Session 2 — 2026-09-29 — Milestone 1 reconciliation

- **Date/time:** 2026-09-29
- **Agent:** Everpiece team
- **Branch:** none. The repository is **not yet a git repo** (see Decisions needed).
- **Completed:**
  - Read the full master prompt (pasted in chat) and the Maris decisions D1–D10.
  - Reconciled all eight docs. ESCROW_SPEC is now **v0.2** (change table in §21).
  - Upgraded Foundry to 1.8.3 (attestation-verified) and re-ran all AUSD fork evidence under `network = "monad"`: **21/21 pass**.
  - Regenerated the cryptographic vectors for v0.2, triple-checked (cast manual encoding, Solidity, cast typed-data encoder). V_U3 was accepted by live AUSD.
  - Froze the Mera account recipe as `EVERPIECE_ACCOUNT_V1`. Derivation vectors reproduced by 3 implementations.
  - Verified that Envio supports Monad 143. The hackathon window is 1 Sep – 13 Oct (no time/timezone shown).
  - Saved non-secret evidence to `evidence/milestone1/`.
- **Files changed:** `docs/*.md` (all eight); new `evidence/milestone1/**`.
- **Tests run:** `forge test` (Foundry 1.8.3, `network = "monad"`, Monad mainnet fork ≈ block 108,896,566) → 21 passed, 0 failed. Output: `evidence/milestone1/ausd-fork-probe/forge-test-output-foundry-1.8.3-network-monad.txt`.
- **Facts verified:** VERIFIED §1.12 (toolchain), §2.12 (evidence re-run), §3.4 (exact Mera recipe at tag v0.2.0), §4.1 (Envio), §4.2 (hackathon window).
- **Open findings:** none CRITICAL/HIGH known.
  - New engineering finding: AUSD's `isReceiveWithAuthorizationUpgraded` flag could remove the payee check. The proposed fail-safe guard is ESCROW_SPEC §7.4. Codex to review.
- **TODO(VERIFY):** VERIFIED §5. Plus: real-device WebView/PRF/fragment-handoff tests; SMS provider; production rpId.
- **Blocked integrations:** all optional integrations DISABLED (INTEGRATION_LEDGER).
- **Next recommended action:** **Codex independent review of ESCROW_SPEC v0.2 + vectors** (prompt below) → Maris GO → the core team implements `EverpieceEscrow.sol` (master §58 order).

### Owner decisions applied (Maris, 2026-09-29)

| # | Decision | Where applied |
|---|---|---|
| D1 | Username payment releases only to the committed recipient; sender has no special claim; post-claim movement is a separate recipient-signed action | ESCROW §8.3, §9.2; vector V_U5; T50 |
| D2 | Pause blocks create + claims; cancel/refund always available | ESCROW §10; T70 |
| D3 | Caps $500 / $5,000 are initial **and** absolute; owner may only set ≤ ceiling; canaries ≈ $10 | ESCROW §5, §11; T22 |
| D4 | Approver snapshotted per LINK payment; new payments use the current approver; rotation never invalidates existing payments | ESCROW §9.3, §12; V_L8; T60–T63 |
| D5 | Single AUSD signature approved (deployed behavior verified exactly as tested); full preimage binding; contract derives all ERC-3009 args | ESCROW §6.3, §7; V_N1–V_N11 |
| D6 | Use Mera's documented recipe verbatim; freeze + version it; deterministic vectors; no real PRF in fixtures; voice identity separate from the EVM key | ESCROW §18.6; VERIFIED §3.4; THREAT §K |
| D7 | No invented recovery; document the limitation; cancel/refund is the recovery for unclaimed payments | THREAT §F7; PRODUCT §8 |
| D8 | Maris-controlled owner account OK for canaries; multisig before broader exposure; no extra owner powers | ESCROW §2, §13, §20; THREAT §G4 |
| D9 | Transaction inclusion is not application success | ESCROW §17; PRODUCT §9; THREAT §E6 |
| D10 | Foundry upgraded; version + config recorded | VERIFIED §1.12 |

### Conflicts found between the truncated copy (session 1) and the full master prompt — resolved in v0.2

- Status names (ACTIVE), expiry bounds (1–30 days), **no cancel at/after expiry**, salted versioned recipient commitments, an independent link claim key plus a separate voice secret, no phone data on-chain, action nonces, the approver model, the no-rescue rule. Full list: ESCROW_SPEC §21.

### Decisions still needed from Maris

1. **[CONFIRM] Expiry constants**: 1 day minimum, 30 days maximum, 30-day default (master §8 says Maris confirms before freeze).
2. **`setClaimApprover` owner power.** D4 implies a configurable approver, so the owner needs this one power. It affects new link payments only and cannot claim alone. Confirm.
3. **Pause is owner-only** (no separate hot pauser key), to keep owner surface minimal. Confirm, or ask for a pause-only guardian role.
4. **AUSD upgrade guard** (ESCROW §7.4). If Agora flips that flag, new payments halt. This is fail-safe; confirm, or accept the stranding risk instead.
5. **Production domain / rpId.** Irreversible for user accounts; needed before real onboarding (Oct 3).
6. **`git init` + GitHub repo.** Master §0.10 requires branches, PRs and Conventional Commits; nothing is committed yet.
7. **`MASTER_PROMPT.md` is not in the repo root yet.** This session used the copy pasted in chat. Please add the file so future sessions can read it.

### Codex review request (paste into Codex)

> Read MASTER_PROMPT.md, docs/ESCROW_SPEC.md (v0.2), docs/THREAT_MODEL.md, docs/VERIFIED.md §2, and evidence/milestone1/. Independently review the escrow design and test vectors before any contract is written. Do not write contract code or invent a competing ABI. Re-derive at least V_U2, V_U3, V_L2, V_L4, V_L5 and D1/D2 yourself. Return only: CRITICAL/HIGH design problems; incorrect assumptions; missing attack cases; any disagreement with the single-signature ERC-3009 construction (ESCROW §7). Use the finding format from master §44.3. If no blocking issue remains, reply exactly: "ESCROW SPEC REVIEW: READY FOR IMPLEMENTATION".

---

## Session 1 — 2026-09-29 — Milestone 1 verify/specify

- Repo `C:\monadmetr` was **empty** at start: no files, not a git repo, **no pre-existing code**.
- Verified Monad, AUSD (Sourcify source, live reads, fork probe) and Mera 0.2.0 (VERIFIED.md).
- Drafted ESCROW_SPEC v0.1 from a master prompt **truncated at §4.8**. Superseded by v0.2 above.

## Dependency / tooling log

| Date | Change |
|---|---|
| 2026-09-29 | Foundry 1.6.0 → **1.8.3** via `foundryup` (attestation verified) |
| 2026-09-29 | Evidence-only (not app deps): `@scure/bip39 2.4.0`, `@scure/bip32 2.4.0`, `@noble/hashes 2.2.0`, `@noble/curves 2.2.0`, `@category-labs/mera 0.2.0` |
| — | App pins to set later: `@category-labs/mera` exactly `0.2.0`; OpenZeppelin Contracts TODO(VERIFY) |
