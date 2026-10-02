# HANDOFF.md

Read `MASTER_PROMPT.md` (full v3.2), this file, and the repo before continuing.

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
