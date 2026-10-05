#!/bin/sh
# Follows the test stack's $STACK_INFO_FILE (escrow, pay, start block). A fork stack gets a new chain on every start;
# the testnet stack keeps the same contracts. So: if the info AND the indexer code are what we last indexed (marker in
# /state), resume (`envio start`); otherwise wipe and index from the deploy block (`envio start -r`). Re-indexing
# testnet from scratch on every deploy saturated the public RPC's per-IP limit and starved the faucet/relayer sends.
# Starts over when the file changes. If envio itself fails, exit with its code (compose restarts us, with backoff).
set -u
STATE=/state/indexed
code_hash() { cat /app/config.yaml /app/schema.graphql $(find /app/src -type f | sort) | sha256sum | cut -d" " -f1; }
INFO="${STACK_INFO_FILE:?}"
field() { node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"))[process.argv[2]])' "$INFO" "$1"; }

while :; do
  while [ ! -s "$INFO" ]; do sleep 2; done
  gen="$(cat "$INFO")"
  ENVIO_ESCROW_ADDRESS="$(field escrow)"
  ENVIO_ESCROW_START_BLOCK="$(field deployBlock)"
  ENVIO_PAY_ADDRESS="$(field pay)"
  case "$ENVIO_PAY_ADDRESS" in 0x*) ;; *) ENVIO_PAY_ADDRESS=0x0000000000000000000000000000000000000000 ;; esac
  export ENVIO_ESCROW_ADDRESS ENVIO_ESCROW_START_BLOCK ENVIO_PAY_ADDRESS
  echo "indexer: escrow $ENVIO_ESCROW_ADDRESS, pay $ENVIO_PAY_ADDRESS from block $ENVIO_ESCROW_START_BLOCK (lag $ENVIO_BLOCK_LAG)"
  want="$gen $(code_hash)"
  if [ -s "$STATE" ] && [ "$(cat "$STATE")" = "$want" ]; then
    reset=""
    echo "indexer: same contracts and code as last run; resuming"
  else
    reset="-r"
    echo "indexer: new contracts or indexer code; indexing from scratch"
  fi
  npx envio start $reset &
  pid=$!
  printf '%s' "$want" > "$STATE"
  while kill -0 "$pid" 2>/dev/null; do
    sleep 5
    if [ "$(cat "$INFO" 2>/dev/null)" != "$gen" ]; then
      echo "indexer: the stack restarted on a new chain; re-indexing from scratch"
      kill "$pid" 2>/dev/null
      wait "$pid" 2>/dev/null
      continue 2
    fi
  done
  wait "$pid"
  code=$?
  echo "indexer: envio exited with $code"
  # a failed resume must not loop: the next start wipes and re-indexes
  [ "$code" -eq 0 ] || rm -f "$STATE"
  exit "$code"
done
