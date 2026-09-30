#!/usr/bin/env bash
# Everpiece Directory v1 vectors (cast + node:crypto HKDF, independent of the viem/noble code under test).
# Test keys are trivial scalars — never fund them.
set -e
export PATH="/c/Users/Admin/.foundry/bin:$PATH"
enc(){ cast abi-encode "$@"; }
CHAIN=143
ESCROW=0x1111111111111111111111111111111111111111
PK_RECIP=0x0000000000000000000000000000000000000000000000000000000000000002
RECIP=$(cast wallet address --private-key $PK_RECIP)
USERNAME=mama
DISPLAY="Mama Ngozi"
DEADLINE=1790812800
PRF=0x0000000000000000000000000000000000000000000000000000000000000000

INBOX_KEY=$(node -e 'const c=require("node:crypto");process.stdout.write("0x"+Buffer.from(c.hkdfSync("sha256",Buffer.alloc(32),Buffer.alloc(0),Buffer.from("everpiece.inbox.v1"),32)).toString("hex"))')
INBOX_KEY_HASH=$(cast keccak $INBOX_KEY)
DOMAIN_TH=$(cast keccak "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)")
DS=$(cast keccak $(enc "f(bytes32,bytes32,bytes32,uint256,address)" $DOMAIN_TH $(cast keccak "Everpiece Directory") $(cast keccak "1") $CHAIN $ESCROW))
TH=$(cast keccak "UsernameRegistration(string username,address account,string displayName,bytes32 inboxKeyHash,uint256 deadline)")
SH=$(cast keccak $(enc "f(bytes32,bytes32,address,bytes32,bytes32,uint256)" $TH $(cast keccak "$USERNAME") $RECIP $(cast keccak "$DISPLAY") $INBOX_KEY_HASH $DEADLINE))
DIGEST=$(cast keccak $(cast concat-hex 0x1901 $DS $SH))
SIG=$(cast wallet sign --no-hash --private-key $PK_RECIP $DIGEST)
cat <<JSON
{
  "note": "Username directory (server/directory), domain Everpiece Directory v1 bound to chain + escrow. Generated with cast; inbox key with node:crypto hkdfSync.",
  "domainSeparator": "$DS",
  "usernameRegistrationTypehash": "$TH",
  "prfOutput": "$PRF",
  "inboxKey": "$INBOX_KEY",
  "inboxKeyHash": "$INBOX_KEY_HASH",
  "username": "$USERNAME",
  "account": "$RECIP",
  "displayName": "$DISPLAY",
  "deadline": "$DEADLINE",
  "digest": "$DIGEST",
  "sig": "$SIG"
}
JSON
