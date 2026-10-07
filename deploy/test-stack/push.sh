#!/usr/bin/env bash
# Ship the COMMITTED code to a host and (re)start the test stack there. Usage: deploy/test-stack/push.sh <ssh-host>
# Touches only /opt/everpiece and the everpiece-test compose project on the host.
set -euo pipefail
HOST="${1:?usage: push.sh <ssh-host>}"
ROOT="$(git -C "$(dirname "$0")" rev-parse --show-toplevel)"
ART="contracts/out/EverpieceEscrow.sol/EverpieceEscrow.json contracts/out/TestDollar.sol/TestDollar.json contracts/out/EverpiecePay.sol/EverpiecePay.json contracts/out/EverpieceEarn.sol/EverpieceEarn.json contracts/out/TestYieldVault.sol/TestYieldVault.json"
cd "$ROOT"
for a in $ART; do [ -f "$a" ] || { echo "missing $a: run forge build in contracts/" >&2; exit 1; }; done
[ -z "$(git status --porcelain -- . ':!docs')" ] || echo "warning: uncommitted changes are NOT shipped (git archive HEAD)" >&2
REV="$(git rev-parse --short HEAD)"

ssh "$HOST" 'mkdir -p /opt/everpiece && rm -rf /opt/everpiece/src.new && mkdir /opt/everpiece/src.new'
git archive --format=tar HEAD | ssh "$HOST" 'tar -x -C /opt/everpiece/src.new'
tar -cf - $ART | ssh "$HOST" 'tar -x -C /opt/everpiece/src.new'
ssh "$HOST" "echo $REV > /opt/everpiece/src.new/REVISION && rm -rf /opt/everpiece/src.old && { [ ! -d /opt/everpiece/src ] || mv /opt/everpiece/src /opt/everpiece/src.old; } && mv /opt/everpiece/src.new /opt/everpiece/src && cp /opt/everpiece/src/deploy/test-stack/compose.yaml /opt/everpiece/compose.yaml"
# Test-stack secrets live only on the host (0600), generated once; never in git or on this machine.
ssh "$HOST" 'cd /opt/everpiece && [ -s .env ] || { umask 077; r() { head -c 24 /dev/urandom | od -An -tx1 | tr -d " \n"; }; printf "INDEXER_DB_PASSWORD=%s\nHASURA_ADMIN_SECRET=%s\n" "$(r)" "$(r)" > .env; }'
# The payout server's bank-number encryption key: generated once on the host (0600 .env), kept across deploys.
ssh "$HOST" 'cd /opt/everpiece && grep -q "^TESTNET_PAYOUT_ENC_KEY=" .env || { umask 077; printf "TESTNET_PAYOUT_ENC_KEY=0x%s
" "$(head -c 32 /dev/urandom | od -An -tx1 | tr -d " 
")" >> .env; }'
# Automate's trigger-intake key: generated once on the host (0600 .env), kept across deploys.
ssh "$HOST" 'cd /opt/everpiece && grep -q "^TESTNET_AUTOMATE_KEY=" .env || { umask 077; printf "TESTNET_AUTOMATE_KEY=%s\n" "$(head -c 32 /dev/urandom | od -An -tx1 | tr -d " \n")" >> .env; }'
# One image at a time: image builds are not under the containers' memory caps.
ssh "$HOST" 'cd /opt/everpiece && docker compose build stack && docker compose build indexer && docker compose up -d --force-recreate'
echo "shipped $REV → $HOST:/opt/everpiece (docker compose project everpiece-test)"
