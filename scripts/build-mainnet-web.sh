#!/usr/bin/env bash
# Builds the MAINNET web app (standalone) and packs it for the VPS: /tmp/webdist.tgz. Then upload and restart (docs/MAINNET_DEPLOYMENT.md).
# MSYS_NO_PATHCONV stops Git Bash on Windows rewriting "/svc/relayer" into "C:/Program Files/Git/svc/relayer" in the env below,
# and the checks refuse to pack a bundle where that (or a wrong address) happened.
set -euo pipefail
export MSYS_NO_PATHCONV=1
cd "$(dirname "$0")/../web"
rm -rf .next
NEXT_PUBLIC_CHAIN_ID=143 NEXT_PUBLIC_MONAD_RPC=https://rpc.monad.xyz NEXT_PUBLIC_RP_ID=everpiece.xyz \
NEXT_PUBLIC_ESCROW_ADDRESS=0x70ab17cFEe72fFd49F8C766692067D16965F5AA8 \
NEXT_PUBLIC_DOLLAR_ADDRESS=0x754704Bc059F8C67012fEd69BC8A327a5aafb603 NEXT_PUBLIC_DOLLAR_EIP712_NAME=USDC NEXT_PUBLIC_DOLLAR_EIP712_VERSION=2 \
NEXT_PUBLIC_PAY_V2_ADDRESS=0x29D15Bb918589B9dF84EdE5c3B5A7a3Ec89c8eb5 NEXT_PUBLIC_EARN_USDC_ADDRESS=0x73e633b0caCCE41cFbB3278F1D100c9e5F7A373D \
NEXT_PUBLIC_RELAYER_URL=/svc/relayer NEXT_PUBLIC_DIRECTORY_URL=/svc/directory \
NEXT_PUBLIC_USDC_PAYMENTS_ENABLED=true NEXT_PUBLIC_AUSD_PAYMENTS_ENABLED=true NEXT_PUBLIC_DEX_AUSD_FALLBACK_ENABLED=true \
NEXT_PUBLIC_EARN_ENABLED=true NEXT_PUBLIC_PRIVATE_PAYMENTS_ENABLED=true \nNEXT_PUBLIC_FUNDING=live NEXT_PUBLIC_AURORA_LIVE_ENABLED=true NEXT_PUBLIC_FUNDING_CONFIDENTIAL=true \
  npx next build
grep -rhoE 'directoryUrl:"/svc/directory"' .next/static | head -1 | grep -q . || { echo "FAIL: directoryUrl is not /svc/directory"; exit 1; }
grep -rhoE 'relayerUrl:"/svc/relayer"' .next/static | head -1 | grep -q . || { echo "FAIL: relayerUrl is not /svc/relayer"; exit 1; }
if grep -rlF "Program Files" .next/static .next/server .next/standalone/web 2>/dev/null | grep -q .; then echo "FAIL: a Windows path leaked into the bundle"; exit 1; fi
rm -rf .next/cache /tmp/webdist
mkdir -p /tmp/webdist && cp -r .next/standalone/. /tmp/webdist/ && mkdir -p /tmp/webdist/web/.next \
  && cp -r .next/static /tmp/webdist/web/.next/static && cp -r public /tmp/webdist/web/public
tar -czf /tmp/webdist.tgz -C /tmp/webdist . && rm -rf /tmp/webdist
echo "OK: /tmp/webdist.tgz ($(wc -c < /tmp/webdist.tgz) bytes)"
