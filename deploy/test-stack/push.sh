#!/usr/bin/env bash
# Ship the COMMITTED code to a host and (re)start the test stack there. Usage: deploy/test-stack/push.sh <ssh-host>
# Touches only /opt/everpiece and the everpiece-test compose project on the host.
set -euo pipefail
HOST="${1:?usage: push.sh <ssh-host>}"
ROOT="$(git -C "$(dirname "$0")" rev-parse --show-toplevel)"
ART="contracts/out/EverpieceEscrow.sol/EverpieceEscrow.json"
cd "$ROOT"
[ -f "$ART" ] || { echo "missing $ART: run forge build in contracts/" >&2; exit 1; }
[ -z "$(git status --porcelain -- . ':!docs')" ] || echo "warning: uncommitted changes are NOT shipped (git archive HEAD)" >&2
REV="$(git rev-parse --short HEAD)"

ssh "$HOST" 'mkdir -p /opt/everpiece && rm -rf /opt/everpiece/src.new && mkdir /opt/everpiece/src.new'
git archive --format=tar HEAD | ssh "$HOST" 'tar -x -C /opt/everpiece/src.new'
tar -cf - "$ART" | ssh "$HOST" 'tar -x -C /opt/everpiece/src.new'
ssh "$HOST" "echo $REV > /opt/everpiece/src.new/REVISION && rm -rf /opt/everpiece/src.old && { [ ! -d /opt/everpiece/src ] || mv /opt/everpiece/src /opt/everpiece/src.old; } && mv /opt/everpiece/src.new /opt/everpiece/src && cp /opt/everpiece/src/deploy/test-stack/compose.yaml /opt/everpiece/compose.yaml"
ssh "$HOST" 'cd /opt/everpiece && docker compose build && docker compose up -d --force-recreate'
echo "shipped $REV → $HOST:/opt/everpiece (docker compose project everpiece-test)"
