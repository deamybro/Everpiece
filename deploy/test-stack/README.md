# Test stack on a server (test Dollars only)

Runs the same stack as `npm run dev:stack` in one container: a Monad mainnet fork, a fresh escrow, the relayer, claims (simulated SMS), directory, faucet and the production web build.
Every start makes **new random keys and a new escrow**, so passkey accounts from a previous start see an empty test chain.

## Shared-host rules (the target box runs other projects)

- It is additive only: `/opt/everpiece` plus the compose project `everpiece-test`. Never `docker compose down` other projects, never prune, and never restart shared services.
- Ports are published on **127.0.0.1 only** (47300–47307). Nothing is public, and the shared Caddy is untouched.
- Caps: 1200 MB RAM (no swap), 1 CPU, 512 processes, `restart: on-failure:3`, rotated logs (3 × 10 MB). An overrun kills only this container. This was verified: a Turbopack build that hit the cap was killed with `CONSTRAINT_MEMCG` and nothing else was touched.
- The web is built with **webpack** in the container (measured peak 745 MB; Turbopack needed more than 1.15 GB). Local builds still use Turbopack.

## Deploy (committed code only)

```bash
deploy/test-stack/push.sh <ssh-host>
```

## Use it from your computer

The ports are the same on both ends (47300–47307), so the tunnel can't clash with other local tunnels on 3000 or 8787. Open it and leave it running:

```bash
ssh -N -L 47300:127.0.0.1:47300 -L 47301:127.0.0.1:47301 -L 47302:127.0.0.1:47302 -L 47303:127.0.0.1:47303 -L 47304:127.0.0.1:47304 -L 47305:127.0.0.1:47305 -L 47306:127.0.0.1:47306 -L 47307:127.0.0.1:47307 <ssh-host>
```

The host's sshd is constantly probed from the internet and sometimes resets connections, so a self-reconnecting tunnel is handier:

```bash
while true; do ssh -N -o ServerAliveInterval=30 -o ExitOnForwardFailure=yes -L 47300:127.0.0.1:47300 -L 47301:127.0.0.1:47301 -L 47302:127.0.0.1:47302 -L 47303:127.0.0.1:47303 -L 47304:127.0.0.1:47304 -L 47305:127.0.0.1:47305 -L 47306:127.0.0.1:47306 -L 47307:127.0.0.1:47307 <ssh-host>; sleep 3; done
```

- **The app:** http://localhost:47300. Passkeys work because the browser sees `localhost`.
- **Simulated texts:** http://127.0.0.1:47305/sms
- **Indexer GraphQL:** http://127.0.0.1:47306/v1/graphql. It is read-only with the `public` role and needs no key.
- **E2E tests against the server:** run `cd web && E2E_BASE_URL=http://localhost:47300 E2E_FAUCET_URL=http://127.0.0.1:47305 E2E_CLAIMS_URL=http://127.0.0.1:47303 npx playwright test` while the tunnel is open.
- **Status and logs:** `ssh <ssh-host> 'cd /opt/everpiece && docker compose ps && docker compose logs --tail 50'`
- **Stop:** `ssh <ssh-host> 'cd /opt/everpiece && docker compose stop'` stops only Everpiece.

## Public test site (https://test.everpiece.xyz)

With `STACK_PUBLIC_ORIGIN=https://test.everpiece.xyz` in the host's `.env`, the app has one public HTTPS origin and no tunnel is needed.

- **Routing:** the host's Caddy has one Everpiece-only site block, appended with a timestamped backup, validated first and reloaded gracefully.
  - `/` → 47300 (web)
  - `/svc/relayer|claims|directory|faucet/*` → 47302–47305, and `/svc/voice/*` → 47307 (encrypted message store, body ≤ 1100 KB), with the prefix stripped
- **No public raw RPC.** The browser uses `/svc/faucet/rpc`, which only allows `eth_chainId`, `eth_blockNumber`, `net_version`, `eth_getBlockByNumber(tag, false)` and `eth_call` to the escrow or AUSD. Every `anvil_*`, `evm_*` and send method is refused, and a batch is refused if any call in it is. anvil's port stays on 127.0.0.1.
- **Rate limits:** the services see the visitor's address via `TRUST_PROXY=1`, so limits are per visitor.
- **Passkeys** belong to `test.everpiece.xyz` (rpId = hostname). They are separate from the future production domain.
- **E2E:** run `E2E_BASE_URL=https://test.everpiece.xyz E2E_FAUCET_URL=https://test.everpiece.xyz/svc/faucet E2E_CLAIMS_URL=https://test.everpiece.xyz/svc/claims npx playwright test`.
- **E2E from the host** (when the local machine is short on memory; each spec opens 2–4 browsers): `deploy/test-stack/e2e.sh <ssh-host> [spec ...]` runs them one after another in a throwaway Playwright container capped at 1.5 GB / 1 CPU (`/opt/everpiece/e2e-runner`, container `everpiece-e2e`). `flow` and `email` skip themselves here (real SMS and email).
- **Anyone with the link can use it.** Test Dollars only, but claim-code emails are real, so abuse is capped only by the per-address and per-IP limits and Resend's 100 a day.

## Real claim-code emails (Resend)

The stack sends real emails when the host's `.env` has both `RESEND_API_KEY` and `EMAIL_FROM`; otherwise email is simulated.

1. Put both settings on the host. The value is read with hidden input and goes over SSH stdin, never into git, chat or a command line:

   ```bash
   deploy/test-stack/set-secret.sh <ssh-host> RESEND_API_KEY
   ```

   ```bash
   deploy/test-stack/set-secret.sh <ssh-host> EMAIL_FROM
   ```

   `EMAIL_FROM` looks like `Everpiece <codes@mail.everpiece.xyz>`, on a domain verified in Resend.
2. Restart the stack:

   ```bash
   ssh <ssh-host> 'cd /opt/everpiece && docker compose up -d --force-recreate stack'
   ```

   The claims log then shows `"email":"resend"` and `/healthz` shows `emailLive: true`.
3. `e2e/email.spec.ts` skips itself when email is live, because it can't read a real inbox. Check a real inbox by hand instead.

## Indexer

`indexer`, `indexer-db` (postgres:18.3) and `indexer-hasura` (v2.43.0) are the versions envio 3.12.1 uses.

- **Start order:** they wait for the stack's healthcheck, so their ~0.4 GB never lands on top of the web build.
- **New chain, fresh index:** each stack start publishes a new escrow in the shared `stack-info` volume. The indexer then re-indexes from scratch with `envio start -r`.
- **Secrets:** `.env` on the host holds the database password and the Hasura admin secret. It is generated by `push.sh` with mode 0600 and never leaves the host.
- **Caps:** 192 / 320 / 384 MB.
