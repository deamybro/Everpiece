#!/usr/bin/env bash
# Everpiece ESCROW_SPEC v0.2 test-vector generator (cast). Test keys are trivial scalars — never fund them.
set -e
export PATH="/c/Users/Admin/.foundry/bin:$PATH"
k(){ cast keccak "$1"; }
enc(){ cast abi-encode "$@"; }
h(){ cast keccak $(enc "$@"); }
sign(){ cast wallet sign --no-hash --private-key $1 $2; }
digest(){ cast keccak $(cast concat-hex 0x1901 $1 $2); }
verify(){ if cast wallet verify --no-hash --address $1 $2 $3 >/dev/null 2>&1; then echo true; else echo false; fi; }

CHAIN=143
ESCROW=0x1111111111111111111111111111111111111111
AUSD=0x00000000eFE302BEAA2b3e6e1b18d08D69a9012a
PK_SENDER=0x0000000000000000000000000000000000000000000000000000000000000001
PK_RECIP=0x0000000000000000000000000000000000000000000000000000000000000002
PK_APPROVER=0x0000000000000000000000000000000000000000000000000000000000000003
PK_CLAIMKEY=0x0000000000000000000000000000000000000000000000000000000000000004
PK_APPROVER2=0x0000000000000000000000000000000000000000000000000000000000000005
SENDER=$(cast wallet address --private-key $PK_SENDER)
RECIP=$(cast wallet address --private-key $PK_RECIP)
APPROVER=$(cast wallet address --private-key $PK_APPROVER)
CLAIMKEY=$(cast wallet address --private-key $PK_CLAIMKEY)
APPROVER2=$(cast wallet address --private-key $PK_APPROVER2)
STELLA=0x000000000000000000000000000000000000057e
ZERO=0x0000000000000000000000000000000000000000
echo "SENDER=$SENDER"; echo "RECIPIENT=$RECIP"; echo "APPROVER=$APPROVER"; echo "CLAIMKEY=$CLAIMKEY"; echo "APPROVER2=$APPROVER2"

T_RECIP=$(k "everpiece.recipient.v1"); T_META=$(k "everpiece.metadata.v1")
echo "TAG_RECIPIENT_V1=$T_RECIP"; echo "TAG_METADATA_V1=$T_META"

DTH=$(k "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)")
DS=$(h 'f(bytes32,bytes32,bytes32,uint256,address)' $DTH $(k "Everpiece Escrow") $(k "1") $CHAIN $ESCROW)
AUSD_DS=$(h 'f(bytes32,bytes32,bytes32,uint256,address)' $DTH $(k "Agora Dollar") $(k "1") $CHAIN $AUSD)
echo "ESCROW_DOMAIN_SEPARATOR=$DS"; echo "AUSD_DOMAIN_SEPARATOR=$AUSD_DS"

PI_SIG="PaymentIntent(address sender,uint8 mode,bytes32 recipientCommitment,bytes32 metadataCommitment,address approver,uint256 amount,uint256 expiresAt,uint256 validAfter,uint256 validBefore,bytes32 salt)"
PI_TH=$(k "$PI_SIG")
CI_TH=$(k "ClaimIntent(bytes32 paymentId,address recipient,bytes32 actionNonce,uint256 deadline)")
LCI_TH=$(k "LinkClaimIntent(bytes32 paymentId,address recipient,bytes32 actionNonce,uint256 deadline)")
CA_TH=$(k "ClaimApproval(bytes32 paymentId,address recipient,bytes32 approvalNonce,uint256 deadline)")
XI_TH=$(k "CancelIntent(bytes32 paymentId,address sender,bytes32 actionNonce,uint256 deadline)")
RWA_TH=$(k "ReceiveWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)")
echo "PAYMENT_INTENT_TYPEHASH=$PI_TH"; echo "CLAIM_INTENT_TYPEHASH=$CI_TH"; echo "LINK_CLAIM_INTENT_TYPEHASH=$LCI_TH"
echo "CLAIM_APPROVAL_TYPEHASH=$CA_TH"; echo "CANCEL_INTENT_TYPEHASH=$XI_TH"; echo "AUSD_RWA_TYPEHASH=$RWA_TH"

AMOUNT=200000000; EXPIRES=1793232000; VALID_AFTER=0; VALID_BEFORE=1790726400; DEADLINE=1790812800
N1=0x00000000000000000000000000000000000000000000000000000000000000c1
N2=0x00000000000000000000000000000000000000000000000000000000000000c2
N3=0x00000000000000000000000000000000000000000000000000000000000000a1
echo "AMOUNT=$AMOUNT EXPIRES_AT=$EXPIRES VALID_AFTER=$VALID_AFTER VALID_BEFORE=$VALID_BEFORE DEADLINE=$DEADLINE"

pi(){ h 'f(bytes32,address,uint8,bytes32,bytes32,address,uint256,uint256,uint256,uint256,bytes32)' $PI_TH "$@"; }
rwa(){ h 'f(bytes32,address,address,uint256,uint256,uint256,bytes32)' $RWA_TH "$@"; }

