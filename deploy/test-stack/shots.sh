#!/usr/bin/env bash
# Phone-size screenshots of the live test site for design review: runs web/e2e/shots.spec.ts on the host in the same
# capped throwaway Playwright container as e2e.sh, then copies the PNGs here. Usage: shots.sh <ssh-host> <local-dir>
set -euo pipefail
HOST="${1:?usage: shots.sh <ssh-host> <local-dir>}"
OUT="${2:?usage: shots.sh <ssh-host> <local-dir>}"
ROOT="$(git -C "$(dirname "$0")" rev-parse --show-toplevel)"
PW="$(node -p "require('$ROOT/web/package.json').devDependencies['@playwright/test']")"
tar -C "$ROOT/web" -cf - e2e playwright.config.ts | ssh "$HOST" \
  'rm -rf /opt/everpiece/e2e-runner && mkdir -p /opt/everpiece/e2e-runner/shots && chmod 777 /opt/everpiece/e2e-runner/shots && tar -x -C /opt/everpiece/e2e-runner && echo "{\"private\":true}" > /opt/everpiece/e2e-runner/package.json'
ssh "$HOST" "docker rm -f everpiece-e2e >/dev/null 2>&1; docker run -d --rm --name everpiece-e2e --memory 1500m --memory-swap 1500m --cpus 1 --pids-limit 512 --shm-size 512m \
  -v /opt/everpiece/e2e-runner:/work -w /work -e E2E_SHOTS=1 -e E2E_BASE_URL=https://test.everpiece.xyz -e E2E_FAUCET_URL=https://test.everpiece.xyz/svc/faucet \
  mcr.microsoft.com/playwright:v$PW-noble sh -c 'npm i --no-save --no-audit --no-fund @playwright/test@$PW > /work/npm.log 2>&1; npx playwright test e2e/shots.spec.ts > /work/out.log 2>&1; echo done >> /work/out.log' >/dev/null"
until ssh "$HOST" 'grep -q "^done" /opt/everpiece/e2e-runner/out.log 2>/dev/null'; do sleep 10; done
ssh "$HOST" 'grep -E "passed|failed|Error" /opt/everpiece/e2e-runner/out.log | head -5'
mkdir -p "$OUT"
ssh "$HOST" 'cd /opt/everpiece/e2e-runner/shots && tar -cf - *.png' | tar -x -C "$OUT"
ls "$OUT"
