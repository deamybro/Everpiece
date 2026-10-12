#!/usr/bin/env bash
# Runs ON the VPS (root). Expects /opt/everpiece-mainnet/indexer-src.tgz (the repo's indexer/ dir + deploy/mainnet/*).
set -euo pipefail
cd /opt/everpiece-mainnet
rm -rf indexer-stack && mkdir -p indexer-stack/indexer-ctx
tar -xzf indexer-src.tgz -C indexer-stack/indexer-ctx indexer
tar -xzf indexer-src.tgz -C indexer-stack --strip-components=2 deploy/mainnet/compose.yaml
tar -xzf indexer-src.tgz -C indexer-stack/indexer-ctx --strip-components=2 deploy/mainnet/indexer.Dockerfile deploy/mainnet/indexer-entrypoint.sh
rm indexer-src.tgz
cd indexer-stack
# secrets generated here, once, and never printed
[ -s .env ] || (umask 077; printf 'INDEXER_DB_PASSWORD=%s\nHASURA_ADMIN_SECRET=%s\n' "$(openssl rand -hex 24)" "$(openssl rand -hex 24)" > .env)
docker compose build 2>&1 | tail -3
docker compose up -d 2>&1 | tail -4
echo "http://127.0.0.1:47316/v1/graphql" > /opt/everpiece-mainnet/indexer.url
sleep 20
docker compose ps --format '{{.Name}} {{.Status}}'
