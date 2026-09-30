# Test stack on a server (test Dollars only)

Runs the same stack as `npm run dev:stack` in one container: a Monad mainnet fork, a fresh escrow, the relayer, claims (simulated SMS), directory, faucet and the production web build.
Every start makes **new random keys and a new escrow**, so passkey accounts from a previous start see an empty test chain.

## Shared-host rules (the target box runs other projects)

- It is additive only: `/opt/everpiece` plus the compose project `everpiece-test`. Never `docker compose down` other projects, never prune, and never restart shared services.
- Ports are published on **127.0.0.1 only** (47300–47305). Nothing is public, and the shared Caddy is untouched.
- Caps: 1200 MB RAM (no swap), 1 CPU, 512 processes, `restart: on-failure:3`, rotated logs (3 × 10 MB). An overrun kills only this container.

## Deploy (committed code only)

```bash
deploy/test-stack/push.sh <ssh-host>
```

## Use it from your computer

Open the tunnel, and leave it running:

```bash
ssh -N -L 3000:127.0.0.1:47300 -L 8545:127.0.0.1:47301 -L 8787:127.0.0.1:47302 -L 8788:127.0.0.1:47303 -L 8789:127.0.0.1:47304 -L 8790:127.0.0.1:47305 <ssh-host>
```

- **The app:** http://localhost:3000. Passkeys work because the browser sees `localhost`.
- **Simulated texts:** http://127.0.0.1:8790/sms
- **E2E tests against the server:** run `cd web && npx playwright test` while the tunnel is open.
- **Status and logs:** `ssh <ssh-host> 'cd /opt/everpiece && docker compose ps && docker compose logs --tail 50'`
- **Stop:** `ssh <ssh-host> 'cd /opt/everpiece && docker compose stop'` stops only Everpiece.
