// Claims/approver server end to end on an anvil `--network monad` fork of mainnet with REAL AUSD and a freshly
// deployed EverpieceEscrow. SMS is the SIMULATED provider (codes captured by the test). RUN_FORK_TESTS=true.
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import {
  createPublicClient, createTestClient, createWalletClient, defineChain, encodeAbiParameters, http, keccak256,
  parseEther, recoverTypedDataAddress, toHex, type Address, type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  AUSD_ADDRESS, PaymentMode, cancelIntent, claimApproval, claimStart, emailHash, emailInviteRegistration, everpieceEscrowAbi,
  fundingAuthorization, inviteRegistration, linkClaimIntent, paymentIdOf, phoneHash, recipientCommitment, type PaymentIntent,
} from "@everpiece/shared";
import { ClaimsService, ClaimsStore, SimulatedEmailProvider, SimulatedProvider, createClaimsServer, setLogSink, type ClaimsConfig } from "../src/index.ts";

const RUN = process.env.RUN_FORK_TESTS === "true";
const CORE_SLOT = "0x455730fed596673e69db1907be2e521374ba893f1a04cc5f5dd931616cd6b700";
const k = (n: number) => privateKeyToAccount(toHex(n, { size: 32 }));
const K = { deployer: k(0xd1), owner: k(0xd2), approver: k(0xa1), sender: k(0x51), recipient: k(0x52), claimKey: k(0x53), stranger: k(0x54), submitter: k(0x55) };
const PHONE = "+2348000000000";

