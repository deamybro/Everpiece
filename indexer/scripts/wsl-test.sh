#!/usr/bin/env bash
# Run the indexer's codegen, typecheck and tests in WSL (Envio has no Windows build). Syncs the repo's indexer and
# shared sources into a WSL-local copy first (installs on /mnt/c are very slow) and fails if any copy differs.
# Usage from Windows: wsl -d Debian -- bash /mnt/c/monadmetr/indexer/scripts/wsl-test.sh
set -euo pipefail
SRC=/mnt/c/monadmetr
DST="$HOME/everpiece"
mkdir -p "$DST/indexer" "$DST/packages"

rm -rf "$DST/packages/shared" "$DST/indexer/src" "$DST/indexer/test"
cp -r "$SRC/packages/shared" "$DST/packages/shared"
rm -rf "$DST/packages/shared/node_modules"
cp -r "$SRC/indexer/src" "$SRC/indexer/test" "$DST/indexer/"
for f in config.yaml schema.graphql vitest.config.ts tsconfig.json envio-env.d.ts package.json package-lock.json; do
  cp -f "$SRC/indexer/$f" "$DST/indexer/$f"
done
for f in config.yaml schema.graphql src/handlers/EverpieceEscrow.ts src/handlers/EverpieceEarn.ts test/handlers.test.ts; do
  cmp -s <(tr -d '\r' < "$SRC/indexer/$f") <(tr -d '\r' < "$DST/indexer/$f") || { echo "sync failed: $f" >&2; exit 1; }
done
echo "synced"

cd "$DST/indexer"
[ -d node_modules ] || npm ci --no-audit --no-fund
ENVIO_ESCROW_START_BLOCK=1 ENVIO_ESCROW_ADDRESS=0x0000000000000000000000000000000000000001 \
  ENVIO_PAY_ADDRESS=0x0000000000000000000000000000000000000002 ENVIO_EARN_ADDRESS=0x0000000000000000000000000000000000000003 \
  ENVIO_BLOCK_LAG=0 ENVIO_CHAIN_ID=143 \
  ENVIO_RPC_URL=http://localhost:8545 ENVIO_RPC_FOR=sync npx envio codegen > /tmp/envio-codegen.log 2>&1 \
  || { tail -20 /tmp/envio-codegen.log; exit 1; }
echo "codegen ok"
npm run typecheck
npx vitest run
