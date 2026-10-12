#!/usr/bin/env bash
# Runs ON the VPS (as root): installs/updates the Everpiece MAINNET services under /opt/everpiece-mainnet.
# Additive only: its own directory, its own systemd units, one Caddy block, nothing of other projects.
# Usage (from the repo, see docs/MAINNET_DEPLOYMENT.md):  tar the sources -> scp -> bash this script on the VPS.
set -euo pipefail
cd /opt/everpiece-mainnet

# --- sources (extracted by the caller into ./b.tgz) --------------------------------------------------------------------
rm -rf src/packages src/server
tar -xzf b.tgz -C src && rm b.tgz
cat > src/package.json <<'EOF'
{ "name": "everpiece-mainnet", "private": true, "workspaces": ["packages/shared", "server/relayer", "server/directory", "server/voice", "server/automate", "server/claims"] }
EOF
(cd src && npm install --omit=dev --no-audit --no-fund 2>&1 | tail -1)

# --- non-secret config -------------------------------------------------------------------------------------------------
cat > voice.env <<'EOF'
MONAD_RPC=https://rpc.monad.xyz
EXPECTED_CHAIN_ID=143
HOST=127.0.0.1
PORT=47312
VOICE_DB_PATH=/opt/everpiece-mainnet/voice.sqlite
ESCROW_ADDRESS=0x70ab17cFEe72fFd49F8C766692067D16965F5AA8
TRUST_PROXY=1
EOF
cat > automate.env <<'EOF'
MONAD_RPC=https://rpc.monad.xyz
EXPECTED_CHAIN_ID=143
HOST=127.0.0.1
PORT=47313
AUTOMATE_DB=/opt/everpiece-mainnet/automate.sqlite
# signed records use the same domain as usernames: the escrow address
DIRECTORY_DOMAIN_ADDRESS=0x70ab17cFEe72fFd49F8C766692067D16965F5AA8
# rules move USDC; Earn = the USDC Earn contract and its Aave vault
AUTOMATE_ASSET=0x754704Bc059F8C67012fEd69BC8A327a5aafb603
EARN_ADDRESS=0x73e633b0caCCE41cFbB3278F1D100c9e5F7A373D
EARN_VAULT_ADDRESS=0xC554aFfE2f581F5E0811e0D42D484ECaC5c6B8e2
EARN_OPPORTUNITY_ID=aave-v3-usdc
ESCROW_ASSET=0x754704Bc059F8C67012fEd69BC8A327a5aafb603
AUTOMATE_ADDRESS=0xEC3F0a726Ad4604B20F71CeD79059e0aAA2f3732
AUTOMATE_EXECUTOR=0x8AEDdD970373eB53Dc318f85a7854a444B13F2C6
RELAYER_URL=http://127.0.0.1:47310
TRUST_PROXY=1
EOF
cat > claims.env <<'EOF'
MONAD_RPC=https://rpc.monad.xyz
EXPECTED_CHAIN_ID=143
HOST=127.0.0.1
PORT=47314
CLAIMS_DB_PATH=/opt/everpiece-mainnet/claims.sqlite
ESCROW_ADDRESS=0x70ab17cFEe72fFd49F8C766692067D16965F5AA8
SMS_PROVIDER=twilio
EMAIL_PROVIDER=resend
ALLOWED_ORIGIN=https://app.everpiece.xyz
TRUST_PROXY=1
EOF
chmod 644 voice.env automate.env claims.env

# --- the Automate service gets exactly two secrets, neither ever shown or copied elsewhere ------------------------------
# automate.key: generated here on first start (gates the internal trigger route); RELAYER_INTERNAL_KEY: read from relayer.env.
cat > run-automate.sh <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
cd /opt/everpiece-mainnet
[ -s automate.key ] || (umask 077; openssl rand -hex 32 > automate.key)
export AUTOMATE_INTERNAL_KEY="$(cat automate.key)"
export RELAYER_INTERNAL_KEY="$(grep '^RELAYER_INTERNAL_KEY=' relayer.env | cut -d= -f2-)"
# the indexer (shared history + payment triggers), when it is running
[ -f indexer.url ] && export INDEXER_URL="$(cat indexer.url)"
cd src/server/automate
exec /usr/bin/node src/main.ts
EOF
chmod 700 run-automate.sh

# --- the claims service: secrets are read from root-only files at start, never copied into a unit or an env file ----------
cat > run-claims.sh <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
cd /opt/everpiece-mainnet
export APPROVER_PRIVATE_KEY="$(grep -i '^Private key' approver.txt | awk '{print $NF}')"
export PHONE_ENC_KEY="$(cat phone-enc.key)"
# provider credentials shared with the earlier stack; only these names are taken
for k in TWILIO_API_USER TWILIO_API_SECRET TWILIO_VERIFY_SERVICE_SID RESEND_API_KEY EMAIL_FROM; do
  export "$k=$(grep "^$k=" /opt/everpiece/.env | head -1 | cut -d= -f2-)"
done
cd src/server/claims
exec /usr/bin/node src/main.ts
EOF
chmod 700 run-claims.sh

unit() { # name, description, envfile, workdir, cmd, mem
  cat > "/etc/systemd/system/$1.service" <<EOF
[Unit]
Description=$2
After=network-online.target
Wants=network-online.target

[Service]
WorkingDirectory=$4
EnvironmentFile=$3
ExecStart=$5
Restart=on-failure
RestartSec=5
MemoryMax=$6
NoNewPrivileges=true
ProtectSystem=full
ReadWritePaths=/opt/everpiece-mainnet

[Install]
WantedBy=multi-user.target
EOF
}
unit everpiece-mainnet-voice "Everpiece MAINNET encrypted message store (localhost only)" /opt/everpiece-mainnet/voice.env /opt/everpiece-mainnet/src/server/voice "/usr/bin/node src/main.ts" 150M
unit everpiece-mainnet-automate "Everpiece MAINNET Automate service (localhost only)" /opt/everpiece-mainnet/automate.env /opt/everpiece-mainnet/src/server/automate "/opt/everpiece-mainnet/run-automate.sh" 250M
unit everpiece-mainnet-claims "Everpiece MAINNET claims service (localhost only)" /opt/everpiece-mainnet/claims.env /opt/everpiece-mainnet/src/server/claims "/opt/everpiece-mainnet/run-claims.sh" 200M
systemctl daemon-reload
systemctl enable everpiece-mainnet-voice everpiece-mainnet-automate everpiece-mainnet-claims >/dev/null 2>&1
systemctl restart everpiece-mainnet-voice everpiece-mainnet-automate everpiece-mainnet-claims
systemctl restart everpiece-mainnet-relayer everpiece-mainnet-directory
sleep 8
for s in relayer directory voice automate claims web; do echo "$s: $(systemctl is-active everpiece-mainnet-$s)"; done
