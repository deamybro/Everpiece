#!/bin/sh
# Follows the test stack: every stack start is a new chain with a new escrow, published in $STACK_INFO_FILE.
# Waits for it, indexes that escrow from its deploy block with a wiped database (`envio start -r`), and starts over
# when the file changes. If envio itself fails, exit with its code (compose restarts us, with backoff).
set -u
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
  npx envio start -r &
  pid=$!
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
  exit "$code"
done
