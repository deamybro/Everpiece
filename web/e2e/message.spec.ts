// Encrypted link message (master §24, demo part 1): Stella records a voice note (Chromium's fake microphone) and
// writes a note, sends by link; Mama opens the link and the message decrypts and verifies against the payment's
// on-chain commitment. With the message store down, the payment still opens and can be claimed (§24.8).
// Works on the public testnet site: nothing here needs an SMS code. Stella cancels at the end to get her money back.
import { expect, test, type BrowserContext, type Page } from "@playwright/test";

test.use({ launchOptions: { args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"] } });

const BASE = process.env.E2E_BASE_URL ?? "http://localhost:3000";
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

async function withPasskeys(context: BrowserContext): Promise<Page> {
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: {
      protocol: "ctap2", ctap2Version: "ctap2_1", transport: "internal", hasResidentKey: true,
      hasUserVerification: true, isUserVerified: true, hasPrf: true, automaticPresenceSimulation: true,
    },
  });
  return page;
}

test.afterEach(async ({ browser }) => {
  for (const c of browser.contexts()) await c.close();
});

test("voice + note: encrypted on the sender's device, opened and verified by the recipient; store outage doesn't block money", async ({ browser }) => {
  const ctx = await browser.newContext({ permissions: ["microphone"] });
  const stella = await withPasskeys(ctx);
  await stella.goto("/");
  await stella.getByLabel("Your first name").fill("Stella");
  await stella.getByRole("button", { name: "Create my account with fingerprint or screen lock" }).click();
  await expect(stella.getByText("Hi Stella, your Dollars")).toBeVisible();
  await stella.getByRole("button", { name: "Get 100 test Dollars" }).click();
  await expect(stella.locator(".balance")).toHaveText("$100.00");

  // compose: note + a ~2 s voice note
  await stella.getByRole("link", { name: "Send money" }).click();
  await stella.getByLabel("Amount in Dollars").fill("3");
  await stella.getByRole("button", { name: "Continue" }).click();
  await stella.getByLabel("Their phone number (with country code)").fill("+447700900456");
  await stella.getByRole("button", { name: "Continue" }).click();
  await stella.getByLabel("Written note").fill("For October ❤️");
  await stella.getByRole("button", { name: /Record a voice note/ }).click();
  await expect(stella.getByText(/Recording… 0:0[2-9]/)).toBeVisible({ timeout: 10_000 });
  await stella.getByRole("button", { name: "Stop recording" }).click();
  await expect(stella.getByLabel("Your voice note")).toBeVisible();
  await expect(stella.locator(".review")).toContainText("Voice note 0:0");
  await expect(stella.locator(".review")).toContainText("Written note");

  // the store must receive ciphertext only: capture the upload and check it isn't the plaintext note
  const upload = stella.waitForRequest((r) => r.method() === "PUT" && /\/v1\/messages\/0x[0-9a-f]{64}$/.test(r.url()));
  await stella.getByRole("button", { name: "Confirm with fingerprint or screen lock" }).click();
  const body = (await upload).postDataBuffer()!;
  expect(body[0]).toBe(1); // envelope v1
  expect(body.includes(Buffer.from("For October"))).toBe(false);
  await expect(stella.getByText("Payment protected ✓")).toBeVisible({ timeout: 60_000 });
  const wa = await stella.getByRole("link", { name: "Send on WhatsApp" }).getAttribute("href");
  const shared = decodeURIComponent(wa!.split("?text=")[1]);
  expect(shared).toContain("and a message");
  const link = new RegExp(`(${escapeRe(BASE)}/c/0x[0-9a-f]{64}#[A-Za-z0-9_-]+)`).exec(shared)![1];

  // Mama opens the link (no account needed to hear it): note shown, voice decrypts to playable audio
  const mama = await (await browser.newContext()).newPage();
  await mama.goto(link);
  const card = mama.getByLabel("Message from the sender");
  await expect(card.getByText("For October ❤️")).toBeVisible();
  const audio = card.getByLabel("Voice message");
  await expect(audio).toBeVisible();
  expect(await audio.getAttribute("src")).toMatch(/^blob:/);
  await expect.poll(() => audio.evaluate((a: HTMLAudioElement) => a.readyState), { timeout: 10_000 }).toBeGreaterThan(0);
  expect(await audio.evaluate((a: HTMLAudioElement) => a.error)).toBeNull();

  // message store down: the payment still opens and the claim can start
  const offline = await (await browser.newContext()).newPage();
  await offline.route(/\/v1\/messages\//, (r) => r.abort());
  await offline.goto(link);
  await expect(offline.getByText("The message can't be loaded right now. You can still claim your money.")).toBeVisible();
  await expect(offline.getByText("Someone sent you")).toBeVisible();

  // a swapped message (valid format, wrong content) is refused, not shown
  const swapped = await (await browser.newContext()).newPage();
  await swapped.route(/\/v1\/messages\//, async (r) => {
    const real = await r.fetch();
    const bytes = Buffer.from(await real.body());
    bytes[bytes.length - 1] ^= 1;
    await r.fulfill({ status: 200, contentType: "application/octet-stream", body: bytes });
  });
  await swapped.goto(link);
  await expect(swapped.getByText("This message couldn't be verified, so it isn't shown. Your money is not affected.")).toBeVisible();
  await expect(swapped.getByText("For October ❤️")).toHaveCount(0);

  // clean up: Stella cancels and gets her $3 back
  await stella.getByRole("link", { name: "Done" }).click();
  const row = stella.getByRole("list", { name: "Activity" }).locator("li", { hasText: "$3.00" });
  await row.getByRole("button", { name: "Cancel and get my money back" }).click();
  await expect(stella.getByText("Money returned: $3.00.")).toBeVisible({ timeout: 60_000 });
  await expect(stella.locator(".balance")).toHaveText("$100.00");
});

async function onboard(page: Page, first: string, username: string) {
  await page.goto("/");
  await page.getByLabel("Your first name").fill(first);
  await page.getByRole("button", { name: "Create my account with fingerprint or screen lock" }).click();
  await expect(page.getByText(`Hi ${first}, your Dollars`)).toBeVisible();
  await page.getByLabel("Username", { exact: true }).fill(username);
  await expect(page.getByText(`@${username} is available ✓`)).toBeVisible();
  await page.getByRole("button", { name: `Save @${username} with fingerprint or screen lock` }).click();
  await expect(page.getByText(`Your username: @${username}`)).toBeVisible();
}

test("@username: the message is sealed to the recipient's own key; she hears it on Home, then claims", async ({ browser }) => {
  const stella = await withPasskeys(await browser.newContext({ permissions: ["microphone"] }));
  const mama = await withPasskeys(await browser.newContext());
  const suffix = Date.now().toString(36).slice(-5);
  const S = `msg_s_${suffix}`, M = `msg_m_${suffix}`;
  await onboard(stella, "Stella", S);
  await stella.getByRole("button", { name: "Get 100 test Dollars" }).click();
  await expect(stella.locator(".balance")).toHaveText("$100.00");
  await onboard(mama, "Mama", M); // registering the username also publishes her signed message key
  await expect(mama.getByText("Get voice messages")).toHaveCount(0);

  await stella.getByRole("link", { name: "Send money" }).click();
  await stella.getByLabel("Amount in Dollars").fill("2");
  await stella.getByRole("button", { name: "Continue" }).click();
  await stella.getByRole("button", { name: "@username" }).click();
  await stella.getByLabel("Their Everpiece username").fill(M);
  await stella.getByRole("button", { name: "Find" }).click();
  await stella.getByLabel(/This is the person I mean/).check();
  await stella.getByRole("button", { name: "Continue" }).click();
  await expect(stella.getByText(`Only @${M}'s account can open it.`)).toBeVisible();
  await stella.getByLabel("Written note").fill("Happy birthday Mama");
  await stella.getByRole("button", { name: /Record a voice note/ }).click();
  await expect(stella.getByText(/Recording… 0:0[2-9]/)).toBeVisible({ timeout: 10_000 });
  await stella.getByRole("button", { name: "Stop recording" }).click();
  const deliver = stella.waitForRequest((r) => r.method() === "POST" && r.url().endsWith("/v1/inbox/deliver"));
  await stella.getByRole("button", { name: "Confirm with fingerprint or screen lock" }).click();
  const delivered = JSON.parse((await deliver).postData()!);
  expect(delivered.messageWrap).toMatch(/^0x[0-9a-f]{160}$/); // 80-byte HPKE wrap, opaque to the directory
  expect(JSON.stringify(delivered)).not.toContain("Happy birthday");
  await expect(stella.getByText(`Sent to @${M} ✓`)).toBeVisible({ timeout: 60_000 });

  await mama.reload();
  const card = mama.getByLabel("Message from the sender");
  await expect(card.getByText(`A message from @${S}`)).toBeVisible({ timeout: 30_000 });
  await expect(card.getByText("Happy birthday Mama")).toBeVisible();
  await expect(card.getByText("Only your account can open it.")).toBeVisible();
  const audio = card.getByLabel("Voice message");
  await expect.poll(() => audio.evaluate((a: HTMLAudioElement) => a.readyState), { timeout: 10_000 }).toBeGreaterThan(0);

  // the message never gets in the way of the money
  await mama.getByRole("button", { name: "Claim with fingerprint or screen lock" }).click();
  await expect(mama.getByText(`You received $2.00 from @${S} ✓`)).toBeVisible({ timeout: 60_000 });
});
