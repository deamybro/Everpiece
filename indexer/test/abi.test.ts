// The event signatures in config.yaml must be exactly the escrow's events (shared ABI is generated from contracts/out).
import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { everpieceEscrowAbi, everpiecePayAbi } from "../../packages/shared/src/abi.ts";

it("config.yaml indexes the escrow's four payment events and EverpiecePay.Paid with the contracts' exact signatures", () => {
  const config = readFileSync(new URL("../config.yaml", import.meta.url), "utf8");
  const configured = [...config.matchAll(/^\s*- event: (.+)$/gm)].map((m) => m[1].trim());
  const fromAbi = ["PaymentCreated", "PaymentClaimed", "PaymentCancelled", "PaymentRefunded"].map((name) => {
    const e = everpieceEscrowAbi.find((x) => x.type === "event" && x.name === name);
    if (!e || e.type !== "event") throw new Error(`${name} missing from the shared ABI`);
    return `${name}(${e.inputs.map((i) => `${i.type}${i.indexed ? " indexed" : ""} ${i.name}`).join(", ")})`;
  });
  const paid = everpiecePayAbi.find((x) => x.type === "event" && x.name === "Paid");
  if (!paid || paid.type !== "event") throw new Error("Paid missing from the shared ABI");
  fromAbi.push(`Paid(${paid.inputs.map((i) => `${i.type}${i.indexed ? " indexed" : ""} ${i.name}`).join(", ")})`);
  expect(configured).toEqual(fromAbi);
});
