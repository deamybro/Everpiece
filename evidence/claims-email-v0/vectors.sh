#!/usr/bin/env bash
# Everpiece Claims v1 — EmailInviteRegistration vectors (cast only, independent of the viem code under test).
# Same domain, payment and deadline as the phone InviteRegistration vectors. Test keys are trivial scalars — never fund them.
set -e
export PATH="/c/Users/Admin/.foundry/bin:$PATH"
enc(){ cast abi-encode "$@"; }
CHAIN=143
ESCROW=${ESCROW:?}
PAYMENT_ID=${PAYMENT_ID:?}
DEADLINE=${DEADLINE:?}
PK_SENDER=0x0000000000000000000000000000000000000000000000000000000000000001
EMAIL="mama.ngozi@example.com"   # already normalized (trimmed, lowercase ASCII)

DOMAIN_TH=$(cast keccak "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)")
DS=$(cast keccak $(enc "f(bytes32,bytes32,bytes32,uint256,address)" $DOMAIN_TH $(cast keccak "Everpiece Claims") $(cast keccak "1") $CHAIN $ESCROW))
TH=$(cast keccak "EmailInviteRegistration(bytes32 paymentId,bytes32 emailHash,uint256 deadline)")
EMAIL_HASH=$(cast keccak "$EMAIL")
SH=$(cast keccak $(enc "f(bytes32,bytes32,bytes32,uint256)" $TH $PAYMENT_ID $EMAIL_HASH $DEADLINE))
DIGEST=$(cast keccak $(cast concat-hex 0x1901 $DS $SH))
SIG=$(cast wallet sign --no-hash --private-key $PK_SENDER $DIGEST)
cat <<JSON
{
  "note": "EmailInviteRegistration (server/claims, email channel). Domain Everpiece Claims v1; same payment/deadline as the phone vectors. Generated with cast.",
  "domainSeparator": "$DS",
  "emailInviteRegistrationTypehash": "$TH",
  "email": "$EMAIL",
  "emailHash": "$EMAIL_HASH",
  "paymentId": "$PAYMENT_ID",
  "deadline": "$DEADLINE",
  "digest": "$DIGEST",
  "sig": "$SIG"
}
JSON
