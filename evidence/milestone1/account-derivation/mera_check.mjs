import { createSecp256k1SigningSession, getEvmAddress } from "@category-labs/mera";
import { readFileSync } from "node:fs";
for (const v of readFileSync("derive.out","utf8").trim().split("\n").map(JSON.parse)) {
  const hex = v.privateKey.slice(2); const pk = Uint8Array.from(hex.match(/../g).map(b=>parseInt(b,16)));
  const s = createSecp256k1SigningSession({ privateKey: pk });
  console.log(v.name, getEvmAddress(s.publicKey)); s.end();
}