ENV_HASH=$(k "everpiece-test-ciphertext-envelope")
META_SALT=0x00000000000000000000000000000000000000000000000000000000000e7a11
META=$(h 'f(bytes32,bytes32,bytes32)' $T_META $ENV_HASH $META_SALT)
echo "V_META envelopeHash=$ENV_HASH"; echo "V_META metadataSalt=$META_SALT"; echo "V_META metadataCommitment=$META"

# ---------------- USERNAME ----------------
RSALT_U=0x000000000000000000000000000000000000000000000000000000000005a170
RC_U=$(h 'f(bytes32,uint8,address,bytes32)' $T_RECIP 1 $RECIP $RSALT_U)
echo "V_U1 recipientSalt=$RSALT_U"; echo "V_U1 recipientCommitment=$RC_U"
SALT_U=0x000000000000000000000000000000000000000000000000000000000000a11c
PI_U_ENC=$(enc 'f(bytes32,address,uint8,bytes32,bytes32,address,uint256,uint256,uint256,uint256,bytes32)' $PI_TH $SENDER 1 $RC_U $META $ZERO $AMOUNT $EXPIRES $VALID_AFTER $VALID_BEFORE $SALT_U)
PI_U=$(cast keccak $PI_U_ENC); PID_U=$(digest $DS $PI_U)
echo "V_U2 salt=$SALT_U"; echo "V_U2 encoded=$PI_U_ENC"; echo "V_U2 structHash=$PI_U"; echo "V_U2 paymentId=$PID_U"
RWA_U_D=$(digest $AUSD_DS $(rwa $SENDER $ESCROW $AMOUNT $VALID_AFTER $VALID_BEFORE $PID_U))
SIG_U3=$(sign $PK_SENDER $RWA_U_D)
echo "V_U3 ausdDigest=$RWA_U_D"; echo "V_U3 senderSig=$SIG_U3"; echo "V_U3 verifiesAsSender=$(verify $SENDER $RWA_U_D $SIG_U3)"
CI_D=$(digest $DS $(h 'f(bytes32,bytes32,address,bytes32,uint256)' $CI_TH $PID_U $RECIP $N1 $DEADLINE)); SIG=$(sign $PK_RECIP $CI_D)
echo "V_U4 claimIntentDigest=$CI_D"; echo "V_U4 recipientSig=$SIG"; echo "V_U4 verifiesAsRecipient=$(verify $RECIP $CI_D $SIG)"; echo "V_U4 verifiesAsSender=$(verify $SENDER $CI_D $SIG)"
SCI_D=$(digest $DS $(h 'f(bytes32,bytes32,address,bytes32,uint256)' $CI_TH $PID_U $SENDER $N1 $DEADLINE)); SIG=$(sign $PK_SENDER $SCI_D)
echo "V_U5 senderSignedClaimForSelf digest=$SCI_D"; echo "V_U5 senderSig=$SIG"; echo "V_U5 senderOpensCommitment=$( [ "$(h 'f(bytes32,uint8,address,bytes32)' $T_RECIP 1 $SENDER $RSALT_U)" = "$RC_U" ] && echo true || echo false)"
XI_D=$(digest $DS $(h 'f(bytes32,bytes32,address,bytes32,uint256)' $XI_TH $PID_U $SENDER $N2 $DEADLINE)); SIG=$(sign $PK_SENDER $XI_D)
echo "V_U6 cancelIntentDigest=$XI_D"; echo "V_U6 senderSig=$SIG"; echo "V_U6 verifiesAsSender=$(verify $SENDER $XI_D $SIG)"
# negatives (each changes one field; V_U3 signature must NOT verify for the resulting AUSD digest)
neg(){ local name=$1; shift; local pid=$(digest $DS $(pi "$@")); local amt=$4; local va=$7; local vb=$8
  local d=$(digest $AUSD_DS $(rwa $1 $ESCROW $6 $8 $9 $pid)); echo "$name paymentId=$pid ausdDigest=$d v_u3SigVerifies=$(verify $SENDER $d $SIG_U3)"; }
