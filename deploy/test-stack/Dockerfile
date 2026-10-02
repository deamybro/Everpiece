# Everpiece TEST STACK image: Monad mainnet fork + escrow + relayer + claims (simulated SMS) + directory + faucet + web.
# Test Dollars only. Fresh random keys every start, held in memory. Build context: a `git archive` of the repo plus
# contracts/out/EverpieceEscrow.sol/EverpieceEscrow.json (git submodules aren't in the archive; see push.sh).
FROM ghcr.io/foundry-rs/foundry:v1.8.3 AS foundry

FROM node:24-bookworm-slim
# anvil forks over HTTPS and needs the system CA bundle (absent from the slim image).
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/*
COPY --from=foundry /usr/local/bin/anvil /usr/local/bin/anvil
WORKDIR /app
RUN chown node:node /app && mkdir -p /shared /data && chown node:node /shared /data
USER node
COPY --chown=node:node . .
RUN npm ci --no-audit --no-fund && npm cache clean --force
ENV STACK_BIND_HOST=0.0.0.0 \
    STACK_WEB=prod \
    STACK_WEB_BUILDER=webpack \
    NEXT_TELEMETRY_DISABLED=1
# compose picks the script: dev-stack.mjs (private fork, default) or testnet-stack.mjs (Monad testnet).
CMD ["node", "scripts/dev-stack.mjs"]