describe("claims server on a Monad mainnet fork (real AUSD, simulated SMS)", { skip: !RUN }, () => {
  let anvil: ChildProcess, rpc: string, escrow: Address, server: Server, base: string, svc: ClaimsService;
  let pub: ReturnType<typeof createPublicClient>, testc: ReturnType<typeof createTestClient>, wallet: ReturnType<typeof createWalletClient>;
  const codes: { phone: string; code: string }[] = [];
  const logs: string[] = [];
  let clock = Date.now();
  const advance = (sec: number) => (clock += sec * 1000);
  const nowSec = () => BigInt(Math.floor(clock / 1000));

  const cfgFor = (over: Partial<ClaimsConfig> = {}): ClaimsConfig => ({
    rpcUrl: rpc, expectedChainId: 143, escrow, approverPrivateKey: toHex(0xa1, { size: 32 }), phoneEncKey: toHex(0x77, { size: 32 }),
    port: 0, host: "127.0.0.1", dbPath: ":memory:", smsProvider: "simulated", approvalTtlSec: 300, requestDeadlineMaxSec: 600,
    resendCooldownsSec: [30, 60, 120, 300, 600], sessionTtlSec: 600, maxVerifyAttempts: 5, perPhonePerDay: 10, perIpPerMinute: 1000,
    allowRetiredApprover: false, maxBodyBytes: 4096, ...over,
  });

  before(async () => {
    const port = 19500 + Math.floor(Math.random() * 400);
    rpc = `http://127.0.0.1:${port}`;
    anvil = spawn(process.env.ANVIL_BIN ?? "anvil", ["--network", "monad", "--fork-url", process.env.MONAD_RPC ?? "https://rpc.monad.xyz", "--port", String(port), "--silent"], { stdio: "ignore" });
    for (let i = 0; i < 120; i++) {
      try {
        if ((await fetch(rpc, { method: "POST", headers: { "content-type": "application/json" }, body: '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}' })).ok) break;
      } catch {}
      await new Promise((r) => setTimeout(r, 250));
    }
    const chain = defineChain({ id: 143, name: "fork", nativeCurrency: { name: "MON", symbol: "MON", decimals: 18 }, rpcUrls: { default: { http: [rpc] } } });
    pub = createPublicClient({ chain, transport: http(rpc) });
    testc = createTestClient({ chain, mode: "anvil", transport: http(rpc) });
    for (const a of [K.deployer, K.submitter]) await testc.setBalance({ address: a.address, value: parseEther("100") });
    const slot = keccak256(encodeAbiParameters([{ type: "address" }, { type: "bytes32" }], [K.sender.address, CORE_SLOT]));
    await testc.setStorageAt({ address: AUSD_ADDRESS, index: slot, value: toHex(1_000_000_000n << 8n, { size: 32 }) });
    const art = JSON.parse(readFileSync(new URL("../../../contracts/out/EverpieceEscrow.sol/EverpieceEscrow.json", import.meta.url), "utf8"));
    const dep = createWalletClient({ chain, transport: http(rpc), account: K.deployer });
    const h = await dep.deployContract({ abi: everpieceEscrowAbi, bytecode: art.bytecode.object as Hex, args: [AUSD_ADDRESS, K.owner.address, K.approver.address] });
    escrow = (await pub.waitForTransactionReceipt({ hash: h })).contractAddress!;
    wallet = createWalletClient({ chain, transport: http(rpc), account: K.submitter });

    setLogSink((l) => logs.push(l), "debug");
    svc = new ClaimsService(cfgFor(), new SimulatedProvider((phone, code) => codes.push({ phone, code }), () => clock), { now: () => clock });
    await svc.start();
    server = createClaimsServer(svc);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  after(() => {
    server?.close();
    anvil?.kill();
  });

  const post = async (path: string, body: unknown) => {
    const r = await fetch(base + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body, (_k, v) => (typeof v === "bigint" ? v.toString() : v)) });
    return { status: r.status, body: (await r.json()) as Record<string, any> };
  };
  let n = 0;
  const rnd = (t: string) => keccak256(toHex(`${t}:${++n}`));

  /** Create a payment on-chain directly (anyone can submit the sender's funding authorization). */
  async function createPayment(mode: 1 | 2 = PaymentMode.LINK) {
    const t = (await pub.getBlock()).timestamp;
    const recipientSalt = rnd("s");
    const intent: PaymentIntent = {
      sender: K.sender.address, mode,
      recipientCommitment: mode === PaymentMode.LINK ? recipientCommitment(2, K.claimKey.address, recipientSalt) : recipientCommitment(1, K.recipient.address, recipientSalt),
      metadataCommitment: rnd("m"), approver: mode === PaymentMode.LINK ? K.approver.address : "0x0000000000000000000000000000000000000000",
      amount: 20_000_000n, expiresAt: t + 2n * 86_400n, validAfter: 0n, validBefore: t + 3600n, salt: rnd("salt"),
    };
    const sig = await K.sender.signTypedData(fundingAuthorization(escrow, intent));
    await pub.waitForTransactionReceipt({ hash: await wallet.writeContract({ address: escrow, abi: everpieceEscrowAbi, functionName: "createPayment", args: [intent, sig], chain: null, account: K.submitter }) });
    return { paymentId: paymentIdOf(escrow, intent), recipientSalt };
  }
  const invite = async (paymentId: Hex, phone = PHONE, signer = K.sender) => {
    const deadline = nowSec() + 300n;
    const senderSig = await signer.signTypedData(inviteRegistration(escrow, { paymentId, phoneHash: phoneHash(phone), deadline }));
    return post("/v1/invites", { paymentId, phone, deadline, senderSig });
  };
  const start = async (paymentId: Hex, recipientSalt: Hex, recipient: Address = K.recipient.address, signer = K.claimKey, claimKey: Address = K.claimKey.address) => {
    const deadline = nowSec() + 300n;
    const claimKeySig = await signer.signTypedData(claimStart(escrow, { paymentId, recipient, deadline }));
    return post("/v1/claims/start", { paymentId, recipient, claimKey, recipientSalt, deadline, claimKeySig });
  };
  const verify = (paymentId: Hex, code: string, recipient: Address = K.recipient.address) => post("/v1/claims/verify", { paymentId, recipient, code });

  test("full two-factor flow: invite → code → approval → on-chain claimLinkPayment pays the recipient in real AUSD", async () => {
    const { paymentId, recipientSalt } = await createPayment();
    const inv = await invite(paymentId);
    assert.equal(inv.status, 201, JSON.stringify(inv.body));
    assert.equal(inv.body.maskedPhone, "+234 ••• ••• 0000");

    const s = await start(paymentId, recipientSalt);
    assert.equal(s.status, 200, JSON.stringify(s.body));
    assert.equal(s.body.simulated, true); // never presented as a live SMS provider
    const code = codes.at(-1)!;
    assert.equal(code.phone, PHONE);

    const v = await verify(paymentId, code.code);
    assert.equal(v.status, 200, JSON.stringify(v.body));
    const approval = { paymentId, recipient: K.recipient.address, approvalNonce: v.body.approvalNonce as Hex, deadline: BigInt(v.body.approvalDeadline) };
    assert.equal(await recoverTypedDataAddress({ ...claimApproval(escrow, approval), signature: v.body.approverSig }), K.approver.address);
    assert.ok(approval.deadline <= nowSec() + 300n);

    // Capability A (link key) + Capability B (this approval) → the contract pays the verified wallet.
    const actionNonce = rnd("a");
    const deadline = (await pub.getBlock()).timestamp + 600n;
    const claimKeySig = await K.claimKey.signTypedData(linkClaimIntent(escrow, { paymentId, recipient: K.recipient.address, actionNonce, deadline }));
    const before = await balance(K.recipient.address);
    const hash = await wallet.writeContract({
      address: escrow, abi: everpieceEscrowAbi, functionName: "claimLinkPayment", chain: null, account: K.submitter,
      args: [paymentId, K.recipient.address, K.claimKey.address, recipientSalt, actionNonce, deadline, claimKeySig, approval.approvalNonce, approval.deadline, v.body.approverSig],
    });
    assert.equal((await pub.waitForTransactionReceipt({ hash })).status, "success");
    assert.equal((await balance(K.recipient.address)) - before, 20_000_000n);
  });

  test("invite: sender-only, immutable, link-only, E.164, bounded deadline", async () => {
    const { paymentId } = await createPayment();
    assert.equal((await invite(paymentId, PHONE, K.stranger)).body.error, "InvalidSenderSignature");
    assert.equal((await invite(paymentId)).status, 201);
    const again = await invite(paymentId);
    assert.equal(again.status, 200);
    assert.equal(again.body.idempotent, true);
    assert.equal((await invite(paymentId, "+447700900123")).body.error, "InviteAlreadyRegistered");
    const d0 = nowSec() + 300n;
    const s0 = await K.sender.signTypedData(inviteRegistration(escrow, { paymentId, phoneHash: phoneHash(PHONE), deadline: d0 }));
    assert.equal((await post("/v1/invites", { paymentId, phone: "08000000000", deadline: d0, senderSig: s0 })).status, 400); // not E.164
    const u = await createPayment(PaymentMode.USERNAME);
    assert.equal((await invite(u.paymentId)).body.error, "NotALinkPayment");
    const far = nowSec() + 10_000n;
    const sig = await K.sender.signTypedData(inviteRegistration(escrow, { paymentId, phoneHash: phoneHash(PHONE), deadline: far }));
    assert.equal((await post("/v1/invites", { paymentId, phone: PHONE, deadline: far, senderSig: sig })).body.error, "BadDeadline");
  });

  test("start requires the link: wrong salt / foreign key / forged sig refused; no SMS sent", async () => {
    const { paymentId, recipientSalt } = await createPayment();
    await invite(paymentId);
    const sent = codes.length;
    assert.equal((await start(paymentId, rnd("wrong"))).body.error, "LinkRevealMismatch");
    assert.equal((await start(paymentId, recipientSalt, K.recipient.address, K.stranger, K.stranger.address)).body.error, "LinkRevealMismatch");
    assert.equal((await start(paymentId, recipientSalt, K.recipient.address, K.stranger)).body.error, "InvalidClaimKeySignature");
    assert.equal(codes.length, sent); // no SMS for anyone without the link
    const other = await createPayment();
    assert.equal((await start(other.paymentId, other.recipientSalt)).body.error, "InviteNotRegistered");
  });

  test("resend cooldown is progressive and never permanent", async () => {
    const { paymentId, recipientSalt } = await createPayment();
    await invite(paymentId);
    assert.equal((await start(paymentId, recipientSalt)).status, 200);
    const c1 = await start(paymentId, recipientSalt);
    assert.equal(c1.status, 429);
    assert.equal(c1.body.error, "Cooldown");
    assert.ok(c1.body.retryAfterSeconds > 0 && c1.body.retryAfterSeconds <= 30);
    advance(31);
    assert.equal((await start(paymentId, recipientSalt)).status, 200); // 2nd send
    advance(31);
    assert.equal((await start(paymentId, recipientSalt)).status, 429); // now 60s
    advance(30);
    assert.equal((await start(paymentId, recipientSalt)).status, 200); // 3rd send after 61s
  });

  test("wrong codes are throttled, never lock the payment; approval bound to the starting wallet", async () => {
    const { paymentId, recipientSalt } = await createPayment();
    await invite(paymentId);
    await start(paymentId, recipientSalt);
    const good = codes.at(-1)!.code;
    const bad = good === "000000" ? "111111" : "000000";
    assert.equal((await verify(paymentId, good, K.stranger.address)).body.error, "RecipientMismatch"); // cannot redirect
    for (let i = 4; i >= 0; i--) {
      const r = await verify(paymentId, bad);
      assert.equal(r.body.error, "InvalidCode");
      assert.equal(r.body.attemptsLeft, i);
    }
    assert.equal((await verify(paymentId, good)).body.error, "TooManyAttempts");
    assert.equal((await verify(paymentId, good)).body.error, "NoActiveVerification");
    advance(31); // cooldown, then a fresh code works — no permanent lockout (master §13.1)
    assert.equal((await start(paymentId, recipientSalt)).status, 200);
    const v = await verify(paymentId, codes.at(-1)!.code);
    assert.equal(v.status, 200, JSON.stringify(v.body));
  });

  test("session expiry and cancelled payments", async () => {
    const a = await createPayment();
    await invite(a.paymentId);
    await start(a.paymentId, a.recipientSalt);
    const code = codes.at(-1)!.code;
    advance(601);
    assert.equal((await verify(a.paymentId, code)).body.error, "VerificationExpired");

    const b = await createPayment();
    await invite(b.paymentId);
    const deadline = (await pub.getBlock()).timestamp + 600n;
    const actionNonce = rnd("c");
    const senderSig = await K.sender.signTypedData(cancelIntent(escrow, { paymentId: b.paymentId, sender: K.sender.address, actionNonce, deadline }));
    await pub.waitForTransactionReceipt({ hash: await wallet.writeContract({ address: escrow, abi: everpieceEscrowAbi, functionName: "cancel", args: [b.paymentId, actionNonce, deadline, senderSig], chain: null, account: K.submitter }) });
    assert.equal((await start(b.paymentId, b.recipientSalt)).body.error, "PaymentNotActive");
  });

  test("per-phone daily cap (SMS pumping)", async () => {
    const s2 = new ClaimsService(cfgFor({ perPhonePerDay: 1, resendCooldownsSec: [0] }), new SimulatedProvider(() => {}, () => clock), { now: () => clock });
    const p1 = await createPayment();
    const p2 = await createPayment();
    for (const p of [p1, p2]) {
      const deadline = nowSec() + 300n;
      const senderSig = await K.sender.signTypedData(inviteRegistration(escrow, { paymentId: p.paymentId, phoneHash: phoneHash("+447700900999"), deadline }));
      await s2.registerInvite({ paymentId: p.paymentId, phone: "+447700900999", deadline: deadline.toString(), senderSig }, "ip");
    }
    const startBody = async (p: { paymentId: Hex; recipientSalt: Hex }) => {
      const deadline = nowSec() + 300n;
      return { paymentId: p.paymentId, recipient: K.recipient.address, claimKey: K.claimKey.address, recipientSalt: p.recipientSalt, deadline: deadline.toString(), claimKeySig: await K.claimKey.signTypedData(claimStart(escrow, { paymentId: p.paymentId, recipient: K.recipient.address, deadline })) };
    };
    assert.equal((await s2.startVerification(await startBody(p1), "ip")).httpStatus, 200);
    const r = await s2.startVerification(await startBody(p2), "ip");
    assert.equal(r.httpStatus, 429);
    assert.equal(r.body.error, "PhoneDailyLimit");
  });

  test("email channel: signed email invite → emailed code → approval → on-chain claim; channels never mix", async () => {
    const EMAIL = "mama.ngozi@example.com";
    const emails: { email: string; code: string }[] = [];
    const esvc = new ClaimsService(cfgFor(), new SimulatedProvider((phone, code) => codes.push({ phone, code }), () => clock), {
      now: () => clock,
      emailProvider: new SimulatedEmailProvider((email, code) => emails.push({ email, code }), () => clock),
    });
    const { paymentId, recipientSalt } = await createPayment();
    const deadline = nowSec() + 300n;
    const emailSig = await K.sender.signTypedData(emailInviteRegistration(escrow, { paymentId, emailHash: emailHash(EMAIL), deadline }));
    const body = { paymentId, email: EMAIL, deadline: deadline.toString(), senderSig: emailSig };

    // a PHONE-typed signature over the same 32 bytes can't register an email invite (separate EIP-712 types)
    const phoneTyped = await K.sender.signTypedData(inviteRegistration(escrow, { paymentId, phoneHash: emailHash(EMAIL), deadline }));
    assert.equal((await esvc.registerInvite({ ...body, senderSig: phoneTyped }, "ip")).body.error, "InvalidSenderSignature");
    assert.equal((await esvc.registerInvite({ ...body, email: "Mama.Ngozi@Example.com" }, "ip")).httpStatus, 400); // must be normalized
    assert.equal((await esvc.registerInvite({ ...body, senderSig: await K.stranger.signTypedData(emailInviteRegistration(escrow, { paymentId, emailHash: emailHash(EMAIL), deadline })) }, "ip")).body.error, "InvalidSenderSignature");
    // the default service has no email provider: refused before anything is stored
    assert.equal((await svc.registerInvite(body, "ip")).body.error, "EmailUnavailable");

    const inv = await esvc.registerInvite(body, "ip");
    assert.equal(inv.httpStatus, 201, JSON.stringify(inv.body));
    assert.deepEqual([inv.body.channel, inv.body.maskedContact, inv.body.maskedPhone], ["email", "m•••@example.com", undefined]);
    assert.equal((await esvc.registerInvite(body, "ip")).body.idempotent, true);
    // immutable: can't be switched to a phone afterwards
    const phoneSig = await K.sender.signTypedData(inviteRegistration(escrow, { paymentId, phoneHash: phoneHash(PHONE), deadline }));
    assert.equal((await esvc.registerInvite({ paymentId, phone: PHONE, deadline: deadline.toString(), senderSig: phoneSig }, "ip")).body.error, "InviteAlreadyRegistered");

    const smsBefore = codes.length;
    const d2 = nowSec() + 300n;
    const claimKeySig = await K.claimKey.signTypedData(claimStart(escrow, { paymentId, recipient: K.recipient.address, deadline: d2 }));
    const s = await esvc.startVerification({ paymentId, recipient: K.recipient.address, claimKey: K.claimKey.address, recipientSalt, deadline: d2.toString(), claimKeySig }, "ip");
    assert.equal(s.httpStatus, 200, JSON.stringify(s.body));
    assert.deepEqual([s.body.channel, s.body.maskedContact, s.body.simulated], ["email", "m•••@example.com", true]);
    assert.equal(emails.at(-1)!.email, EMAIL);
    assert.equal(codes.length, smsBefore); // emailed, not texted

    const v = await esvc.verifyCode({ paymentId, recipient: K.recipient.address, code: emails.at(-1)!.code }, "ip");
    assert.equal(v.httpStatus, 200, JSON.stringify(v.body));
    const actionNonce = rnd("e");
    const cd = (await pub.getBlock()).timestamp + 600n;
    const linkSig = await K.claimKey.signTypedData(linkClaimIntent(escrow, { paymentId, recipient: K.recipient.address, actionNonce, deadline: cd }));
    const before = await balance(K.recipient.address);
    const hash = await wallet.writeContract({
      address: escrow, abi: everpieceEscrowAbi, functionName: "claimLinkPayment", chain: null, account: K.submitter,
      args: [paymentId, K.recipient.address, K.claimKey.address, recipientSalt, actionNonce, cd, linkSig, v.body.approvalNonce as Hex, BigInt(v.body.approvalDeadline as string), v.body.approverSig as Hex],
    });
    assert.equal((await pub.waitForTransactionReceipt({ hash })).status, "success");
    assert.equal((await balance(K.recipient.address)) - before, 20_000_000n);

    // privacy: the address is never stored in plaintext
    for (const row of esvc.store.db.prepare("SELECT * FROM invites").all() as Record<string, string>[]) assert.ok(!JSON.stringify(row).includes("ngozi"));
  });

  test("startup refuses: wrong chain, key that is not the escrow approver, approver == owner", async () => {
    const sim = new SimulatedProvider(() => {});
    await assert.rejects(new ClaimsService(cfgFor({ expectedChainId: 1 }), sim).start(), /chainId/);
    await assert.rejects(new ClaimsService(cfgFor({ approverPrivateKey: toHex(0xbb, { size: 32 }) }), sim).start(), /not escrow.claimApprover/);
    await assert.rejects(new ClaimsService(cfgFor({ approverPrivateKey: toHex(0xd2, { size: 32 }), allowRetiredApprover: true }), sim).start(), /owner/);
  });

  test("privacy: phone never stored in plaintext, never logged; codes never logged", () => {
    const db = svc.store.db.prepare("SELECT * FROM invites").all() as Record<string, string>[];
    assert.ok(db.length > 0);
    for (const row of db) assert.ok(!JSON.stringify(row).includes("8000000000"));
    assert.ok(logs.length > 0);
    for (const l of logs) {
      assert.ok(!l.includes("8000000000"), l);
      assert.ok(!l.toLowerCase().includes("ngozi"), l); // email addresses are never logged either
      for (const c of codes) assert.ok(!l.includes(`"${c.code}"`), l);
    }
    const sessions = svc.store.db.prepare("SELECT * FROM sessions").all();
    for (const c of codes) assert.ok(!JSON.stringify(sessions).includes(c.code)); // no OTP stored
    assert.ok(svc.store instanceof ClaimsStore);
  });

  async function balance(who: Address): Promise<bigint> {
    return pub.readContract({ address: AUSD_ADDRESS, abi: [{ type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] }], functionName: "balanceOf", args: [who] }) as Promise<bigint>;
  }
});
