# Everpiece MAINNET indexer (chain 143): the same Envio project as the test stack, with fixed contract addresses.
# Build context: /opt/everpiece-mainnet/indexer-ctx (indexer/ + this entrypoint).
FROM node:24-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
RUN chown node:node /app && mkdir /state && chown node:node /state
USER node
COPY --chown=node:node indexer/ ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force
COPY --chown=node:node indexer-entrypoint.sh /usr/local/bin/indexer-entrypoint.sh
ENV ENVIO_TUI=false ENVIO_BLOCK_LAG=3 ENVIO_RPC_FOR=sync
CMD ["sh", "/usr/local/bin/indexer-entrypoint.sh"]