neg V_N1_amount+1       $SENDER 1 $RC_U $META $ZERO 200000001 $EXPIRES $VALID_AFTER $VALID_BEFORE $SALT_U
neg V_N2_expiresAt+1    $SENDER 1 $RC_U $META $ZERO $AMOUNT 1793232001 $VALID_AFTER $VALID_BEFORE $SALT_U
RC_EVE=$(h 'f(bytes32,uint8,address,bytes32)' $T_RECIP 1 0x000000000000000000000000000000000000E7E0 $RSALT_U)
neg V_N3_recipientSwap  $SENDER 1 $RC_EVE $META $ZERO $AMOUNT $EXPIRES $VALID_AFTER $VALID_BEFORE $SALT_U
neg V_N4_metadataZero   $SENDER 1 $RC_U 0x0000000000000000000000000000000000000000000000000000000000000000 $ZERO $AMOUNT $EXPIRES $VALID_AFTER $VALID_BEFORE $SALT_U
neg V_N5_modeLink       $SENDER 2 $RC_U $META $ZERO $AMOUNT $EXPIRES $VALID_AFTER $VALID_BEFORE $SALT_U
neg V_N6_salt+1         $SENDER 1 $RC_U $META $ZERO $AMOUNT $EXPIRES $VALID_AFTER $VALID_BEFORE 0x000000000000000000000000000000000000000000000000000000000000a11d
neg V_N7_approverSet    $SENDER 1 $RC_U $META $APPROVER $AMOUNT $EXPIRES $VALID_AFTER $VALID_BEFORE $SALT_U
DS_C=$(h 'f(bytes32,bytes32,bytes32,uint256,address)' $DTH $(k "Everpiece Escrow") $(k "1") 10143 $ESCROW)
DS_E=$(h 'f(bytes32,bytes32,bytes32,uint256,address)' $DTH $(k "Everpiece Escrow") $(k "1") $CHAIN 0x2222222222222222222222222222222222222222)
DS_V=$(h 'f(bytes32,bytes32,bytes32,uint256,address)' $DTH $(k "Everpiece Escrow") $(k "2") $CHAIN $ESCROW)
echo "V_N8_chain10143 paymentId=$(digest $DS_C $PI_U)"; echo "V_N9_otherEscrow paymentId=$(digest $DS_E $PI_U)"; echo "V_N10_domainVersion2 paymentId=$(digest $DS_V $PI_U)"
# the AUSD auth for V_U2 but with validBefore changed only in the AUSD call (intent unchanged) -> sig invalid
D_VB=$(digest $AUSD_DS $(rwa $SENDER $ESCROW $AMOUNT $VALID_AFTER 1790726401 $PID_U)); echo "V_N11_ausdValidBeforeOnly v_u3SigVerifies=$(verify $SENDER $D_VB $SIG_U3)"

# ---------------- LINK ----------------
RSALT_L=0x0000000000000000000000000000000000000000000000000000000000011c0e
RC_L=$(h 'f(bytes32,uint8,address,bytes32)' $T_RECIP 2 $CLAIMKEY $RSALT_L)
echo "V_L1 claimKeyPrivate(fixture)=$PK_CLAIMKEY claimKey=$CLAIMKEY recipientSalt=$RSALT_L"; echo "V_L1 recipientCommitment=$RC_L"
SALT_L=0x000000000000000000000000000000000000000000000000000000000000b0b0
PI_L=$(pi $SENDER 2 $RC_L $META $APPROVER $AMOUNT $EXPIRES $VALID_AFTER $VALID_BEFORE $SALT_L); PID_L=$(digest $DS $PI_L)
echo "V_L2 structHash=$PI_L"; echo "V_L2 paymentId=$PID_L"
RWA_L_D=$(digest $AUSD_DS $(rwa $SENDER $ESCROW $AMOUNT $VALID_AFTER $VALID_BEFORE $PID_L))
echo "V_L3 ausdDigest=$RWA_L_D"; echo "V_L3 senderSig=$(sign $PK_SENDER $RWA_L_D)"
LCI_D=$(digest $DS $(h 'f(bytes32,bytes32,address,bytes32,uint256)' $LCI_TH $PID_L $RECIP $N1 $DEADLINE)); S1=$(sign $PK_CLAIMKEY $LCI_D)
CA_D=$(digest $DS $(h 'f(bytes32,bytes32,address,bytes32,uint256)' $CA_TH $PID_L $RECIP $N3 $DEADLINE)); S2=$(sign $PK_APPROVER $CA_D)
echo "V_L4 linkClaimDigest(recipient=Mama)=$LCI_D"; echo "V_L4 claimKeySig=$S1"; echo "V_L4 verifiesAsClaimKey=$(verify $CLAIMKEY $LCI_D $S1)"
echo "V_L5 claimApprovalDigest(recipient=Mama)=$CA_D"; echo "V_L5 approverSig=$S2"; echo "V_L5 verifiesAsApprover=$(verify $APPROVER $CA_D $S2)"
echo "V_L6 roleSeparation approverSigOnLinkDigest=$(verify $APPROVER $LCI_D $S2) claimKeySigOnApprovalDigest=$(verify $CLAIMKEY $CA_D $S1)"
CA_S=$(digest $DS $(h 'f(bytes32,bytes32,address,bytes32,uint256)' $CA_TH $PID_L $STELLA $N3 $DEADLINE))
echo "V_L7 redirect: approvalForMama checked as approval for Stella($STELLA) digest=$CA_S verifies=$(verify $APPROVER $CA_S $S2)"
echo "V_L8 approverRotation: approver2 signing same approval digest -> expected signer is snapshot $APPROVER; approver2=$APPROVER2 sig=$(sign $PK_APPROVER2 $CA_D) verifiesAsSnapshotApprover=$(verify $APPROVER $CA_D $(sign $PK_APPROVER2 $CA_D))"
