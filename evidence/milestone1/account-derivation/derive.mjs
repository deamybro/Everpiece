import { entropyToMnemonic, mnemonicToSeedSync } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english.js";
import { HDKey } from "@scure/bip32";
import { sha256 } from "@noble/hashes/sha2.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { bytesToHex, hexToBytes, utf8ToBytes } from "@noble/hashes/utils.js";
import { secp256k1 } from "@noble/curves/secp256k1.js";
const fixtures = {
  D1_zero: new Uint8Array(32),
  D2_sha256_label: sha256(utf8ToBytes("everpiece.test.prf-fixture.v1")),
};
for (const [name, prf] of Object.entries(fixtures)) {
  const mnemonic = entropyToMnemonic(prf, wordlist);
  const seed = mnemonicToSeedSync(mnemonic);
  const node = HDKey.fromMasterSeed(seed).derive("m/44'/60'/0'/0/0");
  const pub = secp256k1.getPublicKey(node.privateKey, false);
  const addr = "0x" + bytesToHex(keccak_256(pub.slice(1))).slice(-40);
  console.log(JSON.stringify({ name, prfOutput: "0x"+bytesToHex(prf), mnemonic, seed: "0x"+bytesToHex(seed), path: "m/44'/60'/0'/0/0", privateKey: "0x"+bytesToHex(node.privateKey), address: addr }));
}
