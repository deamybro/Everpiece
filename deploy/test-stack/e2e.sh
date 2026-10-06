#!/usr/bin/env bash
# Run the web E2E specs ON THE HOST against https://test.everpiece.xyz, in a throwaway capped container (the official
# Playwright image matching web/package.json). For when the local machine is short on memory: each spec opens 2–4
# browsers. Usage: deploy/test-stack/e2e.sh <ssh-host> [spec ...]   (default: all specs, one after another)
# Additive only: /opt/everpiece/e2e-runner plus a container named everpiece-e2e (1.5 GB RAM, 1 CPU, removed on exit).
set -euo pipefail
HOST="${1:?usage: e2e.sh <ssh-host> [spec ...]}"
shift
SPECS="${*:-request add history message username flow email}"
ROOT="$(git -C "$(dirname "$0")" rev-parse --show-toplevel)"
PW="$(node -p "require('$ROOT/web/package.json').devDependencies['@playwright/test']")"

tar -C "$ROOT/web" -cf - e2e playwright.config.ts | ssh "$HOST" \
  'rm -rf /opt/everpiece/e2e-runner && mkdir -p /opt/everpiece/e2e-runner && tar -x -C /opt/everpiece/e2e-runner && echo "{\"private\":true}" > /opt/everpiece/e2e-runner/package.json'
ssh "$HOST" "docker rm -f everpiece-e2e >/dev/null 2>&1; rm -f /opt/everpiece/e2e-runner/out.log; docker run -d --rm --name everpiece-e2e \
  --memory 1500m --memory-swap 1500m --cpus 1 --pids-limit 512 --shm-size 512m -v /opt/everpiece/e2e-runner:/work -w /work \
  -e E2E_BASE_URL=https://test.everpiece.xyz -e E2E_FAUCET_URL=https://test.everpiece.xyz/svc/faucet -e E2E_CLAIMS_URL=https://test.everpiece.xyz/svc/claims \
  mcr.microsoft.com/playwright:v$PW-noble sh -c 'npm i --no-save --no-audit --no-fund @playwright/test@$PW > /work/npm.log 2>&1; \
  for s in $SPECS; do echo \"== \$s\"; npx playwright test e2e/\$s.spec.ts 2>&1 | grep -E \"passed|failed|skipped|Error:|> [0-9]+ \\\\|\"; done > /work/out.log; echo done >> /work/out.log' >/dev/null"
# The host's sshd sometimes resets long sessions: poll in short connections; the run itself continues regardless.
until ssh "$HOST" 'grep -q "^done" /opt/everpiece/e2e-runner/out.log 2>/dev/null'; do sleep 15; done
ssh "$HOST" 'cat /opt/everpiece/e2e-runner/out.log'
