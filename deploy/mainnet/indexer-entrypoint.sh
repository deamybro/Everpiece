#!/bin/sh
# Mainnet: fixed contracts. Resume (`envio start`) when the code and addresses are what we last indexed (marker in /state);
# otherwise, or after 3 failed runs in a row, wipe and index from the start block (`envio start -r`).
set -u
STATE=/state/indexed
FAILS=/state/failures
code_hash() { cat /app/config.yaml /app/schema.graphql $(find /app/src -type f | sort) | sha256sum | cut -d" " -f1; }
want="$ENVIO_ESCROW_ADDRESS $ENVIO_PAY_V2_ADDRESS $ENVIO_EARN_ADDRESS $ENVIO_ESCROW_START_BLOCK $(code_hash)"
fails="$(cat "$FAILS" 2>/dev/null || echo 0)"
if [ -s "$STATE" ] && [ "$(cat "$STATE")" = "$want" ] && [ "$fails" -lt 3 ]; then
  reset=""; echo "indexer: same contracts and code as last run; resuming"
else
  reset="-r"; echo "indexer: new contracts/code or repeated failures ($fails); indexing from block $ENVIO_ESCROW_START_BLOCK"
  echo 0 > "$FAILS"
fi
npx envio start $reset &
pid=$!
printf '%s' "$want" > "$STATE"
ticks=0
while kill -0 "$pid" 2>/dev/null; do
  sleep 5; ticks=$((ticks + 1))
  [ "$ticks" -ne 60 ] || echo 0 > "$FAILS"
done
wait "$pid"; code=$?
echo "indexer: envio exited with $code"
[ "$code" -eq 0 ] || echo $(( $(cat "$FAILS" 2>/dev/null || echo 0) + 1 )) > "$FAILS"
exit "$code"
