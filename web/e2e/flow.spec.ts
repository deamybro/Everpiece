// End-to-end on the LOCAL TEST STACK (fork of Monad mainnet, real AUSD code, simulated SMS):
// Stella creates a passkey account → gets test Dollars → sends by link → Mama opens the link in another browser,
// creates her own passkey account, gets the (simulated) text code, claims → Stella cancels a second payment.
// Passkeys use Chrome's virtual authenticator WITH the PRF extension, so Mera runs its real code path.
import { expect, test, type BrowserContext, type Page } from "@playwright/test";

// E2E_BASE_URL / E2E_FAUCET_URL: the test stack on a server through its SSH tunnel (deploy/test-stack/README.md).
const FAUCET = process.env.E2E_FAUCET_URL ?? "http://127.0.0.1:8790";
const BASE = process.env.E2E_BASE_URL ?? "http://localhost:3000";
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");

async function withPasskeys(context: BrowserContext): Promise<Page> {
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: {
      protocol: "ctap2",
      ctap2Version: "ctap2_1",
      transport: "internal",
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      hasPrf: true,
      automaticPresenceSimulation: true,
    },
  });
  return page;
}

async function latestSimulatedCode(page: Page): Promise<string> {
  const html = await (await page.request.get(`${FAUCET}/sms`)).text();
  const m = /<li><b>([0-9]{6})<\/b>/.exec(html);
  if (!m) throw new Error("no simulated SMS yet");
  return m[1];
}

test("send by link → recipient verifies phone → claims; sender cancels another payment", async ({ browser }) => {
  const stellaCtx = await browser.newContext();
  const mamaCtx = await browser.newContext();
  const stella = await withPasskeys(stellaCtx);
  const mama = await withPasskeys(mamaCtx);
  const csp: string[] = [];
  for (const p of [stella, mama]) p.on("console", (m) => m.type() === "error" && /Content Security Policy/.test(m.text()) && csp.push(m.text()));

  // --- Stella onboards with a passkey and gets test Dollars
  await stella.goto("/");
  await stella.getByLabel("Your first name").fill("Stella");
  await stella.getByRole("button", { name: "Create my account with fingerprint or screen lock" }).click();
  await expect(stella.getByText("Hi Stella, your Dollars")).toBeVisible();
  await stella.getByRole("button", { name: "Get 100 test Dollars" }).click();
  await expect(stella.locator(".balance")).toHaveText("$100.00");

  // --- Send $25 by link to Mama's phone
  await stella.getByRole("link", { name: "Send money" }).click();
  await stella.getByLabel("Amount in Dollars").fill("25");
  await stella.getByRole("button", { name: "Continue" }).click();
  await stella.getByLabel("Their phone number (with country code)").fill("+2348000000000");
  await stella.getByRole("button", { name: "Continue" }).click();
  await expect(stella.getByText("Everpiece fee")).toBeVisible();
  await stella.getByRole("button", { name: "Confirm with fingerprint or screen lock" }).click();
  await expect(stella.getByText("Payment protected ✓")).toBeVisible();
  const wa = await stella.getByRole("link", { name: "Send on WhatsApp" }).getAttribute("href");
  expect(wa).toMatch(/^https:\/\/wa\.me\/2348000000000\?text=/);
  const link = new RegExp(`(${escapeRe(BASE)}/c/0x[0-9a-f]{64}#[A-Za-z0-9_-]+)`).exec(decodeURIComponent(wa!.split("?text=")[1]))![1];

  // --- Mama opens the link: fragment is removed from the address bar immediately
  await mama.goto(link);
  await expect(mama.getByText("$25.00")).toBeVisible();
  expect(mama.url()).not.toContain("#");
  await mama.getByLabel("Your first name").fill("Mama");
  await mama.getByRole("button", { name: "Create my account with fingerprint or screen lock" }).click();
  await mama.getByRole("button", { name: "Send me the code" }).click();
  await expect(mama.getByText(/We texted a 6-digit code to \+234 ••• ••• 0000/)).toBeVisible();

  // wrong code first — refused, payment untouched
  await mama.getByLabel("Code").fill("000000" === (await latestSimulatedCode(mama)) ? "111111" : "000000");
  await mama.getByRole("button", { name: "Claim $25.00" }).click();
  await expect(mama.getByText(/That code isn't right/)).toBeVisible();

  await mama.getByLabel("Code").fill(await latestSimulatedCode(mama));
  await mama.getByRole("button", { name: "Claim $25.00" }).click();
  await expect(mama.getByText("You received $25.00 ✓")).toBeVisible();
  await mama.getByRole("link", { name: "Go to my Everpiece" }).click();
  await expect(mama.locator(".balance")).toHaveText("$25.00");

  // --- Stella sees it claimed, then sends $10 and cancels it
  await stella.getByRole("link", { name: "Done" }).click();
  await expect(stella.locator(".balance")).toHaveText("$75.00");
  await expect(stella.getByText("Claimed")).toBeVisible();
  await stella.getByRole("link", { name: "Send money" }).click();
  await stella.getByLabel("Amount in Dollars").fill("10");
  await stella.getByRole("button", { name: "Continue" }).click();
  await stella.getByLabel("Their phone number (with country code)").fill("+447700900123");
  await stella.getByRole("button", { name: "Continue" }).click();
  await stella.getByRole("button", { name: "Confirm with fingerprint or screen lock" }).click();
  await expect(stella.getByText("Payment protected ✓")).toBeVisible();
  await stella.getByRole("link", { name: "Done" }).click();
  await expect(stella.locator(".balance")).toHaveText("$65.00");
  await stella.getByRole("button", { name: "Cancel and get my money back" }).click();
  await expect(stella.getByText("Money returned: $10.00.")).toBeVisible();
  await expect(stella.locator(".balance")).toHaveText("$75.00");

  // --- the claimed link is dead; a link without its fragment is refused
  await mama.goto(link);
  await expect(mama.getByText("This payment can't be claimed")).toBeVisible();
  await mama.goto(link.split("#")[0]);
  await expect(mama.getByText("This link is incomplete")).toBeVisible();

  expect(csp).toEqual([]);
});
