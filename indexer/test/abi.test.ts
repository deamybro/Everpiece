// The event signatures in config.yaml must be exactly the contracts' events (shared ABI is generated from contracts/out).
import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { everpieceEarnAbi, everpieceEscrowAbi, everpiecePayAbi } from "../../packages/shared/src/abi.ts";

type Abi = readonly { type: string; name?: string; inputs?: readonly { type: string; name: string; indexed?: boolean }[] }[];
const sig = (abi: Abi, name: string) => {
  const e = abi.find((x) => x.type === "event" && x.name === name);
  if (!e || !e.inputs) throw new Error(`${name} missing from the shared ABI`);
  return `${name}(${e.inputs.map((i) => `${i.type}${i.indexed ? " indexed" : ""} ${i.name}`).join(", ")})`;
};

it("config.yaml indexes the escrow's payment events, EverpiecePay.Paid and EverpieceEarn's events with the contracts' exact signatures", () => {
  const config = readFileSync(new URL("../config.yaml", import.meta.url), "utf8");
  const configured = [...config.matchAll(/^\s*- event: (.+)$/gm)].map((m) => m[1].trim());
  const fromAbi = [
    ...["PaymentCreated", "PaymentClaimed", "PaymentCancelled", "PaymentRefunded"].map((n) => sig(everpieceEscrowAbi, n)),
    sig(everpiecePayAbi, "Paid"),
    sig(everpieceEarnAbi, "EarnDeposited"),
    sig(everpieceEarnAbi, "EarnWithdrawn"),
  ];
  expect(configured).toEqual(fromAbi);
});
